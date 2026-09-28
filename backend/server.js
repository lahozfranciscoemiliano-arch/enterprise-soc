require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { monitorEventLoopDelay } = require('perf_hooks');
const express = require('express');
const { z } = require('zod');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const prisma = require('./src/prismaClient');
const { withLatest } = require('./src/services/latest');
const authServer = require('./src/middleware/authServer');
const authFortiDevice = require('./src/middleware/authFortiDevice');
const { authUser, requireRole, SESSION_COOKIE_NAME } = require('./src/middleware/authUser');
const { csrfGuard } = require('./src/middleware/csrfGuard');
const {
  telemetrySchema,
  loginSchema,
  backupStatusSchema,
  createUserSchema,
  createServerSchema,
  updateEventStatusSchema,
  updateThresholdsSchema,
  updateMaintenanceSchema,
  login2faSchema,
  twoFactorCodeSchema,
  disable2faSchema,
  settingsSchema,
  createFortiDeviceSchema,
  fortiEventIngestSchema,
  updateServerTagsSchema,
  assistantChatSchema,
  playbookSchema,
  naturalLanguageFilterSchema,
  fortiScreenshotSchema,
  ingestReviewedFortiEventsSchema,
  siteInfoSchema,
} = require('./src/validators');
const {
  evaluateTelemetry,
  evaluateBackup,
  getHealthStatus,
  isInMaintenance,
  getEffectiveDefaultThresholds,
  TELEMETRY_MANAGED_KEYS,
  BACKUP_MANAGED_KEYS,
} = require('./src/services/alertEngine');
const { logAudit } = require('./src/services/auditLog');
const { notifyGeneric, sendReportEmail } = require('./src/services/notifications');
const { buildBackupHistory } = require('./src/services/backupHistory');
const { loadBackupPolicy, backupMode, normalizeBackupReport } = require('./src/services/backupPolicy');
const { processAgentExtras, summarizeNetwork } = require('./src/services/preventiveChecks');
const { getDiskForecast, scheduleDiskForecast } = require('./src/services/diskForecast');
const registerInventoryRoutes = require('./src/routes/inventory');
const { scheduleServiceMonitor } = require('./src/services/serviceMonitor');
const { seedMissingPlaybooks } = require('./src/services/recommendations');
const unifiLocal = require('./src/services/unifiLocal');
const appMonitor = require('./src/services/appMonitor');
const { runUnifiPoll, listUnifiDevices, listUnifiSites, getLastRun: getUnifiLastRun, scheduleUnifiPoll } = require('./src/services/unifi');
const { createAndDispatchEvent, resolveCleared, defaultDedupKey, toClientEvent } = require('./src/services/eventPipeline');
const { getSetting, getPublicSettings, setSettings } = require('./src/services/settings');
const { ingestFortiEvent } = require('./src/services/fortinet');
const {
  askGemini,
  analyzeEventLogErrors,
  filterEventsByNaturalLanguage,
  analyzeFortiScreenshot,
} = require('./src/services/gemini');
const { createSession, revokeSession, revokeAllUserSessions } = require('./src/services/sessions');
const {
  generateSecret,
  generateQrCodeDataUrl,
  verifyToken: verifyTotpToken,
  generateBackupCodes,
  hashBackupCodes,
  findBackupCodeIndex,
} = require('./src/services/twoFactor');
const {
  createSocketServer,
  broadcastAlertUpdate,
  broadcastTelemetry,
  broadcastBackupStatus,
} = require('./src/websocket/socketServer');
const { startFortiSyslogListener } = require('./src/services/fortiSyslog');
const { runHousekeeping, getLastRun: getHousekeepingLastRun, scheduleHousekeeping } = require('./src/services/housekeeping');
const { runHeartbeatCheck, getLastRun: getHeartbeatLastRun, scheduleHeartbeat } = require('./src/services/heartbeat');
const { scheduleProactiveDigest } = require('./src/services/proactiveDigest');
const { evaluateAnomalies, getBaselineStatus, scheduleAnomalyBaselineRefresh } = require('./src/services/anomalyDetection');
const { generateAndStoreReport, generateReportCsv, listReports, getReportPath, scheduleReports } = require('./src/services/reports');
const {
  runSyntheticChecks,
  getLastRun: getSyntheticMonitorLastRun,
  scheduleSyntheticMonitor,
} = require('./src/services/syntheticMonitor');

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
// 5mb (no 100kb) porque POST /api/admin/forti-devices/analyze-screenshot
// manda una captura de pantalla en base64; el resto de los endpoints usan
// payloads de unos pocos KB como mucho, asi que el limite mas alto no
// cambia la superficie de ataque real (solo ADMIN autenticado llega a esa
// ruta, y el rate limiter de esa ruta especifica es mas estricto).
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

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
// La sesion ahora vive en una cookie httpOnly (nunca visible para JS ni
// robable por un XSS); esto la protege del otro lado: bloquea escrituras
// disparadas desde un origen distinto al del propio dashboard.
app.use('/api/', csrfGuard);

// "Secure" tiene que reflejar si ESTA request en particular llego por HTTPS,
// no si NODE_ENV es "production" -- son cosas distintas. Con NODE_ENV fijo
// en "production" (docker-compose.yml) pero el VPS sirviendo todavia por
// HTTP plano (sin dominio/TLS configurado aun), una cookie marcada Secure
// nunca la guarda el navegador y el login queda en loop infinito.
// req.secure ya refleja esto bien: Express lo calcula solo a partir del
// header X-Forwarded-Proto que Nginx manda ($scheme, ver deploy/nginx.conf),
// confiando en el proxy por "trust proxy" (arriba). Asi que esto se
// autocorrige solo el dia que se agregue el dominio + certbot, sin tocar
// nada aca.
function setSessionCookie(req, res, token, expiresAt) {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: req.secure,
    sameSite: 'strict',
    path: '/',
    expires: expiresAt,
  });
}

function clearSessionCookie(req, res) {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: req.secure,
    sameSite: 'strict',
    path: '/',
  });
}

async function issueSession(req, res, user) {
  const { jti, expiresAt } = await createSession({
    userId: user.id,
    userAgent: req.header('user-agent'),
    ip: req.ip,
  });

  const token = jwt.sign(
    { sub: user.id, role: user.role, jti },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );

  setSessionCookie(req, res, token, expiresAt);

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    twoFactorEnabled: user.twoFactorEnabled,
  };
}

function generateApiKey() {
  return crypto.randomBytes(32).toString('hex');
}

// Salud del proceso: ademas de "vivo", cuanto se demora el event loop
// (si pasa de ~200 ms algo esta saturando el backend) y la memoria.
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();
app.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    eventLoopDelayMs: Math.round(eventLoopDelay.percentile(99) / 1e6),
    rssMb: Math.round(mem.rss / 1048576),
    heapUsedMb: Math.round(mem.heapUsed / 1048576),
  });
  eventLoopDelay.reset();
});

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

    if (user.twoFactorEnabled) {
      // Token de un solo proposito: nunca lleva "jti", asi que authUser lo
      // rechaza automaticamente para cualquier endpoint protegido. Solo
      // sirve para probar el segundo factor en /api/auth/login/2fa.
      const tempToken = jwt.sign({ sub: user.id, purpose: '2fa' }, process.env.JWT_SECRET, { expiresIn: '5m' });
      return res.json({ requires2FA: true, tempToken });
    }

    const safeUser = await issueSession(req, res, user);
    logAudit({ userId: user.id, action: 'LOGIN', targetType: 'User', targetId: user.id });

    return res.json({ user: safeUser });
  } catch (err) {
    console.error('Error en login', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

const twoFaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos, intenta más tarde' },
});

