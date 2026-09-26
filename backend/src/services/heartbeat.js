const prisma = require('../prismaClient');
const { getSetting } = require('./settings');
const { isInMaintenance } = require('./alertEngine');
const { logAudit } = require('./auditLog');
const { createAndDispatchEvent } = require('./eventPipeline');
const { broadcastServerStatus } = require('../websocket/socketServer');

// Umbral de fabrica: 4 minutos sin telemetria. El agente reporta cada 60s
// por defecto, asi que esto tolera un par de ciclos perdidos (jitter de red,
// un reinicio de Windows Update) antes de considerarlo un silencio real.
// Configurable en Admin -> Configuracion -> Sesion y agentes.
const DEFAULT_STALE_THRESHOLD_SECONDS = 240;

let lastRun = null; // { checkedAt, markedOffline: [{id,name}], error }

function getLastRun() {
  return lastRun;
}

// El agente marca ONLINE en cada POST /api/telemetry, pero nada lo revierte
// si el agente deja de mandar datos (proceso muerto, servidor colgado, red
// cortada). Sin este chequeo, un servidor "silencioso" queda ONLINE para
// siempre -- exactamente el escenario que un NOC tiene que detectar.
async function runHeartbeatCheck() {
  const checkedAt = new Date();
  const markedOffline = [];

  try {
    const thresholdSeconds = (await getSetting('AGENT_STALE_THRESHOLD_SECONDS')) ?? DEFAULT_STALE_THRESHOLD_SECONDS;
    const cutoff = new Date(Date.now() - thresholdSeconds * 1000);

    const staleServers = await prisma.server.findMany({
      where: {
        status: 'ONLINE',
        OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: cutoff } }],
      },
    });

    for (const server of staleServers) {
      if (isInMaintenance(server)) continue; // en mantenimiento: silencio esperado, no alertar

      // eslint-disable-next-line no-await-in-loop
      await prisma.server.update({ where: { id: server.id }, data: { status: 'OFFLINE' } });

      const minutesSilent = server.lastSeenAt
        ? Math.round((checkedAt - server.lastSeenAt) / 60000)
        : null;

      // eslint-disable-next-line no-await-in-loop
      await createAndDispatchEvent({
        serverId: server.id,
        serverName: server.name,
        type: 'AGENT_OFFLINE',
        severity: 'CRITICAL',
        description: minutesSilent
          ? `${server.name}: sin telemetría hace ${minutesSilent} minuto(s). El agente dejó de reportar.`
          : `${server.name}: nunca reportó telemetría y quedó marcado como caído.`,
        metadata: { lastSeenAt: server.lastSeenAt, thresholdSeconds },
        // Se auto-resuelve con la primera telemetria que vuelva a llegar
        // (POST /api/telemetry).
        dedupKey: 'AGENT_OFFLINE',
      });
      broadcastServerStatus(server.id, 'OFFLINE');

      markedOffline.push({ id: server.id, name: server.name });
    }

    if (markedOffline.length > 0) {
      logAudit({
        userId: null,
        action: 'HEARTBEAT_MARK_OFFLINE',
        targetType: 'System',
        metadata: { servers: markedOffline },
      });
      console.log(`Heartbeat: ${markedOffline.length} servidor(es) marcado(s) OFFLINE por falta de telemetría`, markedOffline);
    }

    lastRun = { checkedAt, markedOffline, error: null };
    return lastRun;
  } catch (err) {
    console.error('Error en el chequeo de heartbeat', err);
    lastRun = { checkedAt, markedOffline, error: err.message };
    return lastRun;
  }
}

const HEARTBEAT_INTERVAL_MS = 60 * 1000;

function scheduleHeartbeat() {
  setTimeout(() => {
    runHeartbeatCheck().catch((err) => console.error('Error en heartbeat programado', err));
    setInterval(() => {
      runHeartbeatCheck().catch((err) => console.error('Error en heartbeat programado', err));
    }, HEARTBEAT_INTERVAL_MS);
  }, 30 * 1000);
}

module.exports = { runHeartbeatCheck, getLastRun, scheduleHeartbeat, DEFAULT_STALE_THRESHOLD_SECONDS };
