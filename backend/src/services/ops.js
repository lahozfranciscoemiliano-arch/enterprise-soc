// Operaciones del NOC: PIN personal de 6 digitos, acciones de remediacion
// con un clic (siempre aprobadas por una persona con su PIN, NUNCA
// automaticas), base de conocimiento y prueba de velocidad programada.
const bcrypt = require('bcryptjs');
const prisma = require('../prismaClient');
const { getSetting } = require('./settings');
const { createAndDispatchEvent, autoResolveEvents } = require('./eventPipeline');
const { broadcast } = require('../websocket/socketServer');

// --- PIN ------------------------------------------------------------------------
const PIN_MAX_FAILS = 5;
const PIN_LOCK_MS = 15 * 60000;
const WEAK_PINS = new Set(['000000', '111111', '222222', '333333', '444444', '555555', '666666', '777777', '888888', '999999', '123456', '654321', '012345', '123123', '121212', '112233']);

function pinIsWeak(pin) {
  return WEAK_PINS.has(pin);
}

async function setPin(userId, pin) {
  const pinHash = await bcrypt.hash(pin, 12);
  await prisma.user.update({ where: { id: userId }, data: { pinHash, pinFailedCount: 0, pinLockedUntil: null } });
}

// Devuelve { ok, user } o { ok: false, status, error }.
async function verifyPin(userId, pin) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return { ok: false, status: 401, error: 'Usuario inválido' };
  if (!user.pinHash) return { ok: false, status: 403, error: 'Primero configurá tu PIN de 6 dígitos (menú de tu cuenta → PIN de aprobación)' };
  if (user.pinLockedUntil && user.pinLockedUntil > new Date()) {
    const mins = Math.ceil((user.pinLockedUntil - Date.now()) / 60000);
    return { ok: false, status: 423, error: `PIN bloqueado por intentos fallidos. Probá de nuevo en ${mins} min.` };
  }
  if (!/^\d{6}$/.test(String(pin ?? '')) || !(await bcrypt.compare(String(pin), user.pinHash))) {
    const fails = user.pinFailedCount + 1;
    await prisma.user.update({
      where: { id: userId },
      data: { pinFailedCount: fails >= PIN_MAX_FAILS ? 0 : fails, pinLockedUntil: fails >= PIN_MAX_FAILS ? new Date(Date.now() + PIN_LOCK_MS) : null },
    });
    return { ok: false, status: 401, error: fails >= PIN_MAX_FAILS ? 'PIN incorrecto: bloqueado por 15 minutos' : `PIN incorrecto (${PIN_MAX_FAILS - fails} intento(s) restantes)` };
  }
  if (user.pinFailedCount > 0) await prisma.user.update({ where: { id: userId }, data: { pinFailedCount: 0 } });
  return { ok: true, user };
}

// --- Remediacion ------------------------------------------------------------------
// Lista blanca: lo mismo que acepta el agente (run_remediation).
const ACTIONS = {
  restart_service: { label: 'Reiniciar servicio', risk: 'medio', param: 'name', help: 'Detiene y vuelve a iniciar el servicio de Windows.' },
  start_service: { label: 'Iniciar servicio', risk: 'bajo', param: 'name', help: 'Inicia un servicio detenido.' },
  clear_print_queue: { label: 'Vaciar cola de impresión', risk: 'medio', help: 'Detiene el Spooler, borra los trabajos trabados y lo vuelve a iniciar.' },
  flush_dns: { label: 'Limpiar caché DNS', risk: 'bajo', help: 'ipconfig /flushdns: resuelve nombres viejos o cambiados.' },
  gpupdate: { label: 'Aplicar directivas (gpupdate)', risk: 'bajo', help: 'gpupdate /force: vuelve a aplicar las GPO del dominio.' },
  cleanup_temp: { label: 'Liberar espacio (temporales)', risk: 'bajo', help: 'Borra archivos temporales de más de 7 días (Windows\\Temp y Temp de cada usuario).' },
  windows_update_scan: { label: 'Buscar actualizaciones', risk: 'bajo', help: 'Fuerza la búsqueda de parches pendientes en Windows Update.' },
  unlock_ad_user: { label: 'Desbloquear cuenta del AD', risk: 'medio', param: 'sam', help: 'Unlock-ADAccount (solo en el controlador de dominio).' },
  restart_agent: { label: 'Reiniciar el agente del NOC', risk: 'bajo', help: 'Cierra el agente; la tarea programada lo vuelve a abrir en menos de un minuto.' },
  reboot_server: { label: 'Reiniciar el servidor', risk: 'alto', help: 'shutdown /r con 2 minutos de aviso a los usuarios conectados.' },
};
const SERVICE_RE = /^[A-Za-z0-9_.\-$ ]{1,80}$/;
const SAM_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const ACTION_TTL_MS = 30 * 60000;