app.post('/api/auth/login/2fa', twoFaLimiter, async (req, res) => {
  const parsed = login2faSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Datos inválidos' });
  }

  const { tempToken, code } = parsed.data;

  let payload;
  try {
    payload = jwt.verify(tempToken, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'La verificación expiró, iniciá sesión de nuevo' });
  }

  if (payload.purpose !== '2fa' || payload.jti) {
    return res.status(401).json({ error: 'Token inválido' });
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.twoFactorEnabled) {
      return res.status(401).json({ error: 'Token inválido' });
    }

    const validTotp = verifyTotpToken(user.twoFactorSecret, code);
    let backupCodeIndex = -1;
    if (!validTotp) {
      backupCodeIndex = await findBackupCodeIndex(code, user.twoFactorBackupCodes);
    }

    if (!validTotp && backupCodeIndex === -1) {
      logAudit({ userId: user.id, action: '2FA_LOGIN_FAILED', targetType: 'User', targetId: user.id });
      return res.status(401).json({ error: 'Código de verificación incorrecto' });
    }

    if (backupCodeIndex !== -1) {
      const remaining = user.twoFactorBackupCodes.filter((_, i) => i !== backupCodeIndex);
      await prisma.user.update({ where: { id: user.id }, data: { twoFactorBackupCodes: remaining } });
      logAudit({ userId: user.id, action: '2FA_BACKUP_CODE_USED', targetType: 'User', targetId: user.id });
    }

    const safeUser = await issueSession(req, res, user);
    logAudit({ userId: user.id, action: 'LOGIN', targetType: 'User', targetId: user.id });

    return res.json({ user: safeUser });
  } catch (err) {
    console.error('Error verificando 2FA', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.post('/api/auth/logout', authUser, async (req, res) => {
  await revokeSession(req.user.jti);
  clearSessionCookie(req, res);
  return res.status(204).send();
});

app.post('/api/auth/logout-all', authUser, async (req, res) => {
  await revokeAllUserSessions(req.user.sub);
  clearSessionCookie(req, res);
  logAudit({ userId: req.user.sub, action: 'LOGOUT_ALL_DEVICES', targetType: 'User', targetId: req.user.sub });
  return res.status(204).send();
});

app.get('/api/auth/me', authUser, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    if (!user) return res.status(401).json({ error: 'No autenticado' });
    return res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      twoFactorEnabled: user.twoFactorEnabled,
    });
  } catch (err) {
    console.error('Error obteniendo usuario actual', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ---------------------------------------------------------------------------
// 2FA (TOTP): activacion, confirmacion y desactivacion. El login en si vive
// arriba (/api/auth/login y /api/auth/login/2fa); esto es la configuracion
// que hace cada usuario sobre su propia cuenta.
// ---------------------------------------------------------------------------

app.post('/api/auth/2fa/setup', authUser, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    if (user.twoFactorEnabled) {
      return res.status(400).json({ error: 'El 2FA ya está activado en esta cuenta' });
    }

    const { secret, otpauthUrl } = generateSecret(user.email);
    await prisma.user.update({ where: { id: user.id }, data: { twoFactorSecret: secret } });

    const qrCodeDataUrl = await generateQrCodeDataUrl(otpauthUrl);

    return res.json({ secret, qrCodeDataUrl });
  } catch (err) {
    console.error('Error iniciando configuración de 2FA', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.post('/api/auth/2fa/verify-setup', twoFaLimiter, authUser, async (req, res) => {
  const parsed = twoFactorCodeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Código inválido' });
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    if (!user.twoFactorSecret) {
      return res.status(400).json({ error: 'Primero generá el código QR' });
    }

    if (!verifyTotpToken(user.twoFactorSecret, parsed.data.code)) {
      return res.status(401).json({ error: 'Código incorrecto' });
    }

    const backupCodes = generateBackupCodes();
    const hashed = await hashBackupCodes(backupCodes);

    await prisma.user.update({
      where: { id: user.id },
      data: { twoFactorEnabled: true, twoFactorBackupCodes: hashed },
    });

    logAudit({ userId: user.id, action: '2FA_ENABLED', targetType: 'User', targetId: user.id });

    // Los codigos de respaldo en texto plano solo se muestran esta vez.
    return res.json({ backupCodes });
  } catch (err) {
    console.error('Error confirmando 2FA', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.post('/api/auth/2fa/disable', twoFaLimiter, authUser, async (req, res) => {
  const parsed = disable2faSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Datos inválidos' });
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    if (!user.twoFactorEnabled) {
      return res.status(400).json({ error: 'El 2FA no está activado' });
    }

    const validPassword = await bcrypt.compare(parsed.data.password, user.passwordHash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }

    const validTotp = verifyTotpToken(user.twoFactorSecret, parsed.data.code);
    let backupCodeIndex = -1;
    if (!validTotp) {
      backupCodeIndex = await findBackupCodeIndex(parsed.data.code, user.twoFactorBackupCodes);
    }
    if (!validTotp && backupCodeIndex === -1) {
      return res.status(401).json({ error: 'Código de verificación incorrecto' });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { twoFactorEnabled: false, twoFactorSecret: null, twoFactorBackupCodes: [] },
    });

    logAudit({ userId: user.id, action: '2FA_DISABLED', targetType: 'User', targetId: user.id });

    return res.status(204).send();
  } catch (err) {
    console.error('Error desactivando 2FA', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ---------------------------------------------------------------------------
// Descarga del agente compilado: el backend sirve el .exe mas reciente para
// que install-agent.ps1 lo pueda bajar solo, sin copiarlo a mano en cada
// servidor nuevo. Reemplazar el archivo en DOWNLOADS_DIR al compilar una
// version nueva del agente (ver agent/agent.py para el comando de PyInstaller).
// ---------------------------------------------------------------------------

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');

const downloadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas descargas, intenta más tarde' },
});

app.get('/downloads/enterprise-soc-agent.exe', downloadLimiter, (req, res) => {
  const filePath = path.join(DOWNLOADS_DIR, 'enterprise-soc-agent.exe');

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Todavía no se publicó ningún build del agente en este backend' });
  }

  return res.download(filePath, 'enterprise-soc-agent.exe');
});

// Instalador del agente (lo publica deploy/vps-update.sh en la carpeta de
// descargas junto al .exe). Permite instalar un servidor nuevo con un solo
// comando de PowerShell, sin copiar archivos a mano:
//   iwr <NOC>/downloads/install-agent.ps1 ... ; & $s -BackendUrl ... -EnrollmentSecret ...
app.get('/downloads/install-agent.ps1', downloadLimiter, (req, res) => {
  const filePath = path.join(DOWNLOADS_DIR, 'install-agent.ps1');

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'El instalador todavía no se publicó: correr deploy/vps-update.sh en la VPS' });
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  return res.download(filePath, 'install-agent.ps1');
});

const telemetryLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Límite de telemetría excedido' },
});

// Lo que se guarda en cada fila de telemetria: los errores del Visor de
// Eventos (los usa el analisis con IA) y, de la red, solo los 3 numeros que
// se grafican. El diagnostico completo (~10 KB) va al servidor, no a cada
// fila -- si no, la tabla crece decenas de MB por dia.
// Errores recientes del Visor de Eventos: solo se usa la ULTIMA lista (boton
// "Analizar con IA" del detalle del servidor), asi que se guarda en memoria y
// no en cada fila de telemetria (1 por minuto por servidor inflaba la tabla).
const latestEventLogErrors = new Map(); // serverId -> errores

function slimTelemetryMetadata(metadata) {
  if (!metadata) return metadata;
  const { diagnostics, network, recentEventLogErrors, ...rest } = metadata;
  if (network) {
    rest.network = {
      internetUp: network.internetUp ?? null,
      latencyMs: network.internetLatencyMs ?? null,
      lossPct: network.internetLossPct ?? null,
    };
  }
  return rest;
}

app.post('/api/telemetry', telemetryLimiter, authServer, async (req, res) => {
  const parsed = telemetrySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Payload de telemetría inválido', details: parsed.error.flatten() });
  }

  const data = parsed.data;
  const server = req.server;
  if (Array.isArray(data.metadata?.recentEventLogErrors)) latestEventLogErrors.set(server.id, data.metadata.recentEventLogErrors);

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
        metadata: slimTelemetryMetadata(data.metadata),
        recordedAt: data.recordedAt ? new Date(data.recordedAt) : undefined,
      },
    });

    await prisma.server.update({
      where: { id: server.id },
      data: {
        status: 'ONLINE',
        lastSeenAt: new Date(),
        ...(data.agentVersion ? { agentVersion: data.agentVersion } : {}),
      },
    });

    broadcastTelemetry(server, telemetry);

    // Diagnostico preventivo y estado de red (agente >= 1.3.0): se guarda el
    // ultimo en el servidor y se evaluan sus reglas. Nunca rompe la ingesta.
    processAgentExtras(server, data.metadata).catch((err) =>
      console.error(`Error procesando diagnóstico/red de ${server.name}`, err)
    );

    const defaultThresholds = await getEffectiveDefaultThresholds();
    const triggeredAlerts = evaluateTelemetry(server, data, defaultThresholds);

    // Anomalias estadisticas (services/anomalyDetection.js): se evaluan
    // ademas de los umbrales fijos de arriba, pero no para el mismo campo
    // que ya disparo un umbral fijo en esta misma telemetria -- evitar que
    // un pico de CPU se reporte dos veces como CPU_THRESHOLD y ANOMALY_DETECTED.
    const fieldsAlreadyAlerted = new Set(
      triggeredAlerts.filter((a) => a.metadata?.field).map((a) => a.metadata.field)
    );
    const anomalyAlerts = isInMaintenance(server)
      ? []
      : evaluateAnomalies(server, { ...data, recordedAt: telemetry.recordedAt }, fieldsAlreadyAlerted);

    const allAlerts = [...triggeredAlerts, ...anomalyAlerts];
    const results = await Promise.all(
      allAlerts.map((alert) =>
        createAndDispatchEvent({
          serverId: server.id,
          serverName: server.name,
          type: alert.type,
          severity: alert.severity,
          description: alert.description,
          metadata: alert.metadata,
          dedupKey: alert.dedupKey,
          // Anti-fatiga: un pico de CPU/RAM de un minuto no es un incidente;
          // se alerta solo si sigue en 3 telemetrias seguidas (~3 min). El
          // disco no tiene picos: alerta enseguida.
          confirmations: alert.type === 'DISK_THRESHOLD' ? 1 : 3,
        })
      )
    );

    // Lo que ya no se detecta en esta telemetria se normalizo: se cierra
    // solo. Y si el servidor esta reportando, ya no esta "caido".
    await resolveCleared(
      server.id,
      [...TELEMETRY_MANAGED_KEYS, 'AGENT_OFFLINE'],
      allAlerts.map((a) => a.dedupKey ?? defaultDedupKey(a.type, a.metadata)),
      server.name
    );
    const createdEvents = results.filter((r) => r.isNew);

    const latestAgentVersion = await getSetting('AGENT_LATEST_VERSION');

    return res.status(201).json({
      telemetryId: telemetry.id,
      alertsTriggered: createdEvents.length,
      // El agente compara esto contra su propia version (--version) para
      // saber si tiene que actualizarse solo (ver agent.py: check_for_update).
      latestAgentVersion: latestAgentVersion || null,
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

  const server = req.server;

  try {
    // Politica por servidor (services/backupPolicy.js): la VPS no tiene
    // backups que vigilar, los ALOHA* se leen con todos los metodos y el
    // resto solo con Windows Server Backup.
    const mode = backupMode(server, await loadBackupPolicy());
    if (mode === 'EXCLUDED') {
      await resolveCleared(server.id, BACKUP_MANAGED_KEYS, [], server.name);
      return res.status(200).json({ ignored: true, backupMode: mode, alertTriggered: false });
    }
    const data = normalizeBackupReport(mode, parsed.data);

    // El agente chequea el backup cada 30 min, pero el backup en si corre una
    // vez por dia: si el resultado y la fecha del ultimo backup son los mismos
    // que el ultimo registro, es la MISMA corrida -- se actualiza ese registro
    // (recordedAt = ultimo chequeo) en vez de agregar una fila repetida al
    // historial.
    const lastBackupAt = data.lastBackupAt ? new Date(data.lastBackupAt) : null;
    const backupData = {
      result: data.result,
      method: data.method,
      lastBackupAt,
      targetPath: data.targetPath,
      sizeBytes: data.sizeBytes,
      vssServiceOk: data.vssServiceOk,
      detail: data.detail,
      metadata: data.metadata,
      recordedAt: data.recordedAt ? new Date(data.recordedAt) : new Date(),
    };
    const previous = await prisma.backupStatus.findFirst({
      where: { serverId: server.id },
      orderBy: { recordedAt: 'desc' },
    });
    const sameRun =
      previous &&
      previous.result === data.result &&
      (previous.lastBackupAt?.getTime() ?? null) === (lastBackupAt?.getTime() ?? null);

    const backup = sameRun
      ? await prisma.backupStatus.update({ where: { id: previous.id }, data: backupData })
      : await prisma.backupStatus.create({ data: { serverId: server.id, ...backupData } });

    broadcastBackupStatus(server, backup);

    const alert = evaluateBackup(server, data);
    let result = null;

    if (alert) {
      result = await createAndDispatchEvent({
        serverId: server.id,
        serverName: server.name,
        type: alert.type,
        severity: alert.severity,
        description: alert.description,
        metadata: alert.metadata,
      });
    }
    await resolveCleared(server.id, BACKUP_MANAGED_KEYS, alert ? [alert.type] : [], server.name);

    return res.status(201).json({
      backupStatusId: backup.id,
      backupMode: mode,
      alertTriggered: Boolean(result?.isNew),
    });
  } catch (err) {
    console.error('Error procesando estado de backup', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get('/api/servers', authUser, async (req, res) => {
  try {
    const [servers, defaultThresholds, backupPolicy] = await Promise.all([
      prisma.server.findMany({ orderBy: { name: 'asc' } }).then(withLatest),
      getEffectiveDefaultThresholds(),
      loadBackupPolicy(),
    ]);

    return res.json(
      servers.map((s) => {
        const latest = s.telemetry[0];
        const mode = backupMode(s, backupPolicy);
        const backup = mode === 'EXCLUDED' ? null : s.backups[0];
        return {
          id: s.id,
          name: s.name,
          // IP interna y hostname: para el boton RDP (conexion directa desde
          // la red interna / VPN, no pasa por el NOC).
          ipAddress: s.ipAddress,
          hostname: s.hostname,
          status: s.status,
          lastSeenAt: s.lastSeenAt,
          tags: s.tags,
          agentVersion: s.agentVersion,
          healthStatus: getHealthStatus(latest, s, defaultThresholds),
          cpuUsage: latest?.cpuUsage ?? null,
          memoryUsage: latest?.memoryUsage ?? null,
          diskUsage: latest?.diskUsage ?? null,
          perf: latest?.metadata?.perf ?? null,
          recordedAt: latest?.recordedAt ?? null,
          thresholds: {
            cpuThresholdHigh: s.cpuThresholdHigh,
            cpuThresholdMedium: s.cpuThresholdMedium,
            memThresholdHigh: s.memThresholdHigh,
            memThresholdMedium: s.memThresholdMedium,
            diskThresholdHigh: s.diskThresholdHigh,
            diskThresholdMedium: s.diskThresholdMedium,
          },
          maintenanceUntil: s.maintenanceUntil,
          inMaintenance: isInMaintenance(s),
          latitude: s.latitude,
          longitude: s.longitude,
          ispPrimaryName: s.ispPrimaryName,
          ispPrimaryContact: s.ispPrimaryContact,
          ispSecondaryName: s.ispSecondaryName,
          ispSecondaryContact: s.ispSecondaryContact,
          siteContactName: s.siteContactName,
          siteContactPhone: s.siteContactPhone,
          hasFortinet: s.hasFortinet,
          siteNotes: s.siteNotes,
          syntheticCheckPort: s.syntheticCheckPort,
          ispPrimaryPublicIp: s.ispPrimaryPublicIp,
          ispSecondaryPublicIp: s.ispSecondaryPublicIp,
          network: summarizeNetwork(s, s.network, s.networkAt),
          backupMode: mode,
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
                durationSeconds: backup.metadata?.durationSeconds ?? null,
                // Todos los metodos detectados en el equipo (agente >= 1.5.0):
                // tareas con scripts, Historial de archivos, SQL, terceros.
                jobs: Array.isArray(backup.metadata?.jobs) ? backup.metadata.jobs : null,
                // Detalle de Windows Server Backup (agente >= 1.7.0): tipo,
                // volumenes, programacion, politica, ultimo trabajo/error.
                wsb: backup.metadata?.wsb ?? null,
                successfulRuns: Array.isArray(backup.metadata?.versions)
                  ? backup.metadata.versions.length
                  : Array.isArray(backup.metadata?.runs)
                    ? backup.metadata.runs.filter((r) => r.result === 'SUCCESS').length
                    : null,
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
    const servers = await withLatest(await prisma.server.findMany());

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [telemetryToday, openAlerts, criticalAlerts, defaultThresholds, backupPolicy] = await Promise.all([
      prisma.telemetry.count({ where: { recordedAt: { gte: startOfDay } } }),
      prisma.securityEvent.count({ where: { status: 'OPEN' } }),
      prisma.securityEvent.count({ where: { status: 'OPEN', severity: 'CRITICAL' } }),
      getEffectiveDefaultThresholds(),
      loadBackupPolicy(),
    ]);

    const breakdown = { OK: 0, WARNING: 0, CRITICAL: 0, UNKNOWN: 0 };
    const backupBreakdown = { SUCCESS: 0, WARNING: 0, FAILED: 0, NOT_CONFIGURED: 0, UNKNOWN: 0 };
    for (const s of servers) {
      breakdown[getHealthStatus(s.telemetry[0], s, defaultThresholds)] += 1;
      if (backupMode(s, backupPolicy) !== 'EXCLUDED') backupBreakdown[s.backups[0]?.result ?? 'UNKNOWN'] += 1;
    }
    const backupServers = Object.values(backupBreakdown).reduce((a, b) => a + b, 0);

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
      backupServers,
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

// Serie temporal para los graficos (pestaña Monitoreo y detalle del
// servidor), agregada en el Postgres por intervalos: 7 dias crudos serian
// ~10.000 filas por servidor, con buckets son ~80 puntos livianos.
const METRIC_RANGES = {
  '1h': { window: '1 hour', bucket: '1 minute' },
  '6h': { window: '6 hours', bucket: '5 minutes' },
  '24h': { window: '24 hours', bucket: '15 minutes' },
  '7d': { window: '7 days', bucket: '2 hours' },
  '30d': { window: '30 days', bucket: '8 hours' },
};

app.get('/api/servers/:id/metrics', authUser, async (req, res) => {
  const range = METRIC_RANGES[req.query.range] ? req.query.range : '1h';
  const { window, bucket } = METRIC_RANGES[range];

  try {
    const rows = await prisma.$queryRaw`
      SELECT
        date_bin(${bucket}::interval, "recordedAt", TIMESTAMP '2000-01-01') AS t,
        AVG("cpuUsage") AS cpu,
        MAX(COALESCE(("metadata"->'perf'->>'cpuMax')::float, "cpuUsage")) AS "cpuMax",
        AVG("memoryUsage") AS mem, MAX("memoryUsage") AS "memMax",
        MAX("diskUsage") AS disk,
        AVG("networkIn") AS "netIn", AVG("networkOut") AS "netOut",
        AVG("processCount") AS processes,
        AVG(("metadata"->'network'->>'latencyMs')::float) AS latency,
        AVG(("metadata"->'network'->>'lossPct')::float) AS loss
      FROM telemetry
      WHERE "serverId" = ${req.params.id}
        AND "recordedAt" >= NOW() - ${window}::interval
      GROUP BY t
      ORDER BY t
    `;

    const round = (v, d = 1) => (v === null || v === undefined ? null : Number(Number(v).toFixed(d)));
    return res.json({
      range,
      bucket,
      points: rows.map((r) => ({
        t: r.t,
        cpu: round(r.cpu),
        cpuMax: round(r.cpuMax),
        mem: round(r.mem),
        memMax: round(r.memMax),
        disk: round(r.disk),
        netIn: round(r.netIn, 0),
        netOut: round(r.netOut, 0),
        processes: round(r.processes, 0),
        latency: round(r.latency),
        loss: round(r.loss),
      })),
    });
  } catch (err) {
    console.error('Error obteniendo métricas', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Pestaña Red: internet de cada sitio (medido por su agente) + dispositivos
// UniFi. Un solo request para toda la vista.
app.get('/api/network/overview', authUser, async (req, res) => {
  try {
    const [servers, devices, unifiSites, openOutages] = await Promise.all([
      prisma.server.findMany({ orderBy: { name: 'asc' } }),
      listUnifiDevices(),
      listUnifiSites(),
      prisma.securityEvent.findMany({
        where: {
          type: { in: ['INTERNET_OUTAGE', 'ISP_FAILOVER', 'NETWORK_DEGRADED', 'NETWORK_UNREACHABLE'] },
          createdAt: { gte: new Date(Date.now() - 7 * 86400000) },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: { server: { select: { name: true } } },
      }),
    ]);

    return res.json({
      sites: servers.map((s) => ({
        serverId: s.id,
        serverName: s.name,
        status: s.status,
        lastSeenAt: s.lastSeenAt,
        ispPrimaryName: s.ispPrimaryName,
        ispSecondaryName: s.ispSecondaryName,
        ispPrimaryPublicIp: s.ispPrimaryPublicIp,
        ispSecondaryPublicIp: s.ispSecondaryPublicIp,
        network: summarizeNetwork(s, s.network, s.networkAt),
      })),
      unifi: { lastRun: getUnifiLastRun(), devices, sites: unifiSites, agents: unifiLocal.agentStatus() },
      recentEvents: openOutages.map((e) => toClientEvent(e)),
    });
  } catch (err) {
    console.error('Error obteniendo el estado de red', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Todo lo que sabemos de un servidor para el modal de detalle: ultimo
// diagnostico preventivo, red, pronostico de disco y alertas activas.
app.get('/api/servers/:id/details', authUser, async (req, res) => {
  try {
    const server = await prisma.server.findUnique({
      where: { id: req.params.id },
      include: {
        events: {
          where: { status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
          orderBy: { lastSeenAt: 'desc' },
          take: 50,
        },
      },
    });
    if (!server) return res.status(404).json({ error: 'Servidor no encontrado' });

    return res.json({
      id: server.id,
      name: server.name,
      hostname: server.hostname,
      ipAddress: server.ipAddress,
      agentVersion: server.agentVersion,
      diagnostics: server.diagnostics,
      diagnosticsAt: server.diagnosticsAt,
      network: summarizeNetwork(server, server.network, server.networkAt),
      networkRaw: server.network,
      isp: {
        primaryName: server.ispPrimaryName,
        primaryPublicIp: server.ispPrimaryPublicIp,
        secondaryName: server.ispSecondaryName,
        secondaryPublicIp: server.ispSecondaryPublicIp,
      },
      diskForecast: getDiskForecast(server.id),
      activeAlerts: server.events.map((e) => toClientEvent(e, server.name)),
    });
  } catch (err) {
    console.error('Error obteniendo detalle del servidor', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Analisis con IA de los errores del Visor de Eventos de Windows que el
// agente ya manda en cada telemetria (metadata.recentEventLogErrors) pero
// que hasta ahora nadie leia. A demanda, no se guarda el resultado.
const eventLogAnalysisLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados análisis solicitados, intenta más tarde' },
});

app.post(
  '/api/servers/:id/analyze-events',
  eventLogAnalysisLimiter,
  authUser,
  requireRole('ADMIN', 'ANALYST'),
  async (req, res) => {
    try {
      const server = await prisma.server.findUnique({ where: { id: req.params.id } });
      if (!server) return res.status(404).json({ error: 'Servidor no encontrado' });

      let errors = latestEventLogErrors.get(server.id);
      if (!errors) {
        // Recien reiniciado el backend: filas viejas todavia las traen.
        const latestTelemetry = await prisma.telemetry.findFirst({ where: { serverId: server.id }, orderBy: { recordedAt: 'desc' } });
        errors = latestTelemetry?.metadata?.recentEventLogErrors ?? [];
      }
      const analysis = await analyzeEventLogErrors(server.name, errors);

      return res.json({ analysis, errorCount: errors.length });
    } catch (err) {
      if (err.code === 'NOT_CONFIGURED') {
        return res.status(503).json({ error: err.message });
      }
      console.error('Error analizando logs de eventos', err);
      return res.status(502).json({ error: 'No se pudo analizar los logs en este momento' });
    }
  }
);

app.get('/api/servers/:id/backup-status', authUser, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const onlySuccess = req.query.onlySuccess === 'true';

  try {
    const rows = await prisma.backupStatus.findMany({
      where: { serverId: req.params.id },
      orderBy: { recordedAt: 'desc' },
      take: 200,
    });

    return res.json(buildBackupHistory(rows, { onlySuccess, limit }));
  } catch (err) {
    console.error('Error obteniendo historial de backups', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get('/api/events', authUser, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);

  try {
    // Por ultima actividad: una alerta deduplicada que sigue repitiendose
    // (occurrences) queda arriba aunque se haya abierto hace horas.
    const events = await prisma.securityEvent.findMany({
      orderBy: { lastSeenAt: 'desc' },
      take: limit,
      include: { server: { select: { name: true } }, acknowledgedBy: { select: { name: true } } },
    });

    return res.json(events.map((e) => toClientEvent(e)));
  } catch (err) {
    console.error('Error listando alertas', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Silenciar una alerta: sigue visible y actualizandose, pero no vuelve a
// notificar (ni si empeora) hasta que pase el tiempo. minutes = 0 la reactiva.
app.post('/api/events/:id/snooze', authUser, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const minutes = Number(req.body?.minutes);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 30 * 24 * 60) {
    return res.status(400).json({ error: 'minutes debe ser un entero entre 0 y 43200' });
  }
  try {
    const event = await prisma.securityEvent.update({
      where: { id: req.params.id },
      data: { snoozedUntil: minutes === 0 ? null : new Date(Date.now() + minutes * 60 * 1000) },
      include: { server: { select: { name: true } }, acknowledgedBy: { select: { name: true } } },
    });
    logAudit({ userId: req.user.sub, action: minutes ? 'EVENT_SNOOZE' : 'EVENT_UNSNOOZE', targetType: 'SecurityEvent', targetId: event.id, metadata: { minutes } });
    const enriched = toClientEvent(event);
    broadcastAlertUpdate(enriched);
    return res.json(enriched);
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Alerta no encontrada' });
    console.error('Error silenciando alerta', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.patch('/api/events/:id', authUser, requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const parsed = updateEventStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Estado inválido', details: parsed.error.flatten() });
  }

  try {
    const event = await prisma.securityEvent.update({
      where: { id: req.params.id },
      data: {
        status: parsed.data.status,
        acknowledgedById: req.user.sub,
        resolvedAt: parsed.data.status === 'RESOLVED' ? new Date() : undefined,
      },
      include: { server: { select: { name: true } }, acknowledgedBy: { select: { name: true } } },
    });

    logAudit({
      userId: req.user.sub,
      action: `EVENT_${parsed.data.status}`,
      targetType: 'SecurityEvent',
      targetId: event.id,
    });

    const enriched = toClientEvent(event);
    broadcastAlertUpdate(enriched);

    return res.json(enriched);
  } catch (err) {
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'Alerta no encontrada' });
    }
    console.error('Error actualizando alerta', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// El limiter de escrituras administrativas se usa desde aca en adelante (lo
// reutiliza tambien la seccion de Administracion mas abajo, con el mismo
// criterio: pocas operaciones de configuracion por ventana de 15 minutos).
const adminWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas operaciones administrativas, intenta más tarde' },
});

// ---------------------------------------------------------------------------
// Playbooks de resolucion: pasos sugeridos por tipo de alerta (interno o de
// Fortinet -- EventType y FortiEventType no se solapan, asi que comparten
// tabla). Lectura para cualquier usuario logueado (son ayuda operativa, no
// informacion sensible); edicion solo ADMIN.
// ---------------------------------------------------------------------------

app.get('/api/playbooks', authUser, async (req, res) => {
  try {
    const playbooks = await prisma.playbook.findMany({ orderBy: { key: 'asc' } });
    return res.json(playbooks);
  } catch (err) {
    console.error('Error listando playbooks', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get('/api/playbooks/:key', authUser, async (req, res) => {
  try {
    const playbook = await prisma.playbook.findUnique({ where: { key: req.params.key } });
    if (!playbook) return res.status(404).json({ error: 'No hay un playbook cargado para este tipo de evento' });
    return res.json(playbook);
  } catch (err) {
    console.error('Error obteniendo playbook', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.patch('/api/admin/playbooks/:key', adminWriteLimiter, authUser, requireRole('ADMIN'), async (req, res) => {
  const parsed = playbookSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Datos de playbook inválidos', details: parsed.error.flatten() });
  }

  try {
    const playbook = await prisma.playbook.upsert({
      where: { key: req.params.key },
      update: { title: parsed.data.title, content: parsed.data.content, updatedById: req.user.sub },
      create: { key: req.params.key, title: parsed.data.title, content: parsed.data.content, updatedById: req.user.sub },
    });

    logAudit({ userId: req.user.sub, action: 'PLAYBOOK_UPDATE', targetType: 'Playbook', targetId: playbook.key });

    return res.json(playbook);
  } catch (err) {
    console.error('Error guardando playbook', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ---------------------------------------------------------------------------
// Administracion: usuarios y servidores (solo ADMIN)
// ---------------------------------------------------------------------------

app.get('/api/admin/users', authUser, requireRole('ADMIN'), async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      select: { id: true, email: true, name: true, role: true, twoFactorEnabled: true, createdAt: true },
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

    logAudit({ userId: req.user.sub, action: 'USER_CREATE', targetType: 'User', targetId: user.id, metadata: { email, role } });

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
    logAudit({ userId: req.user.sub, action: 'USER_DELETE', targetType: 'User', targetId: target.id, metadata: { email: target.email } });
    return res.status(204).send();
  } catch (err) {
    console.error('Error eliminando usuario', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.post(
  '/api/admin/users/:id/revoke-sessions',
  adminWriteLimiter,
  authUser,
  requireRole('ADMIN'),
  async (req, res) => {
    try {
      const target = await prisma.user.findUnique({ where: { id: req.params.id } });
      if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });

      await revokeAllUserSessions(target.id);
      logAudit({
        userId: req.user.sub,
        action: 'USER_REVOKE_SESSIONS',
        targetType: 'User',
        targetId: target.id,
        metadata: { email: target.email },
      });

      return res.status(204).send();
    } catch (err) {
      console.error('Error revocando sesiones', err);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

// Para cuando alguien pierde el celular con el que tenia el 2FA: un ADMIN
// puede desactivarlo a la fuerza (sin el codigo, a diferencia de
// /api/auth/2fa/disable) y de paso cierra sus sesiones activas, por si el
// pedido se origino porque el dispositivo se perdio o fue robado.
app.post(
  '/api/admin/users/:id/reset-2fa',
  adminWriteLimiter,
  authUser,
  requireRole('ADMIN'),
  async (req, res) => {
    try {
      const target = await prisma.user.findUnique({ where: { id: req.params.id } });
      if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });

      await prisma.user.update({
        where: { id: target.id },
        data: { twoFactorEnabled: false, twoFactorSecret: null, twoFactorBackupCodes: [] },
      });
      await revokeAllUserSessions(target.id);

      logAudit({
        userId: req.user.sub,
        action: 'ADMIN_RESET_2FA',
        targetType: 'User',
        targetId: target.id,
        metadata: { email: target.email },
      });

      return res.status(204).send();
    } catch (err) {
      console.error('Error reseteando 2FA', err);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

app.post('/api/admin/servers', adminWriteLimiter, authUser, requireRole('ADMIN'), async (req, res) => {
  const parsed = createServerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Datos de servidor inválidos', details: parsed.error.flatten() });
  }

  const { name, hostname, ipAddress, tags } = parsed.data;

  try {
    const existing = await prisma.server.findUnique({ where: { name } });
    if (existing) {
      return res.status(409).json({ error: 'Ya existe un servidor con ese nombre' });
    }

    const apiKey = generateApiKey();
    const apiKeyHash = await bcrypt.hash(apiKey, 12);

    const server = await prisma.server.create({
      data: { name, hostname, ipAddress, apiKeyHash, status: 'OFFLINE', tags: tags ?? [] },
    });

    logAudit({ userId: req.user.sub, action: 'SERVER_CREATE', targetType: 'Server', targetId: server.id, metadata: { name } });

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

      logAudit({ userId: req.user.sub, action: 'SERVER_ROTATE_KEY', targetType: 'Server', targetId: server.id });

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
    const server = await prisma.server.delete({ where: { id: req.params.id } });
    logAudit({ userId: req.user.sub, action: 'SERVER_DELETE', targetType: 'Server', targetId: server.id, metadata: { name: server.name } });
    return res.status(204).send();
  } catch (err) {
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'Servidor no encontrado' });
    }
    console.error('Error eliminando servidor', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.patch(
  '/api/admin/servers/:id/thresholds',
  adminWriteLimiter,
  authUser,
  requireRole('ADMIN'),
  async (req, res) => {
    const parsed = updateThresholdsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Umbrales inválidos', details: parsed.error.flatten() });
    }

    try {
      const server = await prisma.server.update({
        where: { id: req.params.id },
        data: parsed.data,
      });

      logAudit({
        userId: req.user.sub,
        action: 'SERVER_UPDATE_THRESHOLDS',
        targetType: 'Server',
        targetId: server.id,
        metadata: parsed.data,
      });

      return res.json({ id: server.id, name: server.name, ...parsed.data });
    } catch (err) {
      if (err.code === 'P2025') {
        return res.status(404).json({ error: 'Servidor no encontrado' });
      }
      console.error('Error actualizando umbrales', err);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

app.patch(
  '/api/admin/servers/:id/maintenance',
  adminWriteLimiter,
  authUser,
  requireRole('ADMIN'),
  async (req, res) => {
    const parsed = updateMaintenanceSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Datos de mantenimiento inválidos', details: parsed.error.flatten() });
    }

    try {
      const maintenanceUntil = parsed.data.maintenanceUntil ? new Date(parsed.data.maintenanceUntil) : null;

      const server = await prisma.server.update({
        where: { id: req.params.id },
        data: { maintenanceUntil },
      });

      logAudit({
        userId: req.user.sub,
        action: maintenanceUntil ? 'SERVER_MAINTENANCE_START' : 'SERVER_MAINTENANCE_END',
        targetType: 'Server',
        targetId: server.id,
        metadata: { maintenanceUntil },
      });

      return res.json({ id: server.id, name: server.name, maintenanceUntil: server.maintenanceUntil });
    } catch (err) {
      if (err.code === 'P2025') {
        return res.status(404).json({ error: 'Servidor no encontrado' });
      }
      console.error('Error actualizando ventana de mantenimiento', err);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

app.patch(
  '/api/admin/servers/:id/tags',
  adminWriteLimiter,
  authUser,
  requireRole('ADMIN'),
  async (req, res) => {
    const parsed = updateServerTagsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Etiquetas inválidas', details: parsed.error.flatten() });
    }

    try {
      const server = await prisma.server.update({
        where: { id: req.params.id },
        data: { tags: parsed.data.tags },
      });

      logAudit({
        userId: req.user.sub,
        action: 'SERVER_UPDATE_TAGS',
        targetType: 'Server',
        targetId: server.id,
        metadata: { tags: parsed.data.tags },
      });

      return res.json({ id: server.id, name: server.name, tags: server.tags });
    } catch (err) {
      if (err.code === 'P2025') {
        return res.status(404).json({ error: 'Servidor no encontrado' });
      }
      console.error('Error actualizando etiquetas', err);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

// Mini-CMDB + ubicacion (Mapa): datos operativos del sitio que hoy solo
// viven "en la cabeza" de alguien -- ISP contratado, contacto local, si
// tiene Fortinet propio, coordenadas para el mapa. Todo opcional, nada de
// esto afecta alertas ni permisos.
app.patch(
  '/api/admin/servers/:id/site-info',
  adminWriteLimiter,
  authUser,
  requireRole('ADMIN'),
  async (req, res) => {
    const parsed = siteInfoSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() });
    }

    try {
      const server = await prisma.server.update({
        where: { id: req.params.id },
        data: parsed.data,
      });

      logAudit({
        userId: req.user.sub,
        action: 'SERVER_UPDATE_SITE_INFO',
        targetType: 'Server',
        targetId: server.id,
        metadata: { changedKeys: Object.keys(parsed.data) },
      });

      // Nunca devolver apiKeyHash -- a diferencia de los otros PATCH de
      // servidor (tags, thresholds), aca conviene devolver el objeto casi
      // completo para que el frontend actualice el mapa/CMDB sin otro
      // round-trip, asi que se lista todo lo demas explicitamente.
      const { apiKeyHash, diagnostics, network, ...safeServer } = server;
      return res.json(safeServer);
    } catch (err) {
      if (err.code === 'P2025') {
        return res.status(404).json({ error: 'Servidor no encontrado' });
      }
      console.error('Error actualizando información del sitio', err);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

// Acceso remoto: ya no hay tunel a traves del NOC. Cada servidor tiene un
// boton "Conectar por RDP" que abre el Escritorio remoto de la PC del
// operador directo a la IP interna -- solo funciona desde la red de la
// empresa o con la VPN FortiClient conectada.


app.get('/api/admin/audit-log', authUser, requireRole('ADMIN'), async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);

  try {
    const entries = await prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { user: { select: { name: true, email: true } } },
    });

    return res.json(
      entries.map((e) => ({
        id: e.id,
        action: e.action,
        targetType: e.targetType,
        targetId: e.targetId,
        metadata: e.metadata,
        userName: e.user?.name ?? 'Sistema',
        userEmail: e.user?.email ?? null,
        createdAt: e.createdAt,
      }))
    );
  } catch (err) {
    console.error('Error listando auditoría', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ---------------------------------------------------------------------------
// Configuracion editable en caliente (Admin -> Configuracion): notificaciones,
// umbrales globales, secretos de integraciones, etc. sin tocar el .env ni
// reiniciar el contenedor.
// ---------------------------------------------------------------------------

app.get('/api/admin/settings', authUser, requireRole('ADMIN'), async (req, res) => {
  try {
    return res.json(await getPublicSettings());
  } catch (err) {
    console.error('Error obteniendo configuración', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.patch('/api/admin/settings', adminWriteLimiter, authUser, requireRole('ADMIN'), async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Configuración inválida', details: parsed.error.flatten() });
  }

  const SENSITIVE_KEYS = new Set([
    'SMTP_PASS',
    'SLACK_WEBHOOK_URL',
    'WEBHOOK_URL',
    'AGENT_ENROLLMENT_SECRET',
    'GEMINI_API_KEY',
  ]);

  try {
    await setSettings(parsed.data);

    // En la auditoria se guardan los nombres de los campos tocados, nunca
    // los valores sensibles (ni el anterior ni el nuevo).
    const changedKeys = Object.keys(parsed.data);
    const metadata = { changedKeys };
    for (const key of changedKeys) {
      if (!SENSITIVE_KEYS.has(key)) metadata[key] = parsed.data[key];
    }

    logAudit({ userId: req.user.sub, action: 'SETTINGS_UPDATE', targetType: 'Setting', metadata });

    return res.json(await getPublicSettings());
  } catch (err) {
    console.error('Error guardando configuración', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ---------------------------------------------------------------------------
// Housekeeping (retencion de datos): purga programada de telemetria/eventos/
// backups/auditoria vieja segun Admin -> Configuracion -> Retencion de datos
// (ver src/services/housekeeping.js). Corre sola cada 24hs; estos endpoints
// son solo para ver el resultado de la ultima corrida y para forzar una
// corrida manual (util recien configurado, para no esperar hasta el otro dia).
// ---------------------------------------------------------------------------

app.get('/api/admin/housekeeping', authUser, requireRole('ADMIN'), (req, res) => {
  return res.json({ lastRun: getHousekeepingLastRun() });
});

app.post('/api/admin/housekeeping/run', adminWriteLimiter, authUser, requireRole('ADMIN'), async (req, res) => {
  try {
    const result = await runHousekeeping();
    return res.json(result);
  } catch (err) {
    console.error('Error corriendo housekeeping manual', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ---------------------------------------------------------------------------
// Heartbeat (watchdog de agente caido): ver src/services/heartbeat.js.
// ---------------------------------------------------------------------------

app.get('/api/admin/heartbeat', authUser, requireRole('ADMIN'), (req, res) => {
  return res.json({ lastRun: getHeartbeatLastRun() });
});

app.post('/api/admin/heartbeat/run', adminWriteLimiter, authUser, requireRole('ADMIN'), async (req, res) => {
  try {
    const result = await runHeartbeatCheck();
    return res.json(result);
  } catch (err) {
    console.error('Error corriendo heartbeat manual', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Deteccion de anomalias estadistica: ver src/services/anomalyDetection.js.
// Solo lectura de estado -- se recalcula sola cada hora, no hace falta un
// endpoint para forzarla.
app.get('/api/admin/anomaly-detection', authUser, requireRole('ADMIN'), (req, res) => {
  return res.json(getBaselineStatus());
});

// Synthetic monitoring: ver src/services/syntheticMonitor.js.
// Inventario de red (equipos, usuarios AD, impresoras, IPs) y monitores de
// servicios: ver src/routes/inventory.js.
registerInventoryRoutes(app, { authUser, authServer, requireRole, adminWriteLimiter });

// Sondeo manual de UniFi (boton "Probar conexion" en Admin -> Configuracion).
app.post('/api/admin/unifi/sync', adminWriteLimiter, authUser, requireRole('ADMIN'), async (req, res) => {
  const result = await runUnifiPoll();
  return res.status(result.error ? 502 : 200).json(result);
});

app.get('/api/admin/synthetic-monitor', authUser, requireRole('ADMIN'), (req, res) => {
  return res.json({ lastRun: getSyntheticMonitorLastRun() });
});

app.post('/api/admin/synthetic-monitor/run', adminWriteLimiter, authUser, requireRole('ADMIN'), async (req, res) => {
  try {
    const result = await runSyntheticChecks();
    return res.json(result);
  } catch (err) {
    console.error('Error corriendo synthetic monitoring manual', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ---------------------------------------------------------------------------
// Reportes ejecutivos: PDF con SLA, incidentes y estado de backups del
// periodo, generados a demanda o automaticamente segun Admin -> Configuracion
// -> Reportes ejecutivos (ver src/services/reports.js).
// ---------------------------------------------------------------------------

app.get('/api/admin/reports', authUser, requireRole('ADMIN'), (req, res) => {
  try {
    return res.json(listReports());
  } catch (err) {
    console.error('Error listando reportes', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

const reportGenerateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados reportes generados, intenta más tarde' },
});

app.post('/api/admin/reports/generate', reportGenerateLimiter, authUser, requireRole('ADMIN'), async (req, res) => {
  const periodDays = Math.min(Math.max(Number(req.body?.periodDays) || 7, 1), 90);

  try {
    const { filename, buffer, data } = await generateAndStoreReport({ periodDays });

    if (req.body?.email) {
      const emailTo = await getSetting('REPORT_EMAIL_TO');
      if (emailTo) {
        await sendReportEmail({ to: emailTo, filename, buffer });
      }
    }

    logAudit({
      userId: req.user.sub,
      action: 'REPORT_GENERATE',
      targetType: 'Report',
      targetId: filename,
      metadata: { periodDays, slaPercentage: data.slaPercentage },
    });

    return res.status(201).json({ filename, periodDays, generatedAt: data.generatedAt });
  } catch (err) {
    console.error('Error generando reporte', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Registrada ANTES de la ruta con :filename de abajo -- Express matchea en
// orden de registro, y "export.csv" calzaria como valor de :filename si esta
// ruta especifica estuviera despues.
app.get('/api/admin/reports/export.csv', authUser, requireRole('ADMIN'), async (req, res) => {
  const periodDays = Math.min(Math.max(Number(req.query.periodDays) || 7, 1), 90);

  try {
    const csv = await generateReportCsv({ periodDays });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="enterprise-soc-report-${periodDays}d.csv"`);
    return res.send(csv);
  } catch (err) {
    console.error('Error generando CSV del reporte', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get('/api/admin/reports/:filename', authUser, requireRole('ADMIN'), (req, res) => {
  const filePath = getReportPath(req.params.filename);
  if (!filePath) return res.status(404).json({ error: 'Reporte no encontrado' });
  return res.download(filePath, req.params.filename);
});

// ---------------------------------------------------------------------------
// Monitor Fortinet: dispositivos FortiGate registrados y sus eventos. Dos
// vias de ingesta posibles (ver src/services/fortiSyslog.js y el comentario
// en fortinet.js): push por API con una API key propia por dispositivo
// (igual que los agentes Windows), o syslog UDP directo si el FortiGate no
// puede hacer POSTs HTTP. Cual usar se configura en Admin -> Configuracion.
// ---------------------------------------------------------------------------

app.get('/api/admin/forti-devices', authUser, requireRole('ADMIN'), async (req, res) => {
  try {
    const devices = await prisma.fortiDevice.findMany({ orderBy: { name: 'asc' } });
    return res.json(
      devices.map((d) => ({
        id: d.id,
        name: d.name,
        host: d.host,
        method: d.method,
        lastSeenAt: d.lastSeenAt,
        createdAt: d.createdAt,
      }))
    );
  } catch (err) {
    console.error('Error listando dispositivos Forti', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.post('/api/admin/forti-devices', adminWriteLimiter, authUser, requireRole('ADMIN'), async (req, res) => {
  const parsed = createFortiDeviceSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Datos de dispositivo inválidos', details: parsed.error.flatten() });
  }

  const { name, host, method } = parsed.data;

  try {
    const existing = await prisma.fortiDevice.findUnique({ where: { name } });
    if (existing) {
      return res.status(409).json({ error: 'Ya existe un dispositivo con ese nombre' });
    }

    const apiKey = generateApiKey();
    const apiKeyHash = await bcrypt.hash(apiKey, 12);

    const device = await prisma.fortiDevice.create({ data: { name, host, method, apiKeyHash } });

    logAudit({ userId: req.user.sub, action: 'FORTI_DEVICE_CREATE', targetType: 'FortiDevice', targetId: device.id, metadata: { name, host, method } });

    return res.status(201).json({ id: device.id, name: device.name, apiKey });
  } catch (err) {
    console.error('Error creando dispositivo Forti', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.post(
  '/api/admin/forti-devices/:id/rotate-key',
  adminWriteLimiter,
  authUser,
  requireRole('ADMIN'),
  async (req, res) => {
    try {
      const apiKey = generateApiKey();
      const apiKeyHash = await bcrypt.hash(apiKey, 12);

      const device = await prisma.fortiDevice.update({ where: { id: req.params.id }, data: { apiKeyHash } });

      logAudit({ userId: req.user.sub, action: 'FORTI_DEVICE_ROTATE_KEY', targetType: 'FortiDevice', targetId: device.id });

      return res.json({ id: device.id, name: device.name, apiKey });
    } catch (err) {
      if (err.code === 'P2025') return res.status(404).json({ error: 'Dispositivo no encontrado' });
      console.error('Error rotando API key de dispositivo Forti', err);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

app.delete('/api/admin/forti-devices/:id', authUser, requireRole('ADMIN'), async (req, res) => {
  try {
    const device = await prisma.fortiDevice.delete({ where: { id: req.params.id } });
    logAudit({ userId: req.user.sub, action: 'FORTI_DEVICE_DELETE', targetType: 'FortiDevice', targetId: device.id, metadata: { name: device.name } });
    return res.status(204).send();
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Dispositivo no encontrado' });
    console.error('Error eliminando dispositivo Forti', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ---------------------------------------------------------------------------
// Lectura de capturas de pantalla del panel de un FortiGate (vision de
// Gemini): para los sitios sin API key ni syslog configurados todavia.
// Nunca crea eventos por si solo -- devuelve una propuesta para que un
// ADMIN la revise y confirme con el segundo endpoint antes de ingestarla.
// ---------------------------------------------------------------------------

const fortiScreenshotLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados análisis de capturas solicitados, intenta más tarde' },
});

app.post(
  '/api/admin/forti-devices/analyze-screenshot',
  fortiScreenshotLimiter,
  authUser,
  requireRole('ADMIN'),
  async (req, res) => {
    const parsed = fortiScreenshotSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Datos de imagen inválidos', details: parsed.error.flatten() });
    }

    try {
      const events = await analyzeFortiScreenshot({
        base64Data: parsed.data.imageBase64,
        mediaType: parsed.data.mediaType,
      });
      return res.json({ events });
    } catch (err) {
      if (err.code === 'NOT_CONFIGURED') {
        return res.status(503).json({ error: err.message });
      }
      console.error('Error analizando captura de Fortinet', err);
      return res.status(502).json({ error: 'No se pudo analizar la imagen en este momento' });
    }
  }
);

app.post(
  '/api/admin/forti-devices/:id/ingest-reviewed',
  adminWriteLimiter,
  authUser,
  requireRole('ADMIN'),
  async (req, res) => {
    const parsed = ingestReviewedFortiEventsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() });
    }

    try {
      const device = await prisma.fortiDevice.findUnique({ where: { id: req.params.id } });
      if (!device) return res.status(404).json({ error: 'Dispositivo no encontrado' });

      const created = [];
      for (const event of parsed.data.events) {
        // eslint-disable-next-line no-await-in-loop
        const saved = await ingestFortiEvent(device, event, { source: 'screenshot-analysis' });
        created.push(saved.id);
      }

      logAudit({
        userId: req.user.sub,
        action: 'FORTI_SCREENSHOT_INGEST',
        targetType: 'FortiDevice',
        targetId: device.id,
        metadata: { eventCount: created.length },
      });

      return res.status(201).json({ createdEventIds: created });
    } catch (err) {
      console.error('Error ingiriendo eventos revisados de captura Forti', err);
      return res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

const fortiEventLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Límite de eventos Forti excedido' },
});

app.post('/api/forti/events', fortiEventLimiter, authFortiDevice, async (req, res) => {
  const parsed = fortiEventIngestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Payload de evento Forti inválido', details: parsed.error.flatten() });
  }

  try {
    const event = await ingestFortiEvent(req.fortiDevice, parsed.data, parsed.data.raw);
    return res.status(201).json({ eventId: event.id });
  } catch (err) {
    console.error('Error procesando evento Forti', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get('/api/forti/events', authUser, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);

  try {
    const events = await prisma.fortiEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { device: { select: { name: true } } },
    });

    return res.json(
      events.map((e) => ({
        id: e.id,
        type: e.type,
        severity: e.severity,
        description: e.description,
        sourceIp: e.sourceIp,
        destIp: e.destIp,
        deviceName: e.device?.name,
        createdAt: e.createdAt,
      }))
    );
  } catch (err) {
    console.error('Error listando eventos Forti', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ---------------------------------------------------------------------------
// Asistente (Gemini): consultas del equipo con contexto en vivo del estado
// del NOC/SOC. Requiere GEMINI_API_KEY configurada (Admin -> Configuración).
// ---------------------------------------------------------------------------

const assistantLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas consultas al asistente, intenta más tarde' },
});

app.post('/api/assistant/chat', assistantLimiter, authUser, async (req, res) => {
  const parsed = assistantChatSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Mensaje inválido', details: parsed.error.flatten() });
  }

  try {
    const reply = await askGemini(parsed.data.messages, req.user.sub);
    return res.json({ reply });
  } catch (err) {
    if (err.code === 'NOT_CONFIGURED') {
      return res.status(503).json({ error: err.message });
    }
    console.error('Error consultando al asistente', err);
    return res.status(502).json({ error: 'No se pudo consultar al asistente en este momento' });
  }
});

// Busqueda en lenguaje natural sobre las alertas ya cargadas en el cliente
// (ver LogsRegexTab): no vuelve a consultar la base, filtra el lote que el
// dashboard ya tiene en memoria.
app.post('/api/assistant/filter-events', assistantLimiter, authUser, async (req, res) => {
  const parsed = naturalLanguageFilterSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() });
  }

  try {
    const ids = await filterEventsByNaturalLanguage(parsed.data.query, parsed.data.events);
    return res.json({ ids });
  } catch (err) {
    if (err.code === 'NOT_CONFIGURED') {
      return res.status(503).json({ error: err.message });
    }
    console.error('Error filtrando alertas con IA', err);
    return res.status(502).json({ error: 'No se pudo procesar la búsqueda en este momento' });
  }
});

app.get('/api/admin/assistant-log', authUser, requireRole('ADMIN'), async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);

  try {
    const entries = await prisma.assistantLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { user: { select: { name: true, email: true } } },
    });

    return res.json(
      entries.map((e) => ({
        id: e.id,
        prompt: e.prompt,
        response: e.response,
        userName: e.user?.name ?? 'Desconocido',
        userEmail: e.user?.email ?? null,
        createdAt: e.createdAt,
      }))
    );
  } catch (err) {
    console.error('Error listando log del asistente', err);
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
  const enrollmentSecret = await getSetting('AGENT_ENROLLMENT_SECRET');
  if (!enrollmentSecret) {
    return res.status(503).json({ error: 'El enrolamiento automático no está configurado en este backend' });
  }

  const secret = req.header('x-enrollment-secret');
  if (!secret || secret !== enrollmentSecret) {
    return res.status(401).json({ error: 'Secreto de enrolamiento inválido' });
  }

  const parsed = createServerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Datos de enrolamiento inválidos', details: parsed.error.flatten() });
  }

  const { name, hostname, ipAddress, tags } = parsed.data;

  try {
    const apiKey = generateApiKey();
    const apiKeyHash = await bcrypt.hash(apiKey, 12);

    // Las tags solo se fijan al crear: un re-enrolamiento (misma maquina,
    // rota la API key) no debe pisar tags que un ADMIN ya haya ajustado a
    // mano despues del alta inicial.
    const server = await prisma.server.upsert({
      where: { name },
      update: { hostname, ipAddress, apiKeyHash },
      create: { name, hostname, ipAddress, apiKeyHash, status: 'OFFLINE', tags: tags ?? [] },
    });

    logAudit({
      userId: null,
      action: 'SERVER_AUTO_ENROLL',
      targetType: 'Server',
      targetId: server.id,
      metadata: { name, hostname, ipAddress },
    });

    return res.status(201).json({ serverId: server.id, apiKey });
  } catch (err) {
    console.error('Error en enrolamiento de servidor', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// UniFi local via agentes (services/unifiLocal.js).
const unifiAgentLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
const unifiTasksSchema = z.object({
  ips: z.array(z.object({ ip: z.string().max(45), prefix: z.number().int().min(0).max(32) })).max(20),
});
app.post('/api/agent/unifi/tasks', unifiAgentLimiter, authServer, async (req, res) => {
  const parsed = unifiTasksSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Payload inválido' });
  try {
    // req.secure respeta X-Forwarded-Proto de Nginx ("trust proxy").
    return res.json(await unifiLocal.buildTasks(req.server, parsed.data.ips, req.secure));
  } catch (err) {
    console.error('Error armando tareas UniFi', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

const unifiReportSchema = z.object({
  controllers: z
    .array(
      z.object({
        url: z.string().max(300).optional(),
        hostId: z.string().max(200).nullable().optional(),
        ok: z.boolean(),
        error: z.string().max(500).nullable().optional(),
        version: z.string().max(50).nullable().optional(),
        sites: z
          .array(
            z.object({
              siteId: z.string().max(100),
              siteKey: z.string().max(100).nullable().optional(),
              desc: z.string().max(200).nullable().optional(),
              devices: z.array(z.record(z.any())).max(500),
              health: z.array(z.record(z.any())).max(20).optional(),
            })
          )
          .max(50)
          .optional(),
      })
    )
    .max(20),
});
app.post('/api/agent/unifi/report', unifiAgentLimiter, authServer, async (req, res) => {
  const parsed = unifiReportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Payload inválido', details: parsed.error.flatten() });
  try {
    return res.json(await unifiLocal.processReport(req.server, parsed.data));
  } catch (err) {
    console.error('Error procesando reporte UniFi local', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Aplicaciones de negocio (Monark, ALOHA) y micro-cortes (services/appMonitor.js).
const appsReportSchema = z.object({
  apps: z.array(z.record(z.any())).max(10),
  roles: z.record(z.any()).optional(),
  probes: z.array(z.record(z.any())).max(100).optional(),
  events: z.array(z.record(z.any())).max(500).optional(),
});
const appsAgentLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
app.post('/api/agent/apps', appsAgentLimiter, authServer, async (req, res) => {
  const parsed = appsReportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Payload inválido', details: parsed.error.flatten() });
  try {
    return res.json(await appMonitor.ingestReport(req.server, parsed.data));
  } catch (err) {
    console.error('Error procesando el monitoreo de aplicaciones', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get('/api/apps/overview', authUser, async (req, res) => {
  try {
    return res.json(await appMonitor.overview());
  } catch (err) {
    console.error('Error obteniendo aplicaciones', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get('/api/apps/microcuts', authUser, async (req, res) => {
  const days = [1, 7, 30].includes(Number(req.query.days)) ? Number(req.query.days) : 7;
  const serverId = typeof req.query.serverId === 'string' && req.query.serverId.length <= 64 ? req.query.serverId : undefined;
  try {
    return res.json(await appMonitor.microcutAnalysis({ days, serverId }));
  } catch (err) {
    console.error('Error analizando micro-cortes', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get('/api/apps/:serverId/:appKey/history', authUser, async (req, res) => {
  if (req.params.appKey !== 'MONARK') return res.status(400).json({ error: 'Aplicación inválida' });
  const hours = [6, 24, 168].includes(Number(req.query.hours)) ? Number(req.query.hours) : 24;
  try {
    return res.json(await appMonitor.appHistory(req.params.serverId, req.params.appKey, hours));
  } catch (err) {
    console.error('Error obteniendo historial de la aplicación', err);
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

// Fallback final: si ninguno de los handlers de arriba reclamo el upgrade
// (path desconocido), no dejar el socket colgado.
const KNOWN_WS_PREFIXES = ['/ws'];
httpServer.on('upgrade', (req, socket) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (KNOWN_WS_PREFIXES.some((p) => pathname === p || pathname.startsWith(p))) return;
  socket.destroy();
});

const PORT = process.env.PORT || 4000;
// Nginx mantiene conexiones keep-alive de hasta 75 s hacia el backend: si
// Node las cierra antes (default 5 s), Nginx a veces reusa una conexion ya
// cerrada y el usuario ve un 502 esporadico.
httpServer.keepAliveTimeout = 76_000;
httpServer.headersTimeout = 77_000;
httpServer.listen(PORT, () => {
  console.log(`NOC/SOC backend escuchando en el puerto ${PORT}`);
});

startFortiSyslogListener().catch((err) => console.error('No se pudo iniciar el listener de syslog Forti', err));
scheduleHousekeeping();
scheduleReports();
scheduleHeartbeat();
scheduleProactiveDigest();
scheduleAnomalyBaselineRefresh();
scheduleSyntheticMonitor();
scheduleDiskForecast();
scheduleUnifiPoll();
scheduleServiceMonitor();
seedMissingPlaybooks();
appMonitor.purgeRemovedMonitoring();

// 24/7: un error no capturado se registra en vez de pasar desapercibido. Una
// promesa rechazada no tira el proceso; una excepcion sincronica si (el
// estado puede quedar corrupto) y Docker lo reinicia en segundos.
process.on('unhandledRejection', (reason) => {
  console.error('Promesa rechazada sin manejar', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Excepción no capturada, reiniciando el proceso', err);
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} recibido: cerrando el backend`);
  // Los WebSockets abiertos impiden que close() termine: tope de 10 s.
  setTimeout(() => process.exit(0), 10_000).unref();
  httpServer.close(() => process.exit(0));
  await prisma.$disconnect().catch(() => {});
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
