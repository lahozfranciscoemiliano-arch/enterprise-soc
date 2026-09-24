// Broker de acceso remoto: tunel inverso generico (agnostico al protocolo -
// sirve para RDP, VNC, lo que este escuchando en el puerto de destino).
//
// Como funciona:
// 1. Cada agente, al arrancar, abre una conexion de control persistente
//    hacia /ws/agent-control (autenticada con su propia API key). El agente
//    nunca abre puertos entrantes: la conexion siempre sale de el.
// 2. Un ADMIN pide una sesion remota (POST /api/admin/servers/:id/remote-session).
//    Si el agente de ese servidor esta conectado, se le manda un comando
//    START_TUNNEL por el canal de control.
// 3. El agente abre una SEGUNDA conexion (la "pata" de datos) hacia
//    /ws/tunnel/:sessionId?role=agent, y conecta un socket TCP local a
//    127.0.0.1:targetPort (donde escucha RDP/VNC en esa misma maquina).
// 4. El operador corre un relay local (tools/remote-relay.js) que abre la
//    otra "pata" hacia /ws/tunnel/:sessionId?role=client&token=... y expone
//    un puerto TCP en su propia máquina para que mstsc/VNC se conecte ahi.
// 5. El backend NUNCA interpreta el contenido del tunel: solo reenvia bytes
//    en crudo entre las dos patas una vez que las dos estan conectadas.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { WebSocketServer } = require('ws');
const prisma = require('../prismaClient');
const { logAudit } = require('./auditLog');

const MAX_TUNNEL_DURATION_MS = 30 * 60 * 1000; // 30 min, corta la conexion aunque siga en uso
const PENDING_TIMEOUT_MS = 2 * 60 * 1000; // 2 min para que ambas patas se conecten

const agentControlSockets = new Map(); // serverId -> ws
const tunnels = new Map(); // sessionId -> { agentLeg, clientLeg, timeout, maxDurationTimeout }

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function isAgentControlConnected(serverId) {
  const ws = agentControlSockets.get(serverId);
  return Boolean(ws && ws.readyState === ws.OPEN);
}

function sendStartTunnel(serverId, sessionId, targetPort) {
  const ws = agentControlSockets.get(serverId);
  if (!ws || ws.readyState !== ws.OPEN) return false;
  ws.send(JSON.stringify({ type: 'START_TUNNEL', sessionId, targetPort }));
  return true;
}

async function closeSession(sessionId, { reason } = {}) {
  const entry = tunnels.get(sessionId);
  if (entry) {
    clearTimeout(entry.timeout);
    clearTimeout(entry.maxDurationTimeout);
    entry.agentLeg?.close();
    entry.clientLeg?.close();
    tunnels.delete(sessionId);
  }

  try {
    await prisma.remoteSession.updateMany({
      where: { id: sessionId, status: { in: ['PENDING', 'ACTIVE'] } },
      data: { status: reason === 'expired' ? 'EXPIRED' : 'CLOSED', endedAt: new Date() },
    });
  } catch (err) {
    console.error('Error cerrando sesión remota en la base', err);
  }
}

function pipeLegs(sessionId, entry) {
  const { agentLeg, clientLeg } = entry;

  agentLeg.on('message', (data) => {
    if (clientLeg.readyState === clientLeg.OPEN) clientLeg.send(data);
  });
  clientLeg.on('message', (data) => {
    if (agentLeg.readyState === agentLeg.OPEN) agentLeg.send(data);
  });

  const onEnd = () => closeSession(sessionId, {});
  agentLeg.on('close', onEnd);
  clientLeg.on('close', onEnd);
  agentLeg.on('error', onEnd);
  clientLeg.on('error', onEnd);

  entry.maxDurationTimeout = setTimeout(() => closeSession(sessionId, { reason: 'max_duration' }), MAX_TUNNEL_DURATION_MS);
}

// El token del operador (role=client) es de un solo uso: si ya hay una pata
// cliente adjunta a esta sesion, una segunda conexion con el mismo token
// (token filtrado, replay, o el relay reconectando por error) NO debe poder
// engancharse al mismo tunel. La pata del agente si puede re-adjuntarse
// (reconexion de red legitima) porque la autentica la API key propia del
// servidor, no un secreto de un solo uso.
async function attachTunnelLeg(sessionId, role, ws) {
  let entry = tunnels.get(sessionId);
  if (!entry) {
    entry = { agentLeg: null, clientLeg: null, timeout: null, maxDurationTimeout: null };
    entry.timeout = setTimeout(() => closeSession(sessionId, { reason: 'expired' }), PENDING_TIMEOUT_MS);
    tunnels.set(sessionId, entry);
  }

  if (role === 'client' && entry.clientLeg) {
    return false;
  }

  if (role === 'agent') entry.agentLeg = ws;
  else entry.clientLeg = ws;

  console.log(
    `Pata de tunel conectada: sesion=${sessionId} rol=${role} (agente=${Boolean(entry.agentLeg)}, cliente=${Boolean(entry.clientLeg)})`
  );

  if (entry.agentLeg && entry.clientLeg) {
    clearTimeout(entry.timeout);
    pipeLegs(sessionId, entry);
    await prisma.remoteSession.update({ where: { id: sessionId }, data: { status: 'ACTIVE', startedAt: new Date() } });
    console.log(`Tunel activo: sesion=${sessionId}`);
  }

  return true;
}

