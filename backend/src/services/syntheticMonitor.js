// Synthetic monitoring: chequeo de red ACTIVO (conexion TCP), en vez de
// esperar pasivamente a que el agente avise. Distingue dos escenarios que
// hoy son indistinguibles: "el proceso del agente se colgo pero la red del
// sitio esta bien" vs. "el sitio entero quedo aislado" (relevante con 2
// conexiones de internet dedicadas por sitio -- si una alertara de origen
// distinto ayuda a saber si es la red o el servidor).
//
// Opt-in por servidor (Server.syntheticCheckPort): no todos los sitios van
// a tener un puerto alcanzable desde el VPS, y un chequeo que siempre falla
// por un firewall entre medio genera desconfianza, no valor.
const net = require('net');
const prisma = require('../prismaClient');
const { isInMaintenance } = require('./alertEngine');
const { createAndDispatchEvent } = require('./eventPipeline');

const CHECK_TIMEOUT_MS = 5000;
const FAILURE_THRESHOLD = 2; // chequeos consecutivos fallidos antes de alertar (evita ruido por un timeout aislado)
const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // no repetir la alerta mientras el sitio siga caido

const consecutiveFailures = new Map(); // serverId -> count
const lastAlertAt = new Map(); // serverId -> timestamp

function checkTcpPort(host, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(CHECK_TIMEOUT_MS);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));

    socket.connect(port, host);
  });
}

let lastRun = null; // { checkedAt, checked, unreachable: [{id,name}] }

function getLastRun() {
  return lastRun;
}

async function runSyntheticChecks() {
  const checkedAt = new Date();
  const servers = await prisma.server.findMany({ where: { syntheticCheckPort: { not: null } } });

  const unreachable = [];

  await Promise.all(
    servers.map(async (server) => {
      if (isInMaintenance(server)) return;

      const ok = await checkTcpPort(server.ipAddress, server.syntheticCheckPort);

      if (ok) {
        consecutiveFailures.set(server.id, 0);
        return;
      }

      const failures = (consecutiveFailures.get(server.id) ?? 0) + 1;
      consecutiveFailures.set(server.id, failures);

      if (failures < FAILURE_THRESHOLD) return;

      const lastAlert = lastAlertAt.get(server.id);
      if (lastAlert && Date.now() - lastAlert < ALERT_COOLDOWN_MS) {
        unreachable.push({ id: server.id, name: server.name });
        return;
      }

      // Si el heartbeat ya lo tiene OFFLINE, es casi seguro que el sitio
      // entero esta caido (no solo ese puerto) -- CRITICAL en vez de HIGH.
      const severity = server.status === 'OFFLINE' ? 'CRITICAL' : 'HIGH';

      await createAndDispatchEvent({
        serverId: server.id,
        serverName: server.name,
        type: 'NETWORK_UNREACHABLE',
        severity,
        description: `${server.name}: no se pudo conectar al puerto ${server.syntheticCheckPort} (${FAILURE_THRESHOLD} intentos fallidos seguidos).`,
        metadata: { port: server.syntheticCheckPort, consecutiveFailures: failures, serverId: server.id },
      });

      lastAlertAt.set(server.id, Date.now());
      unreachable.push({ id: server.id, name: server.name });
    })
  );

  lastRun = { checkedAt, checked: servers.length, unreachable };
  return lastRun;
}

const SYNTHETIC_CHECK_INTERVAL_MS = 2 * 60 * 1000;

function scheduleSyntheticMonitor() {
  setTimeout(() => {
    runSyntheticChecks().catch((err) => console.error('Error en synthetic monitoring', err));
    setInterval(() => {
      runSyntheticChecks().catch((err) => console.error('Error en synthetic monitoring', err));
    }, SYNTHETIC_CHECK_INTERVAL_MS);
  }, 45 * 1000);
}

module.exports = { runSyntheticChecks, getLastRun, scheduleSyntheticMonitor };
