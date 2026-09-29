// Rutas del inventario de red (equipos, usuarios del AD, impresoras, mapa de
// IPs, auditoria del directorio) y de los monitores de servicios.
const rateLimit = require('express-rate-limit');
const prisma = require('../prismaClient');
const { inventorySchema, logonBatchSchema, serviceCheckSchema } = require('../validators');
const { processInventory, compressRanges, countStatuses, isInventoryCollector, purgeNonCollectorData, ingestLogons, activeSessionOf } = require('../services/inventory');
const { listServiceChecks } = require('../services/serviceMonitor');
const { logAudit } = require('../services/auditLog');

const inventoryLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Límite de reportes de inventario excedido' },
});

function csvEscape(value) {
  const str = String(value ?? '');
  return /[",\n;]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function sendCsv(res, filename, header, rows) {
  const lines = [header, ...rows].map((r) => r.map(csvEscape).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(`﻿${lines.join('\n')}\n`);
}

const iso = (d) => (d ? new Date(d).toISOString() : '');

// Sesion "actual" = ultimo inicio de sesion por usuario en los ultimos 30 dias.
async function lastLogonByUser() {
  const rows = await prisma.$queryRaw`
    SELECT DISTINCT ON (username) username, hostname, "ipAddress", at
    FROM logon_events
    WHERE at >= NOW() - INTERVAL '30 days'
    ORDER BY username, at DESC
  `;
  return new Map(rows.map((r) => [r.username, r]));
}

module.exports = function registerInventoryRoutes(app, { authUser, authServer, requireRole, adminWriteLimiter }) {
  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.error(`Error en ${req.method} ${req.path}`, err);
      if (!res.headersSent) res.status(500).json({ error: 'Error interno del servidor' });
    }
  };

  // --- Ingesta desde el agente -------------------------------------------
  app.post(
    '/api/inventory',
    inventoryLimiter,
    authServer,
    wrap(async (req, res) => {
      const parsed = inventorySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Inventario inválido', details: parsed.error.flatten() });
      }
      if (!(await isInventoryCollector(req.server, parsed.data))) {
        // El agente >= 1.4.2 deja de escanear la red al recibir esto.
        return res.json({ ok: true, ignored: true, inventoryEnabled: false, reason: 'Este servidor no es el recolector de inventario' });
      }
      await purgeNonCollectorData(req.server.id);
      const summary = await processInventory(req.server, parsed.data);
      return res.status(201).json({ ok: true, inventoryEnabled: true, summary });
    })
  );

  // Sesiones del dominio: cada controlador de dominio las manda cada minuto
  // (agente >= 1.14.0), sea o no el recolector del inventario.
  const logonLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
  app.post(
    '/api/inventory/logons',
    logonLimiter,
    authServer,
    wrap(async (req, res) => {
      const parsed = logonBatchSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Lote de sesiones inválido', details: parsed.error.flatten() });
      const result = await ingestLogons(parsed.data.logons);
      return res.json({ ok: true, ...result });
    })
  );

  // --- Consultas ------------------------------------------------------------
  app.get(
    '/api/inventory/summary',
    authUser,
    wrap(async (req, res) => {
      const staleCutoff = new Date(Date.now() - 60 * 86400000);
      const soon = new Date(Date.now() + 7 * 86400000);
      const [reporters, endpointsTotal, endpointsOnline, endpointsStale, printers, users, lockedUsers, expiring, scopes] = await Promise.all([
        prisma.server.findMany({ where: { inventoryAt: { not: null } }, select: { id: true, name: true, inventoryAt: true, inventorySummary: true } }),
        prisma.endpoint.count(),
        prisma.endpoint.count({ where: { online: true } }),
        prisma.endpoint.count({ where: { enabled: true, OR: [{ adLastLogonAt: null }, { adLastLogonAt: { lt: staleCutoff } }] } }),
        prisma.printer.findMany({ select: { online: true, errors: true, supplies: true } }),
        prisma.directoryUser.count({ where: { enabled: true } }),
        prisma.directoryUser.count({ where: { enabled: true, lockedOut: true } }),
        prisma.directoryUser.count({ where: { enabled: true, neverExpires: false, passwordExpiresAt: { gte: new Date(), lte: soon } } }),
        prisma.dhcpScope.findMany({ select: { addresses: true, percentInUse: true } }),
      ]);
      let freeDhcp = 0;
      let freeStatic = 0;
      let conflicts = 0;
      for (const s of scopes) {
        const c = countStatuses(s.addresses ?? []);
        freeDhcp += c.free;
        freeStatic += c['free-static'];
        conflicts += c.conflict;
      }
      return res.json({
        reporters,
        endpoints: { total: endpointsTotal, online: endpointsOnline, stale: endpointsStale },
        printers: {
          total: printers.length,
          online: printers.filter((p) => p.online).length,
          withIssues: printers.filter((p) => !p.online || p.errors.length > 0).length,
          lowSupplies: printers.filter((p) => (Array.isArray(p.supplies) ? p.supplies : []).some((s) => s.percent !== null && s.percent <= 15)).length,
        },
        users: { enabled: users, locked: lockedUsers, passwordExpiringSoon: expiring },
        ips: { scopes: scopes.length, freeDhcp, freeStatic, conflicts, maxScopeUsage: Math.max(0, ...scopes.map((s) => s.percentInUse)) },
      });
    })
  );

  app.get(
    '/api/inventory/endpoints',
    authUser,
    wrap(async (req, res) => {
      const endpoints = await prisma.endpoint.findMany({ orderBy: { hostname: 'asc' } });
      return res.json(endpoints.map((e) => ({ ...e, activeUser: activeSessionOf(e) })));
    })
  );

  app.get(
    '/api/inventory/endpoints/:id/logons',
    authUser,
    wrap(async (req, res) => {
      const endpoint = await prisma.endpoint.findUnique({ where: { id: req.params.id } });
      if (!endpoint) return res.status(404).json({ error: 'Equipo no encontrado' });
      const logons = await prisma.logonEvent.findMany({ where: { hostname: endpoint.hostname }, orderBy: { at: 'desc' }, take: 50 });
      return res.json(logons);
    })
  );

  app.get(
    '/api/inventory/users',
    authUser,
    wrap(async (req, res) => {
      const [users, last] = await Promise.all([prisma.directoryUser.findMany({ orderBy: { sam: 'asc' } }), lastLogonByUser()]);
      return res.json(
        users.map((u) => {
          const l = last.get(u.sam);
          return { ...u, lastHost: l?.hostname ?? null, lastHostIp: l?.ipAddress ?? null, lastHostAt: l?.at ?? null };
        })
      );
    })
  );

  app.get(
    '/api/inventory/users/:sam/logons',
    authUser,
    wrap(async (req, res) => {
      const logons = await prisma.logonEvent.findMany({
        where: { username: String(req.params.sam).toLowerCase() },
        orderBy: { at: 'desc' },
        take: 50,
      });
      return res.json(logons);
    })
  );

  app.get(
    '/api/inventory/printers',
    authUser,
    wrap(async (req, res) => {
      const printers = await prisma.printer.findMany({ orderBy: [{ online: 'asc' }, { name: 'asc' }] });
      return res.json(printers);
    })
  );

  app.delete(
    '/api/inventory/printers/:id',
    authUser,
    requireRole('ADMIN', 'ANALYST'),
    wrap(async (req, res) => {
      const p = await prisma.printer.findUnique({ where: { id: req.params.id } });
      if (!p) return res.status(404).json({ error: 'Impresora no encontrada' });
      await prisma.printer.delete({ where: { id: p.id } });
      await prisma.securityEvent.updateMany({
        where: { dedupKey: `PRINTER:${p.id}`, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
        data: { status: 'RESOLVED', resolvedAt: new Date(), autoResolved: true },
      });
      logAudit({ userId: req.user.sub, action: 'PRINTER_DELETE', targetType: 'Printer', targetId: p.id, metadata: { name: p.name } });
      return res.json({ ok: true });
    })
  );

  app.get(
    '/api/inventory/scopes',
    authUser,
    wrap(async (req, res) => {
      const scopes = await prisma.dhcpScope.findMany({ orderBy: { id: 'asc' } });
      return res.json(
        scopes.map((s) => {
          const addresses = Array.isArray(s.addresses) ? s.addresses : [];
          return {
            ...s,
            counts: countStatuses(addresses),
            freeRanges: compressRanges(addresses.filter((a) => a.s === 'free').map((a) => a.ip)),
            freeStaticRanges: compressRanges(addresses.filter((a) => a.s === 'free-static').map((a) => a.ip)),
          };
        })
      );
    })
  );

  app.get(
    '/api/inventory/directory-events',
    authUser,
    wrap(async (req, res) => {
      const limit = Math.min(Number(req.query.limit) || 200, 1000);
      const events = await prisma.directoryEvent.findMany({ orderBy: { at: 'desc' }, take: limit });
      return res.json(events);
    })
  );

  app.get(
    '/api/inventory/logons',
    authUser,
    wrap(async (req, res) => {
      const limit = Math.min(Number(req.query.limit) || 200, 1000);
      const logons = await prisma.logonEvent.findMany({ orderBy: { at: 'desc' }, take: limit });
      return res.json(logons);
    })
  );

  // --- Exportes CSV (para Excel) ---------------------------------------------
  app.get(
    '/api/inventory/export/:kind.csv',
    authUser,
    wrap(async (req, res) => {
      const stamp = new Date().toISOString().slice(0, 10);
      switch (req.params.kind) {
        case 'equipos': {
          const rows = await prisma.endpoint.findMany({ orderBy: { hostname: 'asc' } });
          return sendCsv(
            res,
            `equipos-${stamp}.csv`,
            ['equipo', 'ip', 'mac', 'encendido', 'ultimo_usuario', 'ultimo_inicio_sesion', 'sistema_operativo', 'version', 'habilitado_ad', 'ultimo_logon_ad', 'visto_encendido', 'ou'],
            rows.map((e) => [e.hostname, e.ipAddress, e.macAddress, e.online ? 'si' : 'no', e.lastUser, iso(e.lastUserAt), e.os, e.osVersion, e.enabled ? 'si' : 'no', iso(e.adLastLogonAt), iso(e.lastSeenOnlineAt), e.ou])
          );
        }
        case 'usuarios': {
          const [users, last] = await Promise.all([prisma.directoryUser.findMany({ orderBy: { sam: 'asc' } }), lastLogonByUser()]);
          return sendCsv(
            res,
            `usuarios-ad-${stamp}.csv`,
            ['usuario', 'nombre', 'departamento', 'cargo', 'email', 'habilitado', 'bloqueado', 'vence_contrasena', 'ultimo_logon_ad', 'ultimo_equipo', 'ultimo_equipo_fecha'],
            users.map((u) => {
              const l = last.get(u.sam);
              return [u.sam, u.displayName, u.department, u.title, u.email, u.enabled ? 'si' : 'no', u.lockedOut ? 'si' : 'no', u.neverExpires ? 'nunca' : iso(u.passwordExpiresAt), iso(u.lastLogonAt), l?.hostname, iso(l?.at)];
            })
          );
        }
        case 'impresoras': {
          const rows = await prisma.printer.findMany({ orderBy: { id: 'asc' } });
          return sendCsv(
            res,
            `impresoras-${stamp}.csv`,
            ['ip', 'nombre', 'modelo', 'serie', 'ubicacion', 'en_linea', 'estado', 'errores', 'consumibles', 'contador_paginas'],
            rows.map((p) => [
              p.id,
              p.name,
              p.model,
              p.serial,
              p.location,
              p.online ? 'si' : 'no',
              p.status,
              p.errors.join(' | '),
              (Array.isArray(p.supplies) ? p.supplies : []).map((s) => `${s.name}: ${s.percent ?? '?'}%`).join(' | '),
              p.pageCount,
            ])
          );
        }
        case 'ips': {
          const scopes = await prisma.dhcpScope.findMany({ orderBy: { id: 'asc' } });
          const rows = [];
          for (const s of scopes) {
            for (const a of Array.isArray(s.addresses) ? s.addresses : []) {
              rows.push([s.id, s.name, a.ip, a.s, a.h, a.m, a.u, a.a ? 'si' : 'no']);
            }
          }
          return sendCsv(res, `mapa-ips-${stamp}.csv`, ['ambito', 'nombre_ambito', 'ip', 'estado', 'equipo', 'mac', 'usuario', 'responde'], rows);
        }
        default:
          return res.status(404).json({ error: 'Exporte desconocido' });
      }
    })
  );

  // --- Monitores de servicios ------------------------------------------------
  app.get(
    '/api/service-checks',
    authUser,
    wrap(async (req, res) => res.json(await listServiceChecks()))
  );

  app.post(
    '/api/admin/service-checks',
    adminWriteLimiter,
    authUser,
    requireRole('ADMIN'),
    wrap(async (req, res) => {
      const parsed = serviceCheckSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Datos inválidos' });
      const check = await prisma.serviceCheck.create({ data: parsed.data });
      logAudit({ userId: req.user.sub, action: 'SERVICE_CHECK_CREATE', targetType: 'ServiceCheck', targetId: check.id, metadata: { name: check.name, target: check.target } });
      return res.status(201).json(check);
    })
  );

  app.patch(
    '/api/admin/service-checks/:id',
    adminWriteLimiter,
    authUser,
    requireRole('ADMIN'),
    wrap(async (req, res) => {
      const existing = await prisma.serviceCheck.findUnique({ where: { id: req.params.id } });
      if (!existing) return res.status(404).json({ error: 'Monitor no encontrado' });
      const parsed = serviceCheckSchema.safeParse({
        name: existing.name,
        type: existing.type,
        target: existing.target,
        intervalSeconds: existing.intervalSeconds,
        timeoutMs: existing.timeoutMs,
        expectedStatus: existing.expectedStatus,
        keyword: existing.keyword,
        enabled: existing.enabled,
        ...req.body,
      });
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Datos inválidos' });
      const check = await prisma.serviceCheck.update({
        where: { id: existing.id },
        data: { ...parsed.data, ...(parsed.data.target !== existing.target ? { status: 'unknown', consecutiveFailures: 0, certExpiresAt: null } : {}) },
      });
      logAudit({ userId: req.user.sub, action: 'SERVICE_CHECK_UPDATE', targetType: 'ServiceCheck', targetId: check.id });
      return res.json(check);
    })
  );

  app.delete(
    '/api/admin/service-checks/:id',
    adminWriteLimiter,
    authUser,
    requireRole('ADMIN'),
    wrap(async (req, res) => {
      await prisma.serviceCheck.delete({ where: { id: req.params.id } }).catch(() => null);
      logAudit({ userId: req.user.sub, action: 'SERVICE_CHECK_DELETE', targetType: 'ServiceCheck', targetId: req.params.id });
      return res.status(204).end();
    })
  );
};
