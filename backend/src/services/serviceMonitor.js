// Monitores de servicios: chequeos activos desde la VPS contra sistemas
// propios y de terceros (sistema de punto de venta en la nube, facturacion
// electronica, pagina web, VPN, correo...). HTTP(S) con codigo esperado y
// texto opcional, o TCP a host:puerto. En HTTPS tambien se controla el
// vencimiento del certificado SSL.
//
// Una caida se confirma con 2 fallos seguidos y se avisa UNA vez (y otra al
// volver) por los canales de notificacion.
const net = require('net');
const tls = require('tls');
const prisma = require('../prismaClient');
const { notifyGeneric } = require('./notifications');
const { broadcast } = require('../websocket/socketServer');

const TICK_MS = 15 * 1000;
const CONFIRM_FAILURES = 2;
const CERT_WARN_DAYS = [30, 14, 3];
const MAX_CONCURRENT = 10;

const running = new Set();
const certCheckedAt = new Map(); // checkId -> ms del ultimo control del certificado

function checkTcp(target, timeoutMs) {
  const [host, portStr] = String(target).split(':');
  const port = Number(portStr);
  return new Promise((resolve) => {
    if (!host || !port) {
      resolve({ up: false, error: 'Destino inválido (usar host:puerto)' });
      return;
    }
    const started = Date.now();
    const socket = net.connect({ host, port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done({ up: true, latencyMs: Date.now() - started }));
    socket.once('timeout', () => done({ up: false, error: `Sin respuesta en ${timeoutMs} ms` }));
    socket.once('error', (err) => done({ up: false, error: err.code || err.message }));
  });
}

function getCertExpiry(hostname, port = 443, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: hostname, port, servername: hostname, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      resolve(cert?.valid_to ? new Date(cert.valid_to) : null);
    });
    socket.once('error', () => resolve(null));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(null);
    });
  });
}

