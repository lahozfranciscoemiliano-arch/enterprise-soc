// Parque de servidores: ficha tecnica de cada servidor (lo que detecta el
// agente + lo que se carga a mano) y su foto propia opcional.
const { z } = require('zod');
const prisma = require('../prismaClient');
const { withLatest } = require('../services/latest');
const { logAudit } = require('../services/auditLog');

const FORM_FACTORS = ['rack1u', 'rack2u', 'rack4u', 'tower', 'blade', 'vm', 'desktop', 'mini', 'nas', 'laptop'];
const str = (max) => z.string().trim().max(max).nullable().optional();
const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (AAAA-MM-DD)')
  .nullable()
  .optional()
  .or(z.literal('').transform(() => null));

const assetSchema = z
  .object({
    brand: str(80),
    model: str(120),
    serial: str(80),
    assetTag: str(80),
    formFactor: z.enum(FORM_FACTORS).nullable().optional(),
    cpu: str(160),
    ramGb: z.number().min(0).max(65536).nullable().optional(),
    storage: str(300),
    raid: str(120),
    psu: str(120),
    os: str(120),
    role: str(200),
    location: str(200),
    rack: str(80),
    purchaseDate: dateStr,
    warrantyUntil: dateStr,
    supplier: str(120),
    supportContact: str(200),
    notes: str(4000),
  })
  .strict();

const PHOTO_MAX_BYTES = 1.5 * 1024 * 1024;
const PHOTO_RE = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/;

module.exports = function registerAssetRoutes(app, { authUser, requireRole }) {
  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.error(`Error en ${req.method} ${req.path}`, err);
      if (!res.headersSent) res.status(500).json({ error: 'Error interno del servidor' });
    }
  };

  app.get(
    '/api/assets',
    authUser,
    wrap(async (req, res) => {
      const [servers, photos] = await Promise.all([
        prisma.server.findMany({
          orderBy: { name: 'asc' },
          select: {
            id: true,
            name: true,
            hostname: true,
            ipAddress: true,
            status: true,
            lastSeenAt: true,
            agentVersion: true,
            tags: true,
            diagnostics: true,
            diagnosticsAt: true,
            assetInfo: true,
            siteNotes: true,
            createdAt: true,
          },
        }),
        prisma.serverPhoto.findMany({ select: { serverId: true, updatedAt: true } }),
      ]);
      const withTel = await withLatest(servers, { backups: false });
      const photoAt = new Map(photos.map((p) => [p.serverId, p.updatedAt]));
      return res.json(
        withTel.map((s) => {
          const d = s.diagnostics ?? {};
          const t = s.telemetry?.[0];
          return {
            id: s.id,
            name: s.name,
            hostname: s.hostname,
            ipAddress: s.ipAddress,
            status: s.status,
            lastSeenAt: s.lastSeenAt,
            agentVersion: s.agentVersion,
            tags: s.tags,
            createdAt: s.createdAt,
            hardware: d.hardware ?? null,
            hardwareAt: s.diagnosticsAt,
            uptimeSeconds: d.uptimeSeconds ?? null,
            lastBootAt: d.lastBootAt ?? null,
            volumes: d.volumes ?? [],
            physicalDisks: d.physicalDisks ?? [],
            cpuUsage: t?.cpuUsage ?? null,
            memoryUsage: t?.memoryUsage ?? null,
            diskUsage: t?.diskUsage ?? null,
            asset: s.assetInfo ?? {},
            photoAt: photoAt.get(s.id) ?? null,
          };
        })
      );
    })
  );

  app.put(
    '/api/assets/:id',
    authUser,
    requireRole('ADMIN'),
    wrap(async (req, res) => {
      const parsed = assetSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Datos inválidos' });
      // Vacios -> se borran (vuelve a mostrarse lo detectado por el agente).
      const clean = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== null && v !== undefined && v !== ''));
      const server = await prisma.server.update({ where: { id: req.params.id }, data: { assetInfo: clean }, select: { id: true, assetInfo: true } });
      logAudit({ userId: req.user.sub, action: 'SERVER_ASSET_UPDATE', targetType: 'Server', targetId: server.id, metadata: { fields: Object.keys(clean) } });
      return res.json(server);
    })
  );

  app.get(
    '/api/assets/:id/photo',
    authUser,
    wrap(async (req, res) => {
      const photo = await prisma.serverPhoto.findUnique({ where: { serverId: req.params.id } });
      if (!photo) return res.status(404).json({ error: 'Sin foto' });
      res.setHeader('Content-Type', photo.mime);
      res.setHeader('Cache-Control', 'private, max-age=86400');
      return res.send(Buffer.from(photo.data));
    })
  );

  app.put(
    '/api/assets/:id/photo',
    authUser,
    requireRole('ADMIN'),
    wrap(async (req, res) => {
      const m = PHOTO_RE.exec(String(req.body?.dataUrl ?? ''));
      if (!m) return res.status(400).json({ error: 'Imagen inválida: PNG, JPG o WEBP' });
      const data = Buffer.from(m[2], 'base64');
      if (data.length > PHOTO_MAX_BYTES) return res.status(413).json({ error: 'La imagen supera 1,5 MB' });
      const exists = await prisma.server.findUnique({ where: { id: req.params.id }, select: { id: true } });
      if (!exists) return res.status(404).json({ error: 'Servidor no encontrado' });
      await prisma.serverPhoto.upsert({ where: { serverId: req.params.id }, create: { serverId: req.params.id, mime: m[1], data }, update: { mime: m[1], data } });
      logAudit({ userId: req.user.sub, action: 'SERVER_PHOTO_UPDATE', targetType: 'Server', targetId: req.params.id });
      return res.json({ ok: true });
    })
  );

  app.delete(
    '/api/assets/:id/photo',
    authUser,
    requireRole('ADMIN'),
    wrap(async (req, res) => {
      await prisma.serverPhoto.deleteMany({ where: { serverId: req.params.id } });
      logAudit({ userId: req.user.sub, action: 'SERVER_PHOTO_DELETE', targetType: 'Server', targetId: req.params.id });
      return res.json({ ok: true });
    })
  );
};
