// Monitoreo preventivo: reglas sobre el diagnostico extendido y el estado de
// red que manda el agente >= 1.3.0 (metadata.diagnostics cada ~5 min,
// metadata.network en cada telemetria). La idea es avisar ANTES de la
// caida: un disco fisico degradado, un servicio de SQL detenido, un sitio
// que salio a internet por el enlace de respaldo, parches atrasados...
//
// Cada regla genera una alerta con dedupKey propia via eventPipeline (no se
// repite mientras siga activa) y se auto-resuelve cuando la condicion
// desaparece del siguiente diagnostico.
const prisma = require('../prismaClient');
const { getSettings } = require('./settings');
const { isInMaintenance, resolveThresholds } = require('./alertEngine');
const { createAndDispatchEvent, autoResolveEvents, resolveCleared } = require('./eventPipeline');
const { broadcast } = require('../websocket/socketServer');

const DEFAULT_CRITICAL_SERVICES = [
  'MSSQLSERVER',
  'MSSQL$*',
  'SQLSERVERAGENT',
  'SQLAgent$*',
  'SQLBrowser',
  'W3SVC',
  'VSS',
  'EventLog',
  'LanmanServer',
  'TermService',
  'Dnscache',
  'WinDefend',
];
const DEFAULT_PATCH_MAX_AGE_DAYS = 45;
// Zona horaria de los textos de alerta (ej. America/Asuncion). Sin definir,
// se usa la del contenedor.
const APP_TIMEZONE = process.env.APP_TIMEZONE || undefined;

// Umbrales de red (medidos por el agente desde adentro del sitio).
const NET_LOSS_MEDIUM = 10; // % de paquetes perdidos a internet
const NET_LOSS_HIGH = 40;
const NET_LATENCY_MEDIUM = 250; // ms promedio a 1.1.1.1 / 8.8.8.8
const FAILED_LOGONS_HIGH = 50; // por dia
const OUTAGE_MIN_SECONDS = 60; // cortes mas cortos se ignoran (un ping perdido)
const DISK_BAD_BLOCKS_MIN = 3; // un sector reasignado aislado no es noticia
const DISK_BAD_BLOCKS_HIGH = 25;

function serviceMatches(name, patterns) {
  const lower = name.toLowerCase();
  return patterns.some((p) => {
    const pat = p.toLowerCase();
    return pat.endsWith('*') ? lower.startsWith(pat.slice(0, -1)) : lower === pat;
  });
}

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

// Por cual enlace esta saliendo el sitio, comparando la IP publica que ve el
// agente contra las cargadas en el CMDB (Admin -> Servidores -> Configurar).
function activeIsp(server, publicIp) {
  if (!publicIp) return 'unknown';
  if (server.ispPrimaryPublicIp && publicIp === server.ispPrimaryPublicIp) return 'primary';
  if (server.ispSecondaryPublicIp && publicIp === server.ispSecondaryPublicIp) return 'secondary';
  return server.ispPrimaryPublicIp || server.ispSecondaryPublicIp ? 'other' : 'unknown';
}