function validateParams(action, params = {}) {
  const def = ACTIONS[action];
  if (!def) return 'Acción no permitida';
  if (def.param === 'name' && !SERVICE_RE.test(String(params.name ?? ''))) return 'Nombre de servicio inválido';
  if (def.param === 'sam' && !SAM_RE.test(String(params.sam ?? ''))) return 'Usuario inválido';
  return null;
}

// Acciones sugeridas para una alerta (o para un servidor sin alerta).
async function remediationOptions({ event, server }) {
  const out = [];
  const add = (action, params = {}, why = null) => out.push({ action, params, why, ...ACTIONS[action] });
  const md = event?.metadata ?? {};
  switch (event?.type) {
    case 'SERVICE_DOWN':
      if (md.service) {
        add('start_service', { name: md.service }, `El servicio ${md.service} está detenido.`);
        add('restart_service', { name: md.service });
      }
      break;
    case 'APP_SERVICE_DOWN': {
      const inst = await prisma.appInstance.findFirst({ where: { serverId: event.serverId, appKey: md.app ?? 'MONARK' } });
      const svcs = (inst?.detected?.services ?? []).map((x) => (typeof x === 'string' ? x : x?.name)).filter(Boolean);
      for (const name of svcs.slice(0, 5)) add('restart_service', { name }, `Servicio de ${inst?.label ?? 'la aplicación'}.`);
      break;
    }
    case 'DISK_THRESHOLD':
    case 'DISK_FORECAST':
      add('cleanup_temp', {}, 'Libera espacio sin tocar datos del negocio.');
      break;
    case 'PRINTER_ISSUE':
      add('clear_print_queue', {}, 'Si la impresora tiene trabajos trabados en el servidor de impresión.');
      break;
    case 'AD_ACCOUNT_LOCKOUT':
      if (md.user && SAM_RE.test(md.user)) add('unlock_ad_user', { sam: md.user }, 'Solo si se confirmó con el usuario (y se revisó de dónde venían los intentos).');
      break;
    case 'PATCHES_OUTDATED':
      add('windows_update_scan', {}, 'Actualiza la lista de parches pendientes.');
      break;
    case 'REBOOT_PENDING':
      add('reboot_server', {}, 'Termina de aplicar actualizaciones. Hacerlo fuera del horario de atención.');
      break;
    case 'NETWORK_DEGRADED':
    case 'NETWORK_UNREACHABLE':
    case 'NETWORK_MICROCUTS':
      add('flush_dns', {}, 'Si hay problemas de resolución de nombres.');
      break;
    default:
      break;
  }
  // Siempre disponibles para el servidor.
  const base = ['flush_dns', 'gpupdate', 'cleanup_temp', 'windows_update_scan', 'restart_agent', 'reboot_server'];
  for (const a of base) if (!out.some((o) => o.action === a)) out.push({ action: a, params: {}, why: null, generic: true, ...ACTIONS[a] });
  out.push({ action: 'restart_service', params: {}, why: null, generic: true, custom: true, ...ACTIONS.restart_service });
  return { server: server ? { id: server.id, name: server.name, online: server.status !== 'OFFLINE', agentVersion: server.agentVersion } : null, options: out };
}

async function queueAction({ server, action, params, eventId, ticketId, user }) {
  const row = await prisma.remediationAction.create({
    data: {
      serverId: server.id,
      serverName: server.name,
      eventId: eventId ?? null,
      ticketId: ticketId ?? null,
      action,
      params: params ?? {},
      requestedById: user.id,
      requestedByName: user.name,
    },
  });
  broadcast({ type: 'REMEDIATION_UPDATE', action: row });
  return row;
}

