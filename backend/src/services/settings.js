const prisma = require('../prismaClient');

// Registro central de toda la configuracion editable desde Admin ->
// Configuracion. Cada entrada define: la variable de entorno que sirve de
// valor por defecto (para no romper instalaciones existentes que ya la
// tengan en .env), si es sensible (nunca se devuelve en texto plano por la
// API), y el tipo para castear el string guardado en la tabla Setting.
const SETTING_DEFS = {
  // Notificaciones
  SMTP_HOST: { envFallback: 'SMTP_HOST', type: 'string', sensitive: false },
  SMTP_PORT: { envFallback: 'SMTP_PORT', type: 'number', sensitive: false },
  SMTP_SECURE: { envFallback: 'SMTP_SECURE', type: 'boolean', sensitive: false },
  SMTP_USER: { envFallback: 'SMTP_USER', type: 'string', sensitive: false },
  SMTP_PASS: { envFallback: 'SMTP_PASS', type: 'string', sensitive: true },
  SMTP_FROM: { envFallback: 'SMTP_FROM', type: 'string', sensitive: false },
  ALERT_EMAIL_TO: { envFallback: 'ALERT_EMAIL_TO', type: 'string', sensitive: false },
  SLACK_WEBHOOK_URL: { envFallback: 'SLACK_WEBHOOK_URL', type: 'string', sensitive: true },
  WEBHOOK_URL: { envFallback: 'WEBHOOK_URL', type: 'string', sensitive: true },
  TELEGRAM_BOT_TOKEN: { envFallback: 'TELEGRAM_BOT_TOKEN', type: 'string', sensitive: true },
  TELEGRAM_CHAT_ID: { envFallback: 'TELEGRAM_CHAT_ID', type: 'string', sensitive: false },
  NOTIFY_MIN_SEVERITY: { envFallback: 'NOTIFY_MIN_SEVERITY', type: 'string', sensitive: false },
  // Anti-fatiga (services/notifications.js): horario silencioso ("22-07":
  // solo CRITICAL, el resto en un resumen al terminar) y minutos de
  // agrupacion de alertas no criticas en un solo mensaje.
  NOTIFY_QUIET_HOURS: { envFallback: null, type: 'string', sensitive: false },
  NOTIFY_BATCH_MINUTES: { envFallback: null, type: 'number', sensitive: false },

  // Sesion
  JWT_EXPIRES_IN: { envFallback: 'JWT_EXPIRES_IN', type: 'string', sensitive: false },

  // Umbrales globales por defecto (si un servidor no tiene los suyos propios)
  DEFAULT_CPU_HIGH: { envFallback: null, type: 'number', sensitive: false },
  DEFAULT_CPU_MEDIUM: { envFallback: null, type: 'number', sensitive: false },
  DEFAULT_MEM_HIGH: { envFallback: null, type: 'number', sensitive: false },
  DEFAULT_MEM_MEDIUM: { envFallback: null, type: 'number', sensitive: false },
  DEFAULT_DISK_HIGH: { envFallback: null, type: 'number', sensitive: false },
  DEFAULT_DISK_MEDIUM: { envFallback: null, type: 'number', sensitive: false },

  // Enrolamiento de agentes
  AGENT_ENROLLMENT_SECRET: { envFallback: 'AGENT_ENROLLMENT_SECRET', type: 'string', sensitive: true },
  AGENT_LATEST_VERSION: { envFallback: null, type: 'string', sensitive: false },
  // Heartbeat (services/heartbeat.js): segundos sin telemetria antes de
  // marcar un servidor OFFLINE y alertar.
  AGENT_STALE_THRESHOLD_SECONDS: { envFallback: null, type: 'number', sensitive: false },

  // Integracion Fortinet
  FORTI_SYSLOG_ENABLED: { envFallback: null, type: 'boolean', sensitive: false },
  FORTI_SYSLOG_PORT: { envFallback: null, type: 'number', sensitive: false },

  // Asistente (Gemini)
  GEMINI_API_KEY: { envFallback: 'GEMINI_API_KEY', type: 'string', sensitive: true },
  GEMINI_MODEL: { envFallback: 'GEMINI_MODEL', type: 'string', sensitive: false },

  // Monitoreo preventivo (services/preventiveChecks.js). Servicios cuya
  // caida genera alerta: nombres separados por coma, admite comodin al final
  // (MSSQL$* = cualquier instancia de SQL Server).
  CRITICAL_SERVICES: { envFallback: null, type: 'string', sensitive: false },
  // Unico servidor que hace el inventario de red (DHCP/AD/impresoras/IPs).
  // Vacio = se asigna solo al primer servidor con rol DHCP que reporte.
  INVENTORY_COLLECTOR: { envFallback: null, type: 'string', sensitive: false },
  PATCH_MAX_AGE_DAYS: { envFallback: null, type: 'number', sensitive: false },
  // Backups (services/backupPolicy.js): prefijos de nombre de los servidores
  // donde se leen TODOS los metodos de backup (scripts, SQL, Historial de
  // archivos, terceros); el resto solo Windows Server Backup / Copias de
  // seguridad de Windows. Y servidores que no tienen backup (la VPS).
  BACKUP_MULTI_METHOD_PREFIXES: { envFallback: null, type: 'string', sensitive: false },
  BACKUP_EXCLUDED_SERVERS: { envFallback: null, type: 'string', sensitive: false },

  // Ubiquiti UniFi (services/unifi.js). Modo "cloud" = Site Manager API
  // (api.ui.com, API key de unifi.ui.com -> API); "local" = Integration API
  // de la consola (necesita que la VPS llegue a la IP de la consola).
  UNIFI_MODE: { envFallback: null, type: 'string', sensitive: false },
  UNIFI_API_KEY: { envFallback: 'UNIFI_API_KEY', type: 'string', sensitive: true },
  UNIFI_CONTROLLER_URL: { envFallback: null, type: 'string', sensitive: false },
  UNIFI_VERIFY_TLS: { envFallback: null, type: 'boolean', sensitive: false },
  // Detalle local (services/unifiLocal.js): cuenta de SOLO LECTURA creada en
  // cada controlador (misma usuario/clave en todos) que usan los agentes de
  // las sucursales para leer AP por AP. URLs extra: una por linea.
  UNIFI_LOCAL_ENABLED: { envFallback: null, type: 'boolean', sensitive: false },
  UNIFI_LOCAL_USERNAME: { envFallback: null, type: 'string', sensitive: false },
  UNIFI_LOCAL_PASSWORD: { envFallback: null, type: 'string', sensitive: true },
  UNIFI_LOCAL_CONTROLLERS: { envFallback: null, type: 'string', sensitive: false },

  // Acceso remoto

  // Retencion de datos (housekeeping) -- ver services/housekeeping.js. Todos
  // en dias; 0 = conservar para siempre (no recomendado con 30GB de disco).
  TELEMETRY_RETENTION_DAYS: { envFallback: null, type: 'number', sensitive: false },
  SECURITY_EVENT_RETENTION_DAYS: { envFallback: null, type: 'number', sensitive: false },
  BACKUP_STATUS_RETENTION_DAYS: { envFallback: null, type: 'number', sensitive: false },
  FORTI_EVENT_RETENTION_DAYS: { envFallback: null, type: 'number', sensitive: false },
  AUDIT_LOG_RETENTION_DAYS: { envFallback: null, type: 'number', sensitive: false },

  // Reportes ejecutivos automaticos -- ver services/reports.js
  REPORT_ENABLED: { envFallback: null, type: 'boolean', sensitive: false },
  REPORT_FREQUENCY: { envFallback: null, type: 'string', sensitive: false }, // 'daily' | 'weekly'
  REPORT_HOUR: { envFallback: null, type: 'number', sensitive: false }, // 0-23, hora local del servidor (UTC)
  REPORT_EMAIL_TO: { envFallback: null, type: 'string', sensitive: false },
};