// ---------------------------------------------------------------------------
// Diagnostico (cada ~5 min)
// ---------------------------------------------------------------------------
function evaluateDiagnostics(server, diag, cfg) {
  const alerts = [];
  const managed = [];
  const thresholds = resolveThresholds(server).diskUsage;

  // Volumenes distintos de C: (C: ya lo cubre el umbral de diskUsage de la
  // telemetria). Mismos umbrales de disco del servidor.
  for (const vol of diag.volumes ?? []) {
    const mount = String(vol.mount || '').toUpperCase();
    if (!mount || mount === 'C:' || mount === '/') continue;
    const key = `DISK_THRESHOLD:vol:${mount}`;
    managed.push(key);
    if (vol.percent >= thresholds.medium) {
      alerts.push({
        type: 'DISK_THRESHOLD',
        severity: vol.percent >= thresholds.high ? 'CRITICAL' : 'HIGH',
        description: `${server.name}: unidad ${mount} al ${vol.percent.toFixed(1)}% (umbral ${thresholds.medium}%).`,
        metadata: { volume: mount, value: vol.percent, freeBytes: vol.freeBytes },
        dedupKey: key,
      });
    }
  }

  // Salud fisica de discos.
  managed.push('DISK_FAILURE_PREDICTED:physical');
  const badDisks = (diag.physicalDisks ?? []).filter((d) => d.predictFailure || ['Warning', 'Unhealthy'].includes(d.health));
  if (badDisks.length > 0) {
    const critical = badDisks.some((d) => d.predictFailure || d.health === 'Unhealthy');
    alerts.push({
      type: 'DISK_FAILURE_PREDICTED',
      severity: critical ? 'CRITICAL' : 'HIGH',
      description: `${server.name}: disco físico degradado — ${badDisks
        .map((d) => `${d.name} (${d.predictFailure ? 'SMART predice falla' : d.health})`)
        .join(', ')}. Reemplazar antes de perder datos.`,
      metadata: { disks: badDisks },
      dedupKey: 'DISK_FAILURE_PREDICTED:physical',
    });
  }

  const signals = diag.eventSignals ?? {};
  // Visor de Eventos: solo sectores defectuosos reales / falla predicha /
  // NTFS corrupto en discos FIJOS (agente >= 1.6.0 manda diskBadBlocks y ya
  // descarta los USB de backup). Los reintentos y timeouts de E/S
  // (diskErrors) daban falsos positivos en casi todos los servidores --
  // discos externos que se desconectan, lectores de tarjetas, discos que se
  // duermen -- y quedan solo como dato informativo. La falla real del disco
  // la cubre ademas el SMART de arriba.
  managed.push('DISK_FAILURE_PREDICTED:eventlog');
  const badBlocks = Number(signals.diskBadBlocks ?? 0);
  if (badBlocks >= DISK_BAD_BLOCKS_MIN) {
    alerts.push({
      type: 'DISK_FAILURE_PREDICTED',
      severity: badBlocks >= DISK_BAD_BLOCKS_HIGH ? 'HIGH' : 'MEDIUM',
      description: `${server.name}: ${badBlocks} sector(es) defectuoso(s) / error(es) de NTFS en un disco interno en las últimas 24 hs. Revisar SMART y programar chkdsk; si sigue creciendo, reemplazar el disco.`,
      metadata: { diskBadBlocks: badBlocks },
      dedupKey: 'DISK_FAILURE_PREDICTED:eventlog',
      // Tiene que verse en 2 diagnosticos seguidos (~10 min).
      confirmations: 2,
    });
  }

  managed.push('CUSTOM:unexpected-shutdown');
  if (signals.unexpectedShutdowns > 0 || signals.bugchecks > 0) {
    alerts.push({
      type: 'CUSTOM',
      severity: 'HIGH',
      description: `${server.name}: ${signals.unexpectedShutdowns ?? 0} apagado(s) inesperado(s) y ${signals.bugchecks ?? 0} pantallazo(s) azul(es) en las últimas 24 hs. Revisar UPS/energía, drivers y memoria.`,
      metadata: { unexpectedShutdowns: signals.unexpectedShutdowns, bugchecks: signals.bugchecks },
      dedupKey: 'CUSTOM:unexpected-shutdown',
    });
  }

  managed.push('CUSTOM:low-memory');
  if (signals.lowMemory > 0) {
    alerts.push({
      type: 'MEMORY_THRESHOLD',
      severity: 'HIGH',
      description: `${server.name}: Windows registró ${signals.lowMemory} evento(s) de memoria virtual agotada en 24 hs. Un proceso puede estar perdiendo memoria.`,
      metadata: { lowMemory: signals.lowMemory },
      dedupKey: 'CUSTOM:low-memory',
    });
  }

  managed.push('LOGIN_FAILURE:bruteforce');
  if (signals.failedLogons >= FAILED_LOGONS_HIGH) {
    alerts.push({
      type: 'LOGIN_FAILURE',
      severity: signals.failedLogons >= FAILED_LOGONS_HIGH * 10 ? 'CRITICAL' : 'HIGH',
      description: `${server.name}: ${signals.failedLogons} inicios de sesión fallidos en 24 hs — posible fuerza bruta (RDP) o una credencial vieja guardada en algún servicio.`,
      metadata: { failedLogons: signals.failedLogons },
      dedupKey: 'LOGIN_FAILURE:bruteforce',
    });
  }

  managed.push('MALWARE_DETECTED:defender');
  if (signals.malwareDetections > 0) {
    alerts.push({
      type: 'MALWARE_DETECTED',
      severity: 'CRITICAL',
      description: `${server.name}: Microsoft Defender detectó malware ${signals.malwareDetections} vez/veces en las últimas 24 hs.`,
      metadata: { malwareDetections: signals.malwareDetections },
      dedupKey: 'MALWARE_DETECTED:defender',
    });
  }

  managed.push('CUSTOM:defender');
  const defender = diag.defender;
  if (defender && (!defender.antivirusEnabled || !defender.realTimeEnabled || defender.signatureAgeDays > 7)) {
    const problems = [
      !defender.antivirusEnabled && 'antivirus deshabilitado',
      defender.antivirusEnabled && !defender.realTimeEnabled && 'protección en tiempo real apagada',
      defender.signatureAgeDays > 7 && `firmas con ${defender.signatureAgeDays} días de antigüedad`,
    ].filter(Boolean);
    alerts.push({
      type: 'CUSTOM',
      severity: defender.antivirusEnabled ? 'MEDIUM' : 'HIGH',
      description: `${server.name}: Microsoft Defender — ${problems.join(', ')}.`,
      metadata: { defender },
      dedupKey: 'CUSTOM:defender',
    });
  }

  // Servicios criticos detenidos.
  const patterns = (cfg.CRITICAL_SERVICES ? cfg.CRITICAL_SERVICES.split(',') : DEFAULT_CRITICAL_SERVICES)
    .map((p) => p.trim())
    .filter(Boolean);
  const stoppedCritical = (diag.stoppedServices ?? []).filter((svc) => serviceMatches(svc.name, patterns));
  const stoppedKeys = new Set();
  for (const svc of stoppedCritical) {
    const key = `SERVICE_DOWN:${svc.name.toLowerCase()}`;
    stoppedKeys.add(key);
    alerts.push({
      type: 'SERVICE_DOWN',
      severity: /sql/i.test(svc.name) ? 'CRITICAL' : 'HIGH',
      description: `${server.name}: el servicio "${svc.displayName}" (${svc.name}) está detenido y es de inicio automático.`,
      metadata: { service: svc.name },
      dedupKey: key,
    });
  }

  managed.push('REBOOT_PENDING');
  if (diag.rebootPending) {
    alerts.push({
      type: 'REBOOT_PENDING',
      severity: 'LOW',
      description: `${server.name}: reinicio pendiente para terminar de aplicar actualizaciones. Programarlo en una ventana de mantenimiento.`,
      metadata: {},
      dedupKey: 'REBOOT_PENDING',
    });
  }

  managed.push('PATCHES_OUTDATED');
  const maxAge = cfg.PATCH_MAX_AGE_DAYS ?? DEFAULT_PATCH_MAX_AGE_DAYS;
  const lastInstalled = diag.updates?.lastInstalledAt ? new Date(diag.updates.lastInstalledAt) : null;
  const patchAgeDays = lastInstalled ? Math.floor((Date.now() - lastInstalled.getTime()) / 86400000) : null;
  if ((patchAgeDays !== null && patchAgeDays > maxAge) || diag.updates?.pendingCritical > 0) {
    alerts.push({
      type: 'PATCHES_OUTDATED',
      severity: 'MEDIUM',
      description: `${server.name}: ${
        patchAgeDays !== null && patchAgeDays > maxAge ? `última actualización de Windows instalada hace ${patchAgeDays} días` : 'actualizaciones pendientes'
      }${diag.updates?.pendingCritical ? ` · ${diag.updates.pendingCritical} crítica(s)/importante(s) sin instalar` : ''}.`,
      metadata: { patchAgeDays, pending: diag.updates?.pending, pendingCritical: diag.updates?.pendingCritical },
      dedupKey: 'PATCHES_OUTDATED',
    });
  }

  return { alerts, managed, stoppedKeys };
}

