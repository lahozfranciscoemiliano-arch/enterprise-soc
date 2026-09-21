require('dotenv').config();

const crypto = require('crypto');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const prisma = require('./src/prismaClient');
const authServer = require('./src/middleware/authServer');
const { authUser, requireRole } = require('./src/middleware/authUser');
const {
  telemetrySchema,
  loginSchema,
  backupStatusSchema,
  createUserSchema,
  createServerSchema,
} = require('./src/validators');
const { evaluateTelemetry, evaluateBackup, getHealthStatus } = require('./src/services/alertEngine');
const {
  createSocketServer,
  broadcastAlert,
  broadcastTelemetry,
  broadcastBackupStatus,
} = require('./src/websocket/socketServer');

const REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    throw new Error(`Falta la variable de entorno obligatoria: ${key}`);
  }
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(helmet());
app.use(
  cors({
    origin: (process.env.CORS_ORIGIN || '').split(',').filter(Boolean),
    credentials: true,
  })
);
app.use(express.json({ limit: '100kb' }));

// Limite general por IP sobre toda la API, como defensa en profundidad ante
// un JWT filtrado o abuso, ademas de los limites especificos por endpoint.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes, intenta más tarde' },
});
app.use('/api/', apiLimiter);

function generateApiKey() {
  return crypto.randomBytes(32).toString('hex');
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de inicio de sesión, intenta más tarde' },
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Credenciales inválidas' });
  }

  const { email, password } = parsed.data;

  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    }

    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    }

    const token = jwt.sign(
      { sub: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    return res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (err) {
    console.error('Error en login', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

const telemetryLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Límite de telemetría excedido' },
});

app.post('/api/telemetry', telemetryLimiter, authServer, async (req, res) => {
  const parsed = telemetrySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Payload de telemetría inválido', details: parsed.error.flatten() });
  }

  const data = parsed.data;
  const server = req.server;

  try {
    const telemetry = await prisma.telemetry.create({
      data: {
        serverId: server.id,
        cpuUsage: data.cpuUsage,
        memoryUsage: data.memoryUsage,
        diskUsage: data.diskUsage,
        networkIn: data.networkIn,
        networkOut: data.networkOut,
        processCount: data.processCount,
        metadata: data.metadata,
        recordedAt: data.recordedAt ? new Date(data.recordedAt) : undefined,
      },
    });

    await prisma.server.update({
      where: { id: server.id },
      data: { status: 'ONLINE', lastSeenAt: new Date() },
    });

    broadcastTelemetry(server, telemetry);

    const triggeredAlerts = evaluateTelemetry(server, data);
    let createdEvents = [];

    if (triggeredAlerts.length > 0) {
      createdEvents = await prisma.$transaction(
        triggeredAlerts.map((alert) =>
          prisma.securityEvent.create({
            data: {
              serverId: server.id,
              type: alert.type,
              severity: alert.severity,
              description: alert.description,
              metadata: alert.metadata,
            },
          })
        )
      );

      for (const event of createdEvents) {
        broadcastAlert({ ...event, serverName: server.name });
      }
    }

    return res.status(201).json({
      telemetryId: telemetry.id,
      alertsTriggered: createdEvents.length,
    });
  } catch (err) {
    console.error('Error procesando telemetría', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

const backupLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Límite de reportes de backup excedido' },
});

app.post('/api/backup-status', backupLimiter, authServer, async (req, res) => {
  const parsed = backupStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Payload de estado de backup inválido', details: parsed.error.flatten() });
  }

  const data = parsed.data;
  const server = req.server;

  try {
    const backup = await prisma.backupStatus.create({
      data: {
        serverId: server.id,
        result: data.result,
        method: data.method,
        lastBackupAt: data.lastBackupAt ? new Date(data.lastBackupAt) : undefined,
        targetPath: data.targetPath,
        sizeBytes: data.sizeBytes,
        vssServiceOk: data.vssServiceOk,
        detail: data.detail,
        metadata: data.metadata,
        recordedAt: data.recordedAt ? new Date(data.recordedAt) : undefined,
      },
    });

    broadcastBackupStatus(server, backup);

    const alert = evaluateBackup(server, data);
    let createdEvent = null;

    if (alert) {
      createdEvent = await prisma.securityEvent.create({
        data: {
          serverId: server.id,
          type: alert.type,
          severity: alert.severity,
          description: alert.description,
          metadata: alert.metadata,
        },
      });
      broadcastAlert({ ...createdEvent, serverName: server.name });
    }

    return res.status(201).json({
      backupStatusId: backup.id,
      alertTriggered: Boolean(createdEvent),
    });
  } catch (err) {
    console.error('Error procesando estado de backup', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get('/api/servers', authUser, async (req, res) => {
  try {
    const servers = await prisma.server.findMany({
      orderBy: { name: 'asc' },
      include: {
        telemetry: {
          orderBy: { recordedAt: 'desc' },
          take: 1,
        },
        backups: {
          orderBy: { recordedAt: 'desc' },
          take: 1,
        },
      },
    });

    return res.json(
      servers.map((s) => {
        const latest = s.telemetry[0];
        const backup = s.backups[0];
        return {
          id: s.id,
          name: s.name,
          status: s.status,
          lastSeenAt: s.lastSeenAt,
          healthStatus: getHealthStatus(latest),
          cpuUsage: latest?.cpuUsage ?? null,
          memoryUsage: latest?.memoryUsage ?? null,
          diskUsage: latest?.diskUsage ?? null,
          recordedAt: latest?.recordedAt ?? null,
          backup: backup
            ? {
                result: backup.result,
                method: backup.method,
                lastBackupAt: backup.lastBackupAt,
                targetPath: backup.targetPath,
                sizeBytes: backup.sizeBytes,
                vssServiceOk: backup.vssServiceOk,
                detail: backup.detail,
                recordedAt: backup.recordedAt,
              }
            : null,
        };
      })
    );
  } catch (err) {
    console.error('Error listando servidores', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get('/api/dashboard/summary', authUser, async (req, res) => {
  try {
    const servers = await prisma.server.findMany({
      include: {
        telemetry: {
          orderBy: { recordedAt: 'desc' },
          take: 1,
        },
        backups: {
          orderBy: { recordedAt: 'desc' },
          take: 1,
        },
      },
    });

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [telemetryToday, openAlerts, criticalAlerts] = await Promise.all([
      prisma.telemetry.count({ where: { recordedAt: { gte: startOfDay } } }),
      prisma.securityEvent.count({ where: { status: 'OPEN' } }),
      prisma.securityEvent.count({ where: { status: 'OPEN', severity: 'CRITICAL' } }),
    ]);

    const breakdown = { OK: 0, WARNING: 0, CRITICAL: 0, UNKNOWN: 0 };
    const backupBreakdown = { SUCCESS: 0, WARNING: 0, FAILED: 0, NOT_CONFIGURED: 0, UNKNOWN: 0 };
    for (const s of servers) {
      breakdown[getHealthStatus(s.telemetry[0])] += 1;
      backupBreakdown[s.backups[0]?.result ?? 'UNKNOWN'] += 1;
    }

    const reportedServers = servers.length - breakdown.UNKNOWN;
    const slaPercentage = reportedServers > 0 ? (breakdown.OK / reportedServers) * 100 : 0;

    return res.json({
      totalServers: servers.length,
      healthyServers: breakdown.OK,
      slaPercentage: Math.round(slaPercentage * 100) / 100,
      telemetryToday,
      openAlerts,
      criticalAlerts,
      healthBreakdown: breakdown,
      backupBreakdown,
    });
  } catch (err) {
    console.error('Error calculando resumen del dashboard', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get('/api/servers/:id/telemetry', authUser, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 30, 100);

  try {
    const telemetry = await prisma.telemetry.findMany({
      where: { serverId: req.params.id },
      orderBy: { recordedAt: 'desc' },
      take: limit,
    });

    return res.json(telemetry.reverse());
  } catch (err) {
    console.error('Error obteniendo telemetría', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get('/api/servers/:id/backup-status', authUser, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);

  try {
    const backups = await prisma.backupStatus.findMany({
      where: { serverId: req.params.id },
      orderBy: { recordedAt: 'desc' },
      take: limit,
    });

    return res.json(backups);
  } catch (err) {
    console.error('Error obteniendo historial de backups', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get('/api/events', authUser, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);

  try {
    const events = await prisma.securityEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { server: { select: { name: true } } },
    });

    return res.json(
      events.map((e) => ({
        id: e.id,
        type: e.type,
        severity: e.severity,
        description: e.description,
        serverName: e.server?.name,
        createdAt: e.createdAt,
      }))
    );
  } catch (err) {
    console.error('Error listando alertas', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ---------------------------------------------------------------------------
// Administracion: usuarios y servidores (solo ADMIN)
// ---------------------------------------------------------------------------

const adminWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas operaciones administrativas, intenta más tarde' },
});

app.get('/api/admin/users', authUser, requireRole('ADMIN'), async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      select: { id: true, email: true, name: true, role: true, createdAt: true },
    });
    return res.json(users);
  } catch (err) {
    console.error('Error listando usuarios', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.post('/api/admin/users', adminWriteLimiter, authUser, requireRole('ADMIN'), async (req, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Datos de usuario inválidos', details: parsed.error.flatten() });
  }

  const { email, password, name, role } = parsed.data;

  try {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ error: 'Ya existe un usuario con ese email' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: { email, passwordHash, name, role },
      select: { id: true, email: true, name: true, role: true, createdAt: true },
    });

    return res.status(201).json(user);
  } catch (err) {
    console.error('Error creando usuario', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.delete('/api/admin/users/:id', authUser, requireRole('ADMIN'), async (req, res) => {
  try {
    if (req.params.id === req.user.sub) {
      return res.status(400).json({ error: 'No podés eliminar tu propio usuario' });
    }

    const target = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!target) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    if (target.role === 'ADMIN') {
      const adminCount = await prisma.user.count({ where: { role: 'ADMIN' } });
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'No podés eliminar al último administrador' });
      }
    }

    await prisma.user.delete({ where: { id: req.params.id } });
    return res.status(204).send();
  } catch (err) {
    console.error('Error eliminando usuario', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.post('/api/admin/servers', adminWriteLimiter, authUser, requireRole('ADMIN'), async (req, res) => {
  const parsed = createServerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Datos de servidor inválidos', details: parsed.error.flatten() });
  }

  const { name, hostname, ipAddress } = parsed.data;

  try {
    const existing = await prisma.server.findUnique({ where: { name } });
    if (existing) {
      return res.status(409).json({ error: 'Ya existe un servidor con ese nombre' });
    }

    const apiKey = generateApiKey();
    const apiKeyHash = await bcrypt.hash(apiKey, 12);

    const server = await prisma.server.create({
      data: { name, hostname, ipAddress, apiKeyHash, status: 'OFFLINE' },
    });

    // La API key en texto plano solo se devuelve esta vez; despues solo se
    // guarda su hash y no se puede recuperar.
    return res.status(201).json({ id: server.id, name: server.name, apiKey });
  } catch (err) {
    console.error('Error creando servidor', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.post(
  '/api/admin/servers/:id/rotate-key',
  adminWriteLimiter,
  authUser,
  requireRole('ADMIN'),
  async (req, res) => {
    try {
      const apiKey = generateApiKey();
      const apiKeyHash = await bcrypt.hash(apiKey, 12);

      const server = await prisma.server.update({
        where: { id: req.params.id },
        data: { apiKeyHash },
      });

      return res.json({ id: server.id, name: server.name, apiKey });
    } catch (err) {
      if (err.code === 'P2025') {
        return res.status(404).json({ error: 'Servidor no encontrado' });
      }
      console.error('Error rotando API key', err);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

app.delete('/api/admin/servers/:id', authUser, requireRole('ADMIN'), async (req, res) => {
  try {
    await prisma.server.delete({ where: { id: req.params.id } });
    return res.status(204).send();
  } catch (err) {
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'Servidor no encontrado' });
    }
    console.error('Error eliminando servidor', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ---------------------------------------------------------------------------
// Auto-enrolamiento de agentes: el instalador llama este endpoint con un
// secreto compartido (AGENT_ENROLLMENT_SECRET) en vez de credenciales por
// servidor, que todavia no tiene la primera vez que se instala. Si el
// nombre ya existe, rota la API key (reinstalacion en la misma maquina).
// ---------------------------------------------------------------------------

const enrollLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de enrolamiento, intenta más tarde' },
});

app.post('/api/servers/enroll', enrollLimiter, async (req, res) => {
  if (!process.env.AGENT_ENROLLMENT_SECRET) {
    return res.status(503).json({ error: 'El enrolamiento automático no está configurado en este backend' });
  }

  const secret = req.header('x-enrollment-secret');
  if (!secret || secret !== process.env.AGENT_ENROLLMENT_SECRET) {
    return res.status(401).json({ error: 'Secreto de enrolamiento inválido' });
  }

  const parsed = createServerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Datos de enrolamiento inválidos', details: parsed.error.flatten() });
  }

  const { name, hostname, ipAddress } = parsed.data;

  try {
    const apiKey = generateApiKey();
    const apiKeyHash = await bcrypt.hash(apiKey, 12);

    const server = await prisma.server.upsert({
      where: { name },
      update: { hostname, ipAddress, apiKeyHash },
      create: { name, hostname, ipAddress, apiKeyHash, status: 'OFFLINE' },
    });

    return res.status(201).json({ serverId: server.id, apiKey });
  } catch (err) {
    console.error('Error en enrolamiento de servidor', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  console.error('Unhandled error', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

const httpServer = http.createServer(app);
createSocketServer(httpServer);

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
  console.log(`NOC/SOC backend escuchando en el puerto ${PORT}`);
});

process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  httpServer.close(() => process.exit(0));
});
