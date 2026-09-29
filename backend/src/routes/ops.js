// Rutas de operaciones: tickets, PIN de aprobacion, remediacion con un clic,
// base de conocimiento, prueba de velocidad, guardian de red, parches y
// topologia automatica. Mas las rutas que usa el agente (tareas, velocidad,
// guardian de red).
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const prisma = require('../prismaClient');
const ops = require('../services/ops');
const netGuard = require('../services/netGuard');
const { buildNetworkTopology } = require('../services/topology');
const { logAudit } = require('../services/auditLog');
const { broadcast } = require('../websocket/socketServer');

const pinSchema = z.string().regex(/^\d{6}$/, 'El PIN debe tener 6 dígitos');
const TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING', 'RESOLVED', 'CLOSED'];
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const STATUS_LABEL = { OPEN: 'Abierto', IN_PROGRESS: 'En curso', WAITING: 'En espera', RESOLVED: 'Resuelto', CLOSED: 'Cerrado' };

const createTicketSchema = z
  .object({
    title: z.string().min(3).max(200),
    description: z.string().max(5000).optional(),
    priority: z.enum(PRIORITIES).default('MEDIUM'),
    eventId: z.string().uuid().optional(),
    serverId: z.string().uuid().optional(),
    assigneeId: z.string().uuid().nullable().optional(),
    pin: pinSchema,
  })
  .strict();

