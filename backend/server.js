require('dotenv').config();

const http = require('http');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const prisma = require('./src/prismaClient');
const authServer = require('./src/middleware/authServer');
const authUser = require('./src/middleware/authUser');
const { telemetrySchema, loginSchema } = require('./src/validators');
const { evaluateTelemetry } = require('./src/services/alertEngine');
const { createSocketServer, broadcastAlert, broadcastTelemetry } = require('./src/websocket/socketServer');

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

    return res.json({ token, user: { id: user.id, name: user.name, role: user.role } });
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

app.get('/api/servers', authUser, async (req, res) => {
  try {
    const servers = await prisma.server.findMany({
      orderBy: { name: 'asc' },
      include: {
        telemetry: {
          orderBy: { recordedAt: 'desc' },
          take: 1,
        },
      },
    });

    return res.json(
      servers.map((s) => {
        const latest = s.telemetry[0];
        return {
          id: s.id,
          name: s.name,
          status: s.status,
          lastSeenAt: s.lastSeenAt,
          cpuUsage: latest?.cpuUsage ?? null,
          memoryUsage: latest?.memoryUsage ?? null,
          diskUsage: latest?.diskUsage ?? null,
          recordedAt: latest?.recordedAt ?? null,
        };
      })
    );
  } catch (err) {
    console.error('Error listando servidores', err);
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