// ---------------------------------------------------------------------------
// Red (cada telemetria)
// ---------------------------------------------------------------------------
function evaluateNetwork(server, net) {
  const alerts = [];
  const managed = ['NETWORK_DEGRADED', 'ISP_FAILOVER'];

  const loss = net.internetLossPct;
  const latency = net.internetLatencyMs;
  if (net.internetUp && ((loss !== null && loss >= NET_LOSS_MEDIUM) || (latency !== null && latency >= NET_LATENCY_MEDIUM))) {
    alerts.push({
      type: 'NETWORK_DEGRADED',
      severity: loss >= NET_LOSS_HIGH ? 'HIGH' : 'MEDIUM',
      description: `${server.name}: internet degradado — ${loss ?? 0}% de pérdida, ${latency ?? '—'} ms de latencia promedio.`,
      metadata: { lossPct: loss, latencyMs: latency },
      dedupKey: 'NETWORK_DEGRADED',
    });
  }

  if (activeIsp(server, net.publicIp) === 'secondary') {
    alerts.push({
      type: 'ISP_FAILOVER',
      severity: 'HIGH',
      description: `${server.name}: el sitio está saliendo a internet por el enlace SECUNDARIO (${server.ispSecondaryName || net.publicIp}). El enlace principal${
        server.ispPrimaryName ? ` (${server.ispPrimaryName})` : ''
      } está caído o degradado${server.ispPrimaryContact ? ` — contacto: ${server.ispPrimaryContact}` : ''}.`,
      metadata: { publicIp: net.publicIp },
      dedupKey: 'ISP_FAILOVER',
    });
  }

  return { alerts, managed };
}