const updateTicketSchema = z
  .object({
    status: z.enum(TICKET_STATUSES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    assigneeId: z.string().uuid().nullable().optional(),
    resolution: z.string().max(5000).optional(),
    saveToKb: z.boolean().optional(),
    pin: pinSchema,
  })
  .strict();

const kbSchema = z
  .object({
    title: z.string().min(3).max(200),
    problem: z.string().min(3).max(5000),
    solution: z.string().min(3).max(10000),
    tags: z.array(z.string().max(40)).max(15).default([]),
    alertType: z.string().max(60).nullable().optional(),
  })
  .strict();

const remediationSchema = z
  .object({
    serverId: z.string().uuid(),
    action: z.string().max(40),
    params: z.record(z.string().max(100)).default({}),
    eventId: z.string().uuid().optional(),
    ticketId: z.string().uuid().optional(),
    pin: pinSchema,
  })
  .strict();

const netguardReportSchema = z.object({
  localIps: z.array(z.string().max(64)).max(30).optional(),
  gateway: z.object({ ip: z.string().max(64), mac: z.string().max(40).nullable().optional() }).nullable().optional(),
  gatewayMacOtherIps: z.array(z.string().max(64)).max(30).optional(),
  dhcp: z
    .object({
      ok: z.boolean(),
      error: z.string().max(300).optional(),
      offers: z.array(z.record(z.any())).max(20).optional(),
    })
    .optional(),
});

const speedtestSchema = z.object({
  ok: z.boolean().optional(),
  error: z.string().max(300).optional(),
  downloadMbps: z.number().min(0).max(100000).nullable().optional(),
  uploadMbps: z.number().min(0).max(100000).nullable().optional(),
  latencyMs: z.number().min(0).max(100000).nullable().optional(),
  jitterMs: z.number().min(0).max(100000).nullable().optional(),
  publicIp: z.string().max(64).nullable().optional(),
  server: z.string().max(60).optional(),
  at: z.string().max(50).optional(),
});

async function currentUser(req) {
  return prisma.user.findUnique({ where: { id: req.user.sub }, select: { id: true, name: true, email: true, role: true } });
}

module.exports = function registerOpsRoutes(app, { authUser, authServer, requireRole }) {
  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.error(`Error en ${req.method} ${req.path}`, err);
      if (!res.headersSent) res.status(500).json({ error: 'Error interno del servidor' });
    }
  };
  const pinLimiter = rateLimit({ windowMs: 15 * 60000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Demasiados intentos con PIN' } });
  const agentLimiter = rateLimit({ windowMs: 60000, max: 30, standardHeaders: true, legacyHeaders: false });
  const writer = requireRole('ADMIN', 'ANALYST');

  async function checkPin(req, res, pin) {
    const r = await ops.verifyPin(req.user.sub, pin);
    if (!r.ok) {
      logAudit({ userId: req.user.sub, action: 'PIN_FAILED', targetType: 'User', targetId: req.user.sub, metadata: { path: req.path } });
      res.status(r.status).json({ error: r.error });
      return null;
    }
    return r.user;
  }

  // --- PIN personal -------------------------------------------------------------
  app.get(
    '/api/account/pin',
    authUser,
    wrap(async (req, res) => {
      const u = await prisma.user.findUnique({ where: { id: req.user.sub }, select: { pinHash: true, pinLockedUntil: true } });
      return res.json({ configured: Boolean(u?.pinHash), lockedUntil: u?.pinLockedUntil && u.pinLockedUntil > new Date() ? u.pinLockedUntil : null });
    })
  );

  app.post(
    '/api/account/pin',
    pinLimiter,
    authUser,
    wrap(async (req, res) => {
      const parsed = z.object({ password: z.string().min(1).max(200), pin: pinSchema }).strict().safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Datos inválidos' });
      if (ops.pinIsWeak(parsed.data.pin)) return res.status(400).json({ error: 'PIN demasiado fácil (evitá 123456, 000000, repetidos...)' });
      const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
      if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) return res.status(401).json({ error: 'Contraseña incorrecta' });
      await ops.setPin(user.id, parsed.data.pin);
      logAudit({ userId: user.id, action: 'PIN_SET', targetType: 'User', targetId: user.id });
      return res.json({ ok: true });
    })
  );

  app.get(
    '/api/users/assignable',
    authUser,
    wrap(async (req, res) => {
      const users = await prisma.user.findMany({ where: { role: { in: ['ADMIN', 'ANALYST'] } }, select: { id: true, name: true, email: true }, orderBy: { name: 'asc' } });
      return res.json(users);
    })
  );

  // --- Tickets ------------------------------------------------------------------
  app.get(
    '/api/tickets',
    authUser,
    wrap(async (req, res) => {
      const where = {};
      if (req.query.status === 'active') where.status = { in: ['OPEN', 'IN_PROGRESS', 'WAITING'] };
      else if (TICKET_STATUSES.includes(req.query.status)) where.status = req.query.status;
      if (req.query.mine === '1') where.assigneeId = req.user.sub;
      if (req.query.eventId) where.eventId = String(req.query.eventId);
      const tickets = await prisma.ticket.findMany({ where, orderBy: [{ updatedAt: 'desc' }], take: 500, include: { _count: { select: { comments: true } } } });
      return res.json(tickets);
    })
  );

  app.get(
    '/api/tickets/metrics',
    authUser,
    wrap(async (req, res) => {
      const since = new Date(Date.now() - (Number(req.query.days) || 30) * 86400000);
      const rows = await prisma.ticket.findMany({ where: { createdAt: { gte: since } } });
      const by = new Map();
      for (const t of rows) {
        const k = t.assigneeName ?? 'Sin asignar';
        const m = by.get(k) ?? { technician: k, assigned: 0, open: 0, resolved: 0, resolutionHours: [], responseHours: [] };
        m.assigned += 1;
        if (['RESOLVED', 'CLOSED'].includes(t.status)) {
          m.resolved += 1;
          if (t.resolvedAt) m.resolutionHours.push((t.resolvedAt - t.createdAt) / 3600000);
        } else m.open += 1;
        if (t.firstResponseAt) m.responseHours.push((t.firstResponseAt - t.createdAt) / 3600000);
        by.set(k, m);
      }
      const avg = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null);
      return res.json({
        total: rows.length,
        open: rows.filter((t) => !['RESOLVED', 'CLOSED'].includes(t.status)).length,
        technicians: [...by.values()].map((m) => ({ technician: m.technician, assigned: m.assigned, open: m.open, resolved: m.resolved, avgResolutionHours: avg(m.resolutionHours), avgFirstResponseHours: avg(m.responseHours) })),
      });
    })
  );

  app.get(
    '/api/tickets/:id',
    authUser,
    wrap(async (req, res) => {
      const ticket = await prisma.ticket.findUnique({ where: { id: req.params.id }, include: { comments: { orderBy: { createdAt: 'asc' } } } });
      if (!ticket) return res.status(404).json({ error: 'Ticket no encontrado' });
      const [actions, suggestions] = await Promise.all([
        prisma.remediationAction.findMany({ where: { ticketId: ticket.id }, orderBy: { createdAt: 'desc' } }),
        ops.suggestArticles({ type: ticket.eventType, text: `${ticket.title} ${ticket.description ?? ''}` }),
      ]);
      return res.json({ ...ticket, actions, suggestions });
    })
  );

  app.post(
    '/api/tickets',
    pinLimiter,
    authUser,
    writer,
    wrap(async (req, res) => {
      const parsed = createTicketSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Datos inválidos' });
      const user = await checkPin(req, res, parsed.data.pin);
      if (!user) return undefined;
      const d = parsed.data;
      let event = null;
      if (d.eventId) {
        event = await prisma.securityEvent.findUnique({ where: { id: d.eventId }, include: { server: { select: { id: true, name: true } } } });
        if (!event) return res.status(404).json({ error: 'Alerta no encontrada' });
        const existing = await prisma.ticket.findFirst({ where: { eventId: d.eventId, status: { in: ['OPEN', 'IN_PROGRESS', 'WAITING'] } } });
        if (existing) return res.status(409).json({ error: `Esa alerta ya tiene el ticket #${existing.number}`, ticket: existing });
      }
      const server = event?.server ?? (d.serverId ? await prisma.server.findUnique({ where: { id: d.serverId }, select: { id: true, name: true } }) : null);
      const assignee = d.assigneeId ? await prisma.user.findUnique({ where: { id: d.assigneeId }, select: { id: true, name: true } }) : null;
      const ticket = await prisma.ticket.create({
        data: {
          title: d.title,
          description: d.description ?? event?.description ?? null,
          priority: d.priority,
          eventId: event?.id ?? null,
          eventType: event?.type ?? null,
          serverId: server?.id ?? null,
          serverName: server?.name ?? null,
          assigneeId: assignee?.id ?? null,
          assigneeName: assignee?.name ?? null,
          createdById: user.id,
          createdByName: user.name,
          comments: { create: { userId: user.id, userName: user.name, kind: 'system', body: `Ticket creado${event ? ' desde la alerta' : ''}${assignee ? ` y asignado a ${assignee.name}` : ''}.` } },
        },
      });
      if (event && event.status === 'OPEN') {
        await prisma.securityEvent.update({ where: { id: event.id }, data: { status: 'ACKNOWLEDGED', acknowledgedById: user.id } });
      }
      logAudit({ userId: user.id, action: 'TICKET_CREATE', targetType: 'Ticket', targetId: ticket.id, metadata: { number: ticket.number, eventId: ticket.eventId } });
      broadcast({ type: 'TICKET_UPDATE', ticket });
      return res.status(201).json(ticket);
    })
  );

  app.patch(
    '/api/tickets/:id',
    pinLimiter,
    authUser,
    writer,
    wrap(async (req, res) => {
      const parsed = updateTicketSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Datos inválidos' });
      const user = await checkPin(req, res, parsed.data.pin);
      if (!user) return undefined;
      const t = await prisma.ticket.findUnique({ where: { id: req.params.id } });
      if (!t) return res.status(404).json({ error: 'Ticket no encontrado' });
      const d = parsed.data;
      const data = {};
      const notes = [];
      const now = new Date();
      if (d.status && d.status !== t.status) {
        if (['RESOLVED', 'CLOSED'].includes(d.status) && !(d.resolution ?? t.resolution)) {
          return res.status(400).json({ error: 'Para resolver o cerrar hace falta describir la solución' });
        }
        data.status = d.status;
        if (d.status === 'RESOLVED') data.resolvedAt = now;
        if (d.status === 'CLOSED') {
          data.closedAt = now;
          data.resolvedAt = t.resolvedAt ?? now;
        }
        if (!['RESOLVED', 'CLOSED'].includes(d.status)) {
          data.resolvedAt = null;
          data.closedAt = null;
        }
        if (!t.firstResponseAt && d.status !== 'OPEN') data.firstResponseAt = now;
        notes.push({ kind: 'status', body: `Estado: ${STATUS_LABEL[t.status]} → ${STATUS_LABEL[d.status]}` });
      }
      if (d.priority && d.priority !== t.priority) {
        data.priority = d.priority;
        notes.push({ kind: 'system', body: `Prioridad: ${t.priority} → ${d.priority}` });
      }
      if (d.assigneeId !== undefined && d.assigneeId !== t.assigneeId) {
        const a = d.assigneeId ? await prisma.user.findUnique({ where: { id: d.assigneeId }, select: { id: true, name: true } }) : null;
        data.assigneeId = a?.id ?? null;
        data.assigneeName = a?.name ?? null;
        notes.push({ kind: 'assign', body: a ? `Asignado a ${a.name}` : 'Sin responsable' });
      }
      if (d.resolution !== undefined && d.resolution !== t.resolution) {
        data.resolution = d.resolution;
        notes.push({ kind: 'system', body: `Solución: ${d.resolution.slice(0, 1000)}` });
      }
      if (notes.length === 0) return res.json(t);
      const updated = await prisma.ticket.update({
        where: { id: t.id },
        data: { ...data, comments: { create: notes.map((n) => ({ ...n, userId: user.id, userName: user.name })) } },
      });

      // Cierre: resuelve la alerta vinculada y guarda la solucion en la base
      // de conocimiento (para sugerirla cuando se repita algo parecido).
      if (['RESOLVED', 'CLOSED'].includes(updated.status) && !['RESOLVED', 'CLOSED'].includes(t.status)) {
        if (updated.eventId) {
          await prisma.securityEvent.updateMany({ where: { id: updated.eventId, status: { not: 'RESOLVED' } }, data: { status: 'RESOLVED', resolvedAt: now } });
        }
        if (d.saveToKb !== false && (updated.resolution ?? '').trim().length >= 10) {
          const existing = await prisma.knowledgeArticle.findFirst({ where: { sourceTicketId: updated.id } });
          if (!existing) {
            await prisma.knowledgeArticle.create({
              data: {
                title: updated.title,
                problem: updated.description ?? updated.title,
                solution: updated.resolution,
                alertType: updated.eventType,
                tags: [updated.serverName, updated.eventType].filter(Boolean),
                sourceTicketId: updated.id,
                createdByName: user.name,
              },
            });
          }
        }
      }
      logAudit({ userId: user.id, action: 'TICKET_UPDATE', targetType: 'Ticket', targetId: t.id, metadata: { changes: Object.keys(data) } });
      broadcast({ type: 'TICKET_UPDATE', ticket: updated });
      return res.json(updated);
    })
  );

  app.post(
    '/api/tickets/:id/comments',
    authUser,
    writer,
    wrap(async (req, res) => {
      const parsed = z.object({ body: z.string().min(1).max(5000) }).strict().safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Comentario vacío o demasiado largo' });
      const t = await prisma.ticket.findUnique({ where: { id: req.params.id } });
      if (!t) return res.status(404).json({ error: 'Ticket no encontrado' });
      const user = await currentUser(req);
      const comment = await prisma.ticketComment.create({ data: { ticketId: t.id, userId: user.id, userName: user.name, body: parsed.data.body } });
      await prisma.ticket.update({ where: { id: t.id }, data: { ...(t.firstResponseAt ? {} : { firstResponseAt: new Date() }) } });
      broadcast({ type: 'TICKET_UPDATE', ticket: { id: t.id } });
      return res.status(201).json(comment);
    })
  );

  // --- Base de conocimiento -----------------------------------------------------
  app.get(
    '/api/kb',
    authUser,
    wrap(async (req, res) => {
      const q = String(req.query.q ?? '').trim();
      if (q || req.query.type) {
        const found = await ops.suggestArticles({ type: req.query.type ? String(req.query.type) : null, text: q, limit: 50 });
        if (found.length || !q) return res.json(found);
        const like = await prisma.knowledgeArticle.findMany({
          where: { OR: [{ title: { contains: q, mode: 'insensitive' } }, { problem: { contains: q, mode: 'insensitive' } }, { solution: { contains: q, mode: 'insensitive' } }] },
          take: 50,
        });
        return res.json(like);
      }
      return res.json(await prisma.knowledgeArticle.findMany({ orderBy: [{ uses: 'desc' }, { updatedAt: 'desc' }], take: 300 }));
    })
  );

  app.get(
    '/api/kb/suggest',
    authUser,
    wrap(async (req, res) => {
      const event = req.query.eventId ? await prisma.securityEvent.findUnique({ where: { id: String(req.query.eventId) } }) : null;
      if (!event) return res.json([]);
      return res.json(await ops.suggestArticles({ type: event.type, text: event.description }));
    })
  );

  app.post(
    '/api/kb',
    authUser,
    writer,
    wrap(async (req, res) => {
      const parsed = kbSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Datos inválidos' });
      const user = await currentUser(req);
      const a = await prisma.knowledgeArticle.create({ data: { ...parsed.data, alertType: parsed.data.alertType ?? null, createdByName: user.name } });
      logAudit({ userId: user.id, action: 'KB_CREATE', targetType: 'KnowledgeArticle', targetId: a.id });
      return res.status(201).json(a);
    })
  );

  app.put(
    '/api/kb/:id',
    authUser,
    writer,
    wrap(async (req, res) => {
      const parsed = kbSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Datos inválidos' });
      const a = await prisma.knowledgeArticle.update({ where: { id: req.params.id }, data: { ...parsed.data, alertType: parsed.data.alertType ?? null } });
      logAudit({ userId: req.user.sub, action: 'KB_UPDATE', targetType: 'KnowledgeArticle', targetId: a.id });
      return res.json(a);
    })
  );

  app.delete(
    '/api/kb/:id',
    authUser,
    requireRole('ADMIN'),
    wrap(async (req, res) => {
      await prisma.knowledgeArticle.delete({ where: { id: req.params.id } });
      logAudit({ userId: req.user.sub, action: 'KB_DELETE', targetType: 'KnowledgeArticle', targetId: req.params.id });
      return res.json({ ok: true });
    })
  );

  app.post(
    '/api/kb/:id/used',
    authUser,
    wrap(async (req, res) => {
      await prisma.knowledgeArticle.update({ where: { id: req.params.id }, data: { uses: { increment: 1 } } }).catch(() => null);
      return res.json({ ok: true });
    })
  );

  // --- Remediacion ----------------------------------------------------------------
  app.get(
    '/api/remediation/options',
    authUser,
    wrap(async (req, res) => {
      const event = req.query.eventId ? await prisma.securityEvent.findUnique({ where: { id: String(req.query.eventId) } }) : null;
      const serverId = event?.serverId ?? (req.query.serverId ? String(req.query.serverId) : null);
      const server = serverId ? await prisma.server.findUnique({ where: { id: serverId } }) : null;
      if (!server) return res.status(404).json({ error: 'Servidor no encontrado' });
      return res.json(await ops.remediationOptions({ event, server }));
    })
  );

  app.get(
    '/api/remediation',
    authUser,
    wrap(async (req, res) => {
      const where = {};
      if (req.query.serverId) where.serverId = String(req.query.serverId);
      if (req.query.eventId) where.eventId = String(req.query.eventId);
      return res.json(await prisma.remediationAction.findMany({ where, orderBy: { createdAt: 'desc' }, take: Math.min(Number(req.query.limit) || 50, 300) }));
    })
  );

  app.post(
    '/api/remediation',
    pinLimiter,
    authUser,
    writer,
    wrap(async (req, res) => {
      const parsed = remediationSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Datos inválidos' });
      const d = parsed.data;
      const invalid = ops.validateParams(d.action, d.params);
      if (invalid) return res.status(400).json({ error: invalid });
      const user = await checkPin(req, res, d.pin);
      if (!user) return undefined;
      const server = await prisma.server.findUnique({ where: { id: d.serverId } });
      if (!server) return res.status(404).json({ error: 'Servidor no encontrado' });
      if (server.status === 'OFFLINE') return res.status(409).json({ error: `${server.name} está offline: el agente no puede ejecutar la acción` });
      const row = await ops.queueAction({ server, action: d.action, params: d.params, eventId: d.eventId, ticketId: d.ticketId, user });
      logAudit({ userId: user.id, action: 'REMEDIATION_APPROVED', targetType: 'Server', targetId: server.id, metadata: { action: d.action, params: d.params, eventId: d.eventId ?? null } });
      if (d.ticketId) {
        await prisma.ticketComment.create({ data: { ticketId: d.ticketId, userId: user.id, userName: user.name, kind: 'action', body: `Aprobó con PIN: "${ops.ACTIONS[d.action].label}" en ${server.name}` } }).catch(() => null);
      }
      return res.status(201).json(row);
    })
  );

  // --- Agente: tareas, resultado, velocidad, guardian de red ----------------------
  app.post(
    '/api/agent/tasks',
    agentLimiter,
    authServer,
    wrap(async (req, res) => res.json(await ops.agentTasks(req.server)))
  );

  app.post(
    '/api/agent/tasks/:id/result',
    agentLimiter,
    authServer,
    wrap(async (req, res) => {
      const parsed = z.object({ ok: z.boolean(), output: z.string().max(20000).optional() }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Resultado inválido' });
      const row = await ops.actionResult(req.server, req.params.id, parsed.data);
      if (!row) return res.status(404).json({ error: 'Acción no encontrada' });
      return res.json({ ok: true });
    })
  );

  app.post(
    '/api/agent/speedtest',
    agentLimiter,
    authServer,
    wrap(async (req, res) => {
      const parsed = speedtestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Resultado inválido' });
      const row = await ops.storeSpeedtest(req.server, parsed.data);
      return res.status(201).json({ ok: true, id: row.id });
    })
  );

  app.post(
    '/api/agent/netguard',
    agentLimiter,
    authServer,
    wrap(async (req, res) => {
      const parsed = netguardReportSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Reporte inválido' });
      return res.json({ ok: true, ...(await netGuard.ingestReport(req.server, parsed.data)) });
    })
  );

  // --- Prueba de velocidad ------------------------------------------------------------
  app.get(
    '/api/speedtests',
    authUser,
    wrap(async (req, res) => {
      const days = Math.min(Number(req.query.days) || 30, 365);
      const tests = await prisma.speedTest.findMany({ where: { at: { gte: new Date(Date.now() - days * 86400000) } }, orderBy: { at: 'asc' } });
      const servers = await prisma.server.findMany({
        where: { publicIp: { not: null } },
        select: { id: true, name: true, publicIp: true, contractedDownMbps: true, contractedUpMbps: true, ispPrimaryName: true, status: true, tags: true },
        orderBy: { name: 'asc' },
      });
      return res.json({ tests, servers: servers.filter((s) => !(s.tags ?? []).includes('infra-vps')) });
    })
  );

  app.post(
    '/api/speedtests/run',
    authUser,
    writer,
    wrap(async (req, res) => {
      const server = await prisma.server.findUnique({ where: { id: String(req.body?.serverId ?? '') } });
      if (!server) return res.status(404).json({ error: 'Servidor no encontrado' });
      ops.requestManualSpeedtest(server.id);
      logAudit({ userId: req.user.sub, action: 'SPEEDTEST_RUN', targetType: 'Server', targetId: server.id });
      return res.json({ ok: true, message: `La prueba arranca en ${server.name} en menos de 1 minuto (tarda ~30 s)` });
    })
  );

  app.put(
    '/api/servers/:id/contracted-speed',
    authUser,
    requireRole('ADMIN'),
    wrap(async (req, res) => {
      const parsed = z
        .object({ contractedDownMbps: z.number().min(0).max(100000).nullable(), contractedUpMbps: z.number().min(0).max(100000).nullable() })
        .strict()
        .safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Velocidades inválidas' });
      const s = await prisma.server.update({ where: { id: req.params.id }, data: parsed.data, select: { id: true, contractedDownMbps: true, contractedUpMbps: true } });
      logAudit({ userId: req.user.sub, action: 'CONTRACTED_SPEED_UPDATE', targetType: 'Server', targetId: s.id, metadata: parsed.data });
      return res.json(s);
    })
  );

  // --- Guardian de red ------------------------------------------------------------------
  app.get('/api/netguard/overview', authUser, wrap(async (req, res) => res.json(await netGuard.overview())));

  app.get(
    '/api/netguard/locate/:mac',
    authUser,
    wrap(async (req, res) => {
      const loc = await netGuard.locateMac(req.params.mac);
      if (!loc) return res.status(400).json({ error: 'MAC inválida' });
      return res.json(loc);
    })
  );

  app.post(
    '/api/netguard/devices/:mac/approve',
    authUser,
    writer,
    wrap(async (req, res) => {
      const d = await netGuard.approveDevice(req.params.mac, typeof req.body?.note === 'string' ? req.body.note.slice(0, 200) : null);
      logAudit({ userId: req.user.sub, action: 'NETGUARD_DEVICE_APPROVE', targetType: 'NetDevice', targetId: d.mac });
      return res.json(d);
    })
  );

  app.post(
    '/api/netguard/dhcp/:ip/authorize',
    authUser,
    requireRole('ADMIN'),
    wrap(async (req, res) => {
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(req.params.ip)) return res.status(400).json({ error: 'IP inválida' });
      await netGuard.authorizeDhcp(req.params.ip);
      logAudit({ userId: req.user.sub, action: 'NETGUARD_DHCP_AUTHORIZE', targetType: 'DhcpServer', targetId: req.params.ip });
      return res.json({ ok: true });
    })
  );

  app.post(
    '/api/netguard/gateway/:serverId/accept',
    authUser,
    requireRole('ADMIN'),
    wrap(async (req, res) => {
      const s = await netGuard.acceptGateway(req.params.serverId);
      if (!s) return res.status(404).json({ error: 'Sin datos del gateway para ese servidor' });
      logAudit({ userId: req.user.sub, action: 'NETGUARD_GATEWAY_ACCEPT', targetType: 'Server', targetId: req.params.serverId, metadata: { mac: s.currentMac } });
      return res.json({ ok: true });
    })
  );

  // --- Parches por servidor ---------------------------------------------------------------
  app.get(
    '/api/patches',
    authUser,
    wrap(async (req, res) => {
      const servers = await prisma.server.findMany({ select: { id: true, name: true, status: true, diagnostics: true, diagnosticsAt: true, tags: true }, orderBy: { name: 'asc' } });
      return res.json(
        servers
          .filter((s) => !(s.tags ?? []).includes('infra-vps'))
          .map((s) => {
            const u = s.diagnostics?.updates ?? {};
            const list = Array.isArray(u.list) ? u.list : [];
            return {
              id: s.id,
              name: s.name,
              status: s.status,
              lastInstalledAt: u.lastInstalledAt ?? null,
              pending: u.pending ?? null,
              pendingCritical: u.pendingCritical ?? null,
              checkedAt: u.pendingCheckedAt ?? null,
              rebootPending: Boolean(s.diagnostics?.rebootPending),
              list,
            };
          })
      );
    })
  );

  // --- Topologia automatica -----------------------------------------------------------
  app.get('/api/topology/network', authUser, wrap(async (req, res) => res.json(await buildNetworkTopology())));
};
