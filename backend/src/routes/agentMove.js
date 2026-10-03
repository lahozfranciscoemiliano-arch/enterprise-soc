// Direccion del NOC en los agentes (ver services/agentMove.js).
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const agentMove = require('../services/agentMove');
const ops = require('../services/ops');
const { logAudit } = require('../services/auditLog');
const { notifyGeneric } = require('../services/notifications');

module.exports = function registerAgentMoveRoutes(app, { authUser, authServer, requireRole }) {
  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.error(`Error en ${req.method} ${req.path}`, err);
      if (!res.headersSent) res.status(500).json({ error: 'Error interno del servidor' });
    }
  };
  const helloLimiter = rateLimit({ windowMs: 60000, max: 60, standardHeaders: true, legacyHeaders: false });
  const pinLimiter = rateLimit({ windowMs: 15 * 60000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Demasiados intentos con PIN' } });
  const agentLimiter = rateLimit({
    windowMs: 60000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `move:${req.header('x-server-id') || req.ip}`,
  });

  // --- Agente: comprobar la direccion nueva desde su red ---------------------
  // Sin credenciales: el agente solo manda su clave si del otro lado hay un NOC.
  app.get('/api/agent/hello', helloLimiter, (req, res) => res.json({ app: 'enterprise-soc', instanceId: agentMove.INSTANCE_ID }));

  // Con credenciales y sin efectos: 200 = esta base ya conoce a este agente.
  app.get('/api/agent/whoami', agentLimiter, authServer, (req, res) =>
    res.json({ ok: true, serverId: req.server.id, name: req.server.name, instanceId: agentMove.INSTANCE_ID })
  );

  // --- Panel ---------------------------------------------------------------------
  app.get(
    '/api/admin/agent-move',
    authUser,
    requireRole('ADMIN'),
    wrap(async (req, res) => res.json(await agentMove.status()))
  );

  app.put(
    '/api/admin/agent-move',
    pinLimiter,
    authUser,
    requireRole('ADMIN'),
    wrap(async (req, res) => {
      const parsed = z.object({ url: z.string().max(300), pin: z.string().max(12) }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Datos inválidos' });
      const url = agentMove.normalizeUrl(parsed.data.url);
      if (!url) return res.status(400).json({ error: 'Dirección inválida: usá solo http://IP o https://dominio, sin rutas' });
      const pin = await ops.verifyPin(req.user.sub, parsed.data.pin);
      if (!pin.ok) {
        logAudit({ userId: req.user.sub, action: 'PIN_FAILED', targetType: 'User', targetId: req.user.sub, metadata: { path: req.path } });
        return res.status(pin.status).json({ error: pin.error });
      }
      const move = await agentMove.setMove({ url, user: pin.user });
      logAudit({ userId: req.user.sub, action: 'AGENT_MOVE_SET', targetType: 'Setting', targetId: 'AGENT_MOVE', metadata: { url } });
      // Aviso por todos los canales: si no lo programo alguien del equipo, se cancela en el momento.
      notifyGeneric({
        severity: 'CRITICAL',
        subject: 'Cambio de dirección de los agentes programado',
        text: `${move.setBy} programó que todos los agentes pasen a usar ${url} (vence en 7 días). Si no fue alguien del equipo, cancelalo ya en Admin → Servidores.`,
        source: 'agent-move',
        metadata: { url },
      }).catch(() => {});
      return res.json(move);
    })
  );

  app.delete(
    '/api/admin/agent-move',
    authUser,
    requireRole('ADMIN'),
    wrap(async (req, res) => {
      const move = await agentMove.getMove();
      await agentMove.clearMove();
      logAudit({ userId: req.user.sub, action: 'AGENT_MOVE_CLEAR', targetType: 'Setting', targetId: 'AGENT_MOVE', metadata: { url: move?.url ?? null } });
      if (move) {
        notifyGeneric({
          severity: 'HIGH',
          subject: 'Cambio de dirección de los agentes cancelado',
          text: `Se canceló el cambio de los agentes a ${move.url}. Los que todavía no se cambiaron siguen con la dirección actual.`,
          source: 'agent-move',
          metadata: { url: move.url },
        }).catch(() => {});
      }
      return res.json({ ok: true });
    })
  );
};
