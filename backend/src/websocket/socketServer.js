const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const cookie = require('cookie');
const { isSessionValid } = require('../services/sessions');

const SESSION_COOKIE_NAME = 'soc_session';

let wss = null;
const clients = new Set();

function createSocketServer(httpServer) {
  wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', async (ws, req) => {
    // El token ya no viaja en la URL (terminaba en logs/historial del
    // navegador); el handshake del WebSocket es una request HTTP normal, asi
    // que el navegador manda la cookie httpOnly sola, igual que en un fetch.
    const cookies = cookie.parse(req.headers.cookie || '');
    const token = cookies[SESSION_COOKIE_NAME];

    if (!token) {
      ws.close(4001, 'Missing authentication token');
      return;
    }

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      ws.close(4002, 'Invalid or expired token');
      return;
    }

    if (!payload.jti || !(await isSessionValid(payload.jti))) {
      ws.close(4002, 'Invalid or expired token');
      return;
    }

    ws.userId = payload.sub;
    ws.role = payload.role;
    ws.isAlive = true;

    clients.add(ws);

    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));

    ws.send(JSON.stringify({ type: 'CONNECTED', message: 'Conectado al feed de alertas NOC/SOC' }));
  });

  const heartbeat = setInterval(() => {
    for (const ws of clients) {
      if (!ws.isAlive) {
        ws.terminate();
        clients.delete(ws);
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);

  wss.on('close', () => clearInterval(heartbeat));

  return wss;
}

function broadcast(message) {
  const payload = JSON.stringify(message);

  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
  }
}

function broadcastAlert(event) {
  broadcast({ type: 'SECURITY_ALERT', event });
}

function broadcastTelemetry(server, telemetry) {
  broadcast({
    type: 'TELEMETRY',
    data: {
      serverId: server.id,
      serverName: server.name,
      cpuUsage: telemetry.cpuUsage,
      memoryUsage: telemetry.memoryUsage,
      diskUsage: telemetry.diskUsage,
      recordedAt: telemetry.recordedAt,
    },
  });
}

function broadcastBackupStatus(server, backup) {
  broadcast({
    type: 'BACKUP_STATUS',
    data: {
      serverId: server.id,
      serverName: server.name,
      result: backup.result,
      method: backup.method,
      lastBackupAt: backup.lastBackupAt,
      targetPath: backup.targetPath,
      sizeBytes: backup.sizeBytes,
      vssServiceOk: backup.vssServiceOk,
      detail: backup.detail,
      recordedAt: backup.recordedAt,
    },
  });
}

function broadcastAlertUpdate(event) {
  broadcast({ type: 'SECURITY_ALERT_UPDATE', event });
}

module.exports = {
  createSocketServer,
  broadcastAlert,
  broadcastAlertUpdate,
  broadcastTelemetry,
  broadcastBackupStatus,
};