// El agente pide sus tareas: acciones pendientes (se marcan SENT) y si le toca
// la prueba de velocidad.
async function agentTasks(server) {
  const now = new Date();
  await prisma.remediationAction.updateMany({
    where: { status: 'PENDING', createdAt: { lt: new Date(now - ACTION_TTL_MS) } },
    data: { status: 'EXPIRED', finishedAt: now, output: 'El agente no la tomó a tiempo (¿servidor apagado o agente viejo?)' },
  });
  const pending = await prisma.remediationAction.findMany({ where: { serverId: server.id, status: 'PENDING' }, orderBy: { createdAt: 'asc' }, take: 5 });
  if (pending.length) {
    await prisma.remediationAction.updateMany({ where: { id: { in: pending.map((p) => p.id) } }, data: { status: 'SENT', sentAt: now } });
    for (const p of pending) broadcast({ type: 'REMEDIATION_UPDATE', action: { ...p, status: 'SENT', sentAt: now } });
  }
  return {
    actions: pending.map((p) => ({ id: p.id, action: p.action, params: p.params ?? {}, approvedBy: p.requestedByName })),
    speedtest: await speedtestDue(server),
    intervalSeconds: 30,
  };
}

async function actionResult(server, id, { ok, output }) {
  const row = await prisma.remediationAction.findFirst({ where: { id, serverId: server.id } });
  if (!row) return null;
  const updated = await prisma.remediationAction.update({
    where: { id },
    data: { status: ok ? 'SUCCESS' : 'FAILED', output: String(output ?? '').slice(0, 4000), finishedAt: new Date() },
  });
  broadcast({ type: 'REMEDIATION_UPDATE', action: updated });
  if (row.ticketId) {
    await prisma.ticketComment.create({
      data: {
        ticketId: row.ticketId,
        userName: 'Sistema',
        kind: 'action',
        body: `Acción "${ACTIONS[row.action]?.label ?? row.action}" en ${row.serverName}: ${ok ? 'OK' : 'FALLÓ'}. ${String(output ?? '').slice(0, 500)}`,
      },
    });
  }
  return updated;
}

// --- Base de conocimiento -----------------------------------------------------------
const STOP = new Set(['de', 'la', 'el', 'en', 'y', 'a', 'los', 'las', 'del', 'un', 'una', 'que', 'con', 'por', 'para', 'se', 'es', 'al', 'no', 'o', 'lo', 'su', 'sin']);
function tokens(text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/\b\d+([.,]\d+)?\b/g, ' ')
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length > 2 && !STOP.has(t))
  );
}

// Articulos parecidos a una alerta: mismo tipo pesa mucho, despues palabras
// en comun con el problema/titulo.
async function suggestArticles({ type, text, limit = 5 }) {
  const articles = await prisma.knowledgeArticle.findMany({ orderBy: { uses: 'desc' }, take: 500 });
  const q = tokens(text);
  const scored = articles
    .map((a) => {
      const t = tokens(`${a.title} ${a.problem} ${a.tags.join(' ')}`);
      let common = 0;
      for (const w of q) if (t.has(w)) common += 1;
      const sim = q.size ? common / Math.sqrt(q.size * Math.max(t.size, 1)) : 0;
      const score = (type && a.alertType === type ? 0.6 : 0) + sim;
      return { ...a, score: Math.round(score * 100) / 100 };
    })
    .filter((a) => a.score >= 0.25)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// --- Prueba de velocidad programada -------------------------------------------------
const TZ = process.env.SITE_TZ || 'America/Argentina/Buenos_Aires';
const manualSpeedtests = new Set();
const manualInFlight = new Set();

function localParts(date = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false });
  const parts = Object.fromEntries(f.formatToParts(date).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
}