function cast(rawValue, type) {
  if (rawValue === null || rawValue === undefined) return undefined;
  if (type === 'number') {
    const n = Number(rawValue);
    return Number.isNaN(n) ? undefined : n;
  }
  if (type === 'boolean') return rawValue === 'true';
  return rawValue;
}

// Cache corto en memoria: las settings se leen en el hot path de telemetria
// y notificaciones, pero no hace falta pegarle a la base en cada request. Se
// invalida al toque cuando se escribe algo, asi que un cambio desde Admin
// aplica de inmediato igual.
let cache = null;
let cacheAt = 0;
const CACHE_TTL_MS = 10_000;

async function loadAll() {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_TTL_MS) return cache;

  const rows = await prisma.setting.findMany();
  cache = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  cacheAt = now;
  return cache;
}

function invalidateCache() {
  cache = null;
  cacheAt = 0;
}

async function getSetting(key) {
  const def = SETTING_DEFS[key];
  if (!def) throw new Error(`Setting desconocida: ${key}`);

  const stored = await loadAll();
  if (stored[key] !== undefined) return cast(stored[key], def.type);
  if (def.envFallback && process.env[def.envFallback] !== undefined) {
    return cast(process.env[def.envFallback], def.type);
  }
  return undefined;
}

async function getSettings(keys) {
  const result = {};
  for (const key of keys) {
    // eslint-disable-next-line no-await-in-loop
    result[key] = await getSetting(key);
  }
  return result;
}