// Cortes que el agente registro mientras no podia avisar: se crean como
// alertas YA RESUELTAS (con su duracion), para que queden en el historial y
// se notifiquen, sin quedar "abiertas" porque el sitio ya volvio.
async function recordOutages(server, outages) {
  for (const outage of outages) {
    if (!outage?.startedAt || !outage?.endedAt || outage.durationSeconds < OUTAGE_MIN_SECONDS) continue;
    const startedAt = new Date(outage.startedAt);
    // Idempotente: si el agente reenvia el mismo corte (respuesta perdida),
    // no se duplica.
    // eslint-disable-next-line no-await-in-loop
    const exists = await prisma.securityEvent.findFirst({
      where: { serverId: server.id, type: 'INTERNET_OUTAGE', dedupKey: `INTERNET_OUTAGE:${startedAt.toISOString()}` },
    });
    if (exists) continue;

    // eslint-disable-next-line no-await-in-loop
    const { event } = await createAndDispatchEvent({
      serverId: server.id,
      serverName: server.name,
      type: 'INTERNET_OUTAGE',
      severity: outage.durationSeconds >= 15 * 60 ? 'HIGH' : 'MEDIUM',
      description: `${server.name}: el sitio estuvo SIN INTERNET ${formatDuration(outage.durationSeconds)} (${startedAt.toLocaleString('es', {
        timeZone: APP_TIMEZONE,
      })} → ${new Date(outage.endedAt).toLocaleTimeString('es', { timeZone: APP_TIMEZONE })}). Ya se restableció.`,
      metadata: outage,
      dedupKey: `INTERNET_OUTAGE:${startedAt.toISOString()}`,
    });
    // eslint-disable-next-line no-await-in-loop
    await autoResolveEvents(server.id, [event.dedupKey], server.name);
  }
}