// Un agente por sede: la sede se identifica por la IP publica de salida. Se
// elige el servidor de nombre menor (estable) entre los ONLINE de esa IP.
async function speedtestDue(server) {
  if (manualSpeedtests.has(server.id)) {
    manualSpeedtests.delete(server.id);
    manualInFlight.add(server.id);
    return true;
  }
  if ((await getSetting('SPEEDTEST_ENABLED')) === false) return false;
  if (!server.publicIp || (server.tags ?? []).includes('infra-vps')) return false;
  const hour = Number((await getSetting('SPEEDTEST_HOUR')) ?? 4);
  const now = localParts();
  if (now.hour < hour) return false;
  const peers = await prisma.server.findMany({ where: { publicIp: server.publicIp, status: { not: 'OFFLINE' } }, select: { id: true, name: true, tags: true }, orderBy: { name: 'asc' } });
  const chosen = peers.find((p) => !(p.tags ?? []).includes('infra-vps'));
  if (!chosen || chosen.id !== server.id) return false;
  const last = await prisma.speedTest.findFirst({ where: { publicIp: server.publicIp, manual: false }, orderBy: { at: 'desc' } });
  return !last || localParts(last.at).day !== now.day;
}

function requestManualSpeedtest(serverId) {
  manualSpeedtests.add(serverId);
}

async function storeSpeedtest(server, result) {
  const manual = manualInFlight.delete(server.id);
  // Una bajada o subida de 0 Mbps no es una medicion: el respaldo de
  // Cloudflare del agente <= 1.16.0 pedia bloques de 200 MB, Cloudflare
  // respondia 403 y la bajada salia siempre 0. Se guarda como prueba fallida
  // (no se grafica ni alerta "velocidad baja").
  const noData = result.ok !== false && (!(result.downloadMbps > 0) || !(result.uploadMbps > 0));
  const row = await prisma.speedTest.create({
    data: {
      serverId: server.id,
      serverName: server.name,
      publicIp: result.publicIp ?? server.publicIp ?? null,
      ok: result.ok !== false && !noData,
      error: noData
        ? `La prueba no pudo medir la ${!(result.downloadMbps > 0) ? 'bajada' : 'subida'} (${result.provider ?? 'speedtest'}): resultado descartado.`
        : (result.error ?? null),
      downloadMbps: result.downloadMbps ?? null,
      uploadMbps: result.uploadMbps ?? null,
      latencyMs: result.latencyMs ?? null,
      jitterMs: result.jitterMs ?? null,
      packetLoss: result.packetLoss ?? null,
      provider: result.provider ?? null,
      isp: result.isp ?? null,
      testServer: result.testServer ?? null,
      resultUrl: result.resultUrl && /^https:\/\/www\.speedtest\.net\//.test(result.resultUrl) ? result.resultUrl : null,
      contractedDownMbps: server.contractedDownMbps ?? null,
      contractedUpMbps: server.contractedUpMbps ?? null,
      manual,
    },
  });
  broadcast({ type: 'SPEEDTEST_UPDATE', test: row });
  if (!row.ok || !server.contractedDownMbps) return row;
  const pct = Number((await getSetting('SPEEDTEST_THRESHOLD_PCT')) ?? 60);
  const downPct = Math.round((row.downloadMbps / server.contractedDownMbps) * 100);
  const upPct = server.contractedUpMbps ? Math.round((row.uploadMbps / server.contractedUpMbps) * 100) : null;
  const key = 'SPEEDTEST_LOW';
  if (downPct < pct || (upPct !== null && upPct < pct)) {
    await createAndDispatchEvent({
      serverId: server.id,
      serverName: server.name,
      type: 'SPEEDTEST_LOW',
      severity: downPct < pct / 2 ? 'HIGH' : 'MEDIUM',
      description:
        `${server.name}: la prueba de velocidad dio ${row.downloadMbps} Mbps de bajada (${downPct}% de ${server.contractedDownMbps} contratados)` +
        `${upPct !== null ? ` y ${row.uploadMbps} Mbps de subida (${upPct}% de ${server.contractedUpMbps})` : ''}, latencia ${row.latencyMs ?? '—'} ms. ` +
        'Queda registrada como evidencia para el reclamo al proveedor (Red → Velocidad de internet).',
      metadata: { testId: row.id, downPct, upPct, downloadMbps: row.downloadMbps, uploadMbps: row.uploadMbps },
      dedupKey: key,
      silent: true,
    });
  } else {
    await autoResolveEvents(server.id, [key], server.name);
  }
  return row;
}

module.exports = {
  ACTIONS,
  pinIsWeak,
  setPin,
  verifyPin,
  validateParams,
  remediationOptions,
  queueAction,
  agentTasks,
  actionResult,
  suggestArticles,
  requestManualSpeedtest,
  storeSpeedtest,
};