// Vista para la API: nunca expone el valor real de un campo sensible, solo
// si esta configurado (y, para poder confirmar que se guardo lo correcto sin
// filtrarlo entero, los ultimos 4 caracteres).
async function getPublicSettings() {
  const stored = await loadAll();
  const out = {};

  for (const [key, def] of Object.entries(SETTING_DEFS)) {
    const hasStoredValue = stored[key] !== undefined && stored[key] !== '';
    const hasEnvFallback = Boolean(def.envFallback && process.env[def.envFallback]);

    if (def.sensitive) {
      const rawValue = hasStoredValue ? stored[key] : hasEnvFallback ? process.env[def.envFallback] : null;
      out[key] = {
        configured: Boolean(rawValue),
        hint: rawValue ? `••••${String(rawValue).slice(-4)}` : null,
        source: hasStoredValue ? 'db' : hasEnvFallback ? 'env' : null,
      };
    } else {
      const value = hasStoredValue ? cast(stored[key], def.type) : hasEnvFallback ? cast(process.env[def.envFallback], def.type) : null;
      out[key] = { value, source: hasStoredValue ? 'db' : hasEnvFallback ? 'env' : null };
    }
  }

  return out;
}

// patch: objeto { KEY: valor }. Un string vacio en un campo sensible se
// interpreta como "no cambiar" (para que el formulario pueda mandar el resto
// de los campos sin forzar a resetear la contraseña SMTP en cada guardado).
async function setSettings(patch) {
  const ops = [];

  for (const [key, value] of Object.entries(patch)) {
    const def = SETTING_DEFS[key];
    if (!def) continue;
    if (def.sensitive && (value === '' || value === undefined)) continue;
    if (value === undefined) continue;

    const stringValue = typeof value === 'boolean' ? String(value) : String(value);
    ops.push(
      prisma.setting.upsert({
        where: { key },
        update: { value: stringValue },
        create: { key, value: stringValue },
      })
    );
  }

  if (ops.length > 0) await prisma.$transaction(ops);
  invalidateCache();
}

module.exports = { SETTING_DEFS, getSetting, getSettings, getPublicSettings, setSettings, invalidateCache };
