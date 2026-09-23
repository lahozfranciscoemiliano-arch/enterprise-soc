const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');

let wss = null;
const clients = new Set();

function createSocketServer(httpServer) {
  wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const { searchParams } = new URL(req.url, 'http://localhost');
    const token = searchParams.get('token');

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