function createRemoteBroker(httpServer) {
  // Ambos en modo noServer + enrutamiento manual por pathname (ver el mismo
  // comentario en socketServer.js: no se puede mezclar {server, path} de
  // "ws" con otras instancias en el mismo httpServer sin que la primera que
  // no matchea aborte la conexion de las demas).
  const controlWss = new WebSocketServer({ noServer: true });
  const tunnelWss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname !== '/ws/agent-control') return;
    controlWss.handleUpgrade(req, socket, head, (ws) => controlWss.emit('connection', ws, req));
  });

  controlWss.on('connection', async (ws, req) => {
    const serverId = req.headers['x-server-id'];
    const apiKey = req.headers['x-api-key'];

    if (!serverId || !apiKey) {
      ws.close(4001, 'Missing credentials');
      return;
    }

    try {
      const server = await prisma.server.findUnique({ where: { id: serverId } });
      if (!server || !(await bcrypt.compare(apiKey, server.apiKeyHash))) {
        ws.close(4003, 'Invalid credentials');
        return;
      }

      agentControlSockets.set(serverId, ws);
      console.log(`Canal de control conectado: servidor ${server.name} (${serverId})`);
      ws.on('close', () => {
        if (agentControlSockets.get(serverId) === ws) agentControlSockets.delete(serverId);
        console.log(`Canal de control desconectado: servidor ${server.name} (${serverId})`);
      });
    } catch (err) {
      console.error('Error autenticando canal de control del agente', err);
      ws.close(1011, 'Internal error');
    }
  });

  httpServer.on('upgrade', (req, socket, head) => {
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    const match = /^\/ws\/tunnel\/([a-f0-9-]{36})$/.exec(pathname);
    if (!match) return; // no es para este handler; otro listener (o ninguno) lo resuelve

    const sessionId = match[1];
    const role = searchParams.get('role');

    tunnelWss.handleUpgrade(req, socket, head, async (ws) => {
      try {
        const session = await prisma.remoteSession.findUnique({ where: { id: sessionId } });
        if (!session || !['PENDING', 'ACTIVE'].includes(session.status) || session.expiresAt < new Date()) {
          console.log(`Tunel rechazado: sesion=${sessionId} rol=${role} motivo=session_not_found_or_expired`);
          ws.close(4004, 'Session not found or expired');
          return;
        }

        if (role === 'agent') {
          const serverId = req.headers['x-server-id'];
          const apiKey = req.headers['x-api-key'];
          if (serverId !== session.serverId) {
            console.log(`Tunel rechazado: sesion=${sessionId} rol=agent motivo=server_mismatch (recibido=${serverId}, esperado=${session.serverId})`);
            ws.close(4003, 'Server mismatch');
            return;
          }
          const server = await prisma.server.findUnique({ where: { id: serverId } });
          if (!server || !apiKey || !(await bcrypt.compare(apiKey, server.apiKeyHash))) {
            console.log(`Tunel rechazado: sesion=${sessionId} rol=agent motivo=invalid_credentials`);
            ws.close(4003, 'Invalid credentials');
            return;
          }
        } else if (role === 'client') {
          const token = searchParams.get('token');
          if (!token || !(await bcrypt.compare(token, session.tokenHash))) {
            console.log(`Tunel rechazado: sesion=${sessionId} rol=client motivo=invalid_token`);
            ws.close(4003, 'Invalid token');
            return;
          }
        } else {
          ws.close(4000, 'Invalid role');
          return;
        }

        const attached = await attachTunnelLeg(sessionId, role, ws);
        if (!attached) {
          console.log(`Tunel rechazado: sesion=${sessionId} rol=${role} motivo=leg_already_attached`);
          ws.close(4009, 'Session already has a client attached');
        }
      } catch (err) {
        console.error('Error adjuntando pata del tunel remoto', err);
        ws.close(1011, 'Internal error');
      }
    });
  });

  return { controlWss, tunnelWss };
}

module.exports = {
  createRemoteBroker,
  isAgentControlConnected,
  sendStartTunnel,
  generateSessionToken,
  closeSession,
};