async function checkHttp(check) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), check.timeoutMs);
  try {
    const res = await fetch(check.target, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'EnterpriseSOC-Monitor/1.0' },
    });
    const latencyMs = Date.now() - started;
    const statusOk = check.expectedStatus ? res.status === check.expectedStatus : res.status < 400;
    if (!statusOk) return { up: false, latencyMs, error: `HTTP ${res.status}` };
    if (check.keyword) {
      const body = (await res.text()).slice(0, 2_000_000);
      if (!body.includes(check.keyword)) return { up: false, latencyMs, error: `No aparece el texto "${check.keyword}"` };
    }
    return { up: true, latencyMs };
  } catch (err) {
    return { up: false, error: err.name === 'AbortError' ? `Sin respuesta en ${check.timeoutMs} ms` : err.cause?.code || err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function runCheck(check) {
  const result = check.type === 'tcp' ? await checkTcp(check.target, check.timeoutMs) : await checkHttp(check);
  const now = new Date();

  const failures = result.up ? 0 : check.consecutiveFailures + 1;
  let status = check.status;
  if (result.up) status = 'up';
  else if (failures >= CONFIRM_FAILURES) status = 'down';
  const changed = status !== check.status && status !== 'unknown';

  const data = {
    status,
    lastLatencyMs: result.latencyMs ?? null,
    lastCheckedAt: now,
    lastError: result.up ? null : result.error ?? 'Error desconocido',
    consecutiveFailures: failures,
    ...(changed ? { lastChangeAt: now } : {}),
  };

  // Certificado SSL: una vez por hora alcanza.
  if (check.type === 'http' && check.target.startsWith('https://')) {
    const lastCertCheck = certCheckedAt.get(check.id) ?? 0;
    if (!check.certExpiresAt || now - lastCertCheck > 60 * 60 * 1000) {
      certCheckedAt.set(check.id, now.getTime());
      const url = new URL(check.target);
      const expires = await getCertExpiry(url.hostname, Number(url.port) || 443);
      if (expires) {
        data.certExpiresAt = expires;
        const daysLeft = Math.floor((expires - now) / 86400000);
        const level = CERT_WARN_DAYS.filter((d) => daysLeft <= d).pop() ?? null;
        if (level !== null && level !== check.certWarnedDays) {
          data.certWarnedDays = level;
          notifyGeneric({
            severity: daysLeft <= 3 ? 'CRITICAL' : 'HIGH',
            subject: `Certificado SSL de "${check.name}" vence en ${Math.max(daysLeft, 0)} día(s)`,
            text: `${check.target}: el certificado vence el ${expires.toLocaleDateString('es')}. Renovarlo antes evita que navegadores y sistemas rechacen la conexión.`,
            source: 'service-monitor',
            metadata: { checkId: check.id, certExpiresAt: expires },
          }).catch(() => {});
        } else if (level === null && check.certWarnedDays !== null) {
          data.certWarnedDays = null; // renovado
        }
      }
    }
  }

  await prisma.$transaction([
    prisma.serviceCheck.update({ where: { id: check.id }, data }),
    prisma.serviceCheckResult.create({ data: { checkId: check.id, at: now, up: result.up, latencyMs: result.latencyMs ?? null } }),
  ]);

  if (changed && (status === 'down' || check.status === 'down')) {
    const downMinutes = check.lastChangeAt ? Math.round((now - check.lastChangeAt) / 60000) : null;
    notifyGeneric({
      severity: 'HIGH',
      subject: status === 'down' ? `Servicio CAÍDO: ${check.name}` : `Servicio restablecido: ${check.name}`,
      text:
        status === 'down'
          ? `${check.target} no responde (${data.lastError}). Confirmado tras ${CONFIRM_FAILURES} chequeos seguidos.`
          : `${check.target} volvió a responder${downMinutes !== null ? ` después de ~${downMinutes} min caído` : ''} (${result.latencyMs} ms).`,
      source: 'service-monitor',
      metadata: { checkId: check.id, status },
    }).catch(() => {});
  }

  broadcast({ type: 'SERVICE_CHECK', check: { id: check.id, name: check.name, target: check.target, status, lastLatencyMs: data.lastLatencyMs, lastCheckedAt: now, lastError: data.lastError } });
}

async function tick() {
  const checks = await prisma.serviceCheck.findMany({ where: { enabled: true } });
  const now = Date.now();
  const due = checks.filter(
    (c) => !running.has(c.id) && (!c.lastCheckedAt || now - c.lastCheckedAt.getTime() >= c.intervalSeconds * 1000)
  );
  for (const check of due.slice(0, MAX_CONCURRENT)) {
    running.add(check.id);
    runCheck(check)
      .catch((err) => console.error(`Error en el monitor "${check.name}"`, err.message))
      .finally(() => running.delete(check.id));
  }
}

// Uptime y latencia por monitor, para la vista.
async function listServiceChecks() {
  const checks = await prisma.serviceCheck.findMany({ orderBy: { name: 'asc' } });
  if (checks.length === 0) return [];
  const stats = await prisma.$queryRaw`
    SELECT "checkId",
      AVG(CASE WHEN up THEN 1 ELSE 0 END) FILTER (WHERE at >= NOW() - INTERVAL '24 hours') AS up24,
      AVG(CASE WHEN up THEN 1 ELSE 0 END) FILTER (WHERE at >= NOW() - INTERVAL '7 days') AS up7,
      AVG(CASE WHEN up THEN 1 ELSE 0 END) AS up30,
      AVG("latencyMs") FILTER (WHERE at >= NOW() - INTERVAL '24 hours') AS lat24
    FROM service_check_results
    WHERE at >= NOW() - INTERVAL '30 days'
    GROUP BY "checkId"
  `;
  const byId = new Map(stats.map((r) => [r.checkId, r]));
  // Ultimos 60 resultados de cada uno (barra de historial tipo status page).
  const recent = await prisma.$queryRaw`
    SELECT "checkId", at, up, "latencyMs" FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY "checkId" ORDER BY at DESC) AS rn FROM service_check_results
    ) t WHERE rn <= 60 ORDER BY at
  `;
  const recentById = new Map();
  for (const r of recent) {
    if (!recentById.has(r.checkId)) recentById.set(r.checkId, []);
    recentById.get(r.checkId).push({ at: r.at, up: r.up, latencyMs: r.latencyMs });
  }
  const pct = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 10000) / 100);
  return checks.map((c) => {
    const s = byId.get(c.id);
    return {
      ...c,
      uptime24h: pct(s?.up24),
      uptime7d: pct(s?.up7),
      uptime30d: pct(s?.up30),
      avgLatency24h: s?.lat24 !== null && s?.lat24 !== undefined ? Math.round(Number(s.lat24)) : null,
      recent: recentById.get(c.id) ?? [],
    };
  });
}

function scheduleServiceMonitor() {
  setTimeout(() => {
    setInterval(() => {
      tick().catch((err) => console.error('Error en el monitor de servicios', err));
    }, TICK_MS);
  }, 25 * 1000);
}

module.exports = { scheduleServiceMonitor, listServiceChecks, runCheck, checkTcp, checkHttp };