// Punto de entrada desde POST /api/telemetry.
async function processAgentExtras(server, metadata) {
  const network = metadata?.network;
  const diagnostics = metadata?.diagnostics;
  if (!network && !diagnostics) return;

  const now = new Date();
  await prisma.server.update({
    where: { id: server.id },
    data: {
      ...(network ? { network, networkAt: now, publicIp: network.publicIp ?? undefined } : {}),
      ...(diagnostics ? { diagnostics, diagnosticsAt: now } : {}),
    },
  });

  if (network) {
    broadcast({
      type: 'SERVER_NETWORK',
      serverId: server.id,
      network: summarizeNetwork(server, network, now),
    });
  }

  if (isInMaintenance(server)) return;

  if (network) {
    const { alerts, managed } = evaluateNetwork(server, network);
    // Anti-fatiga: la red degradada se confirma en 3 mediciones seguidas y el
    // failover en 2 (un cambio de IP publica momentaneo no es un failover).
    await Promise.all(
      alerts.map((a) =>
        createAndDispatchEvent({ serverId: server.id, serverName: server.name, ...a, confirmations: a.type === 'ISP_FAILOVER' ? 2 : 3 })
      )
    );
    await resolveCleared(server.id, managed, alerts.map((a) => a.dedupKey), server.name);
    if (Array.isArray(network.outages) && network.outages.length > 0) await recordOutages(server, network.outages);
  }

  if (diagnostics) {
    const cfg = await getSettings(['CRITICAL_SERVICES', 'PATCH_MAX_AGE_DAYS']);
    const { alerts, managed } = evaluateDiagnostics(server, diagnostics, cfg);
    await Promise.all(alerts.map((a) => createAndDispatchEvent({ serverId: server.id, serverName: server.name, ...a })));

    // Servicios: los SERVICE_DOWN abiertos cuyo servicio ya no figura
    // detenido se resuelven (la lista de claves posibles no es fija).
    const openServiceAlerts = await prisma.securityEvent.findMany({
      where: { serverId: server.id, type: 'SERVICE_DOWN', status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
      select: { dedupKey: true },
    });
    const serviceKeys = openServiceAlerts.map((e) => e.dedupKey).filter(Boolean);
    // Idem volumenes que desaparecieron (disco USB desconectado).
    const openVolumeAlerts = await prisma.securityEvent.findMany({
      where: { serverId: server.id, dedupKey: { startsWith: 'DISK_THRESHOLD:vol:' }, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
      select: { dedupKey: true },
    });
    await resolveCleared(
      server.id,
      [...new Set([...managed, ...serviceKeys, ...openVolumeAlerts.map((e) => e.dedupKey)])],
      alerts.map((a) => a.dedupKey),
      server.name
    );
  }
}

// Resumen compacto del estado de red de un sitio (listado de servidores,
// pestaña Red, WebSocket).
function summarizeNetwork(server, network, networkAt) {
  if (!network) return null;
  return {
    internetUp: network.internetUp ?? null,
    latencyMs: network.internetLatencyMs ?? null,
    lossPct: network.internetLossPct ?? null,
    dnsOk: network.dnsOk ?? null,
    dnsMs: network.dnsMs ?? null,
    gateway: network.gateway ?? null,
    gatewayLatencyMs: network.gatewayProbe?.avgMs ?? null,
    gatewayLossPct: network.gatewayProbe?.lossPct ?? null,
    publicIp: network.publicIp ?? null,
    activeIsp: activeIsp(server, network.publicIp),
    nics: network.nics ?? [],
    at: networkAt ?? null,
  };
}

module.exports = {
  processAgentExtras,
  evaluateDiagnostics,
  evaluateNetwork,
  summarizeNetwork,
  activeIsp,
  serviceMatches,
  DEFAULT_CRITICAL_SERVICES,
};
