const { getSettings } = require('./settings');

// Umbrales globales por defecto "de fabrica"; se usan si no hay nada
// guardado en Admin -> Configuracion (ver getEffectiveDefaultThresholds) ni
// en el propio servidor.
const DEFAULT_THRESHOLDS = {
  cpuUsage: {
    type: 'CPU_THRESHOLD',
    high: 90,
    medium: 75,
    highField: 'cpuThresholdHigh',
    mediumField: 'cpuThresholdMedium',
    settingHigh: 'DEFAULT_CPU_HIGH',
    settingMedium: 'DEFAULT_CPU_MEDIUM',
  },
  memoryUsage: {
    type: 'MEMORY_THRESHOLD',
    high: 90,
    medium: 80,
    highField: 'memThresholdHigh',
    mediumField: 'memThresholdMedium',
    settingHigh: 'DEFAULT_MEM_HIGH',
    settingMedium: 'DEFAULT_MEM_MEDIUM',
  },
  diskUsage: {
    type: 'DISK_THRESHOLD',
    high: 95,
    medium: 85,
    highField: 'diskThresholdHigh',
    mediumField: 'diskThresholdMedium',
    settingHigh: 'DEFAULT_DISK_HIGH',
    settingMedium: 'DEFAULT_DISK_MEDIUM',
  },
};

// Trae los 6 umbrales globales configurados en Admin -> Configuracion (si
// hay), completando lo que falte con los valores de fabrica. Pensado para
// pedirse una sola vez por request y pasarlo a resolveThresholds/
// evaluateTelemetry/getHealthStatus, no una vez por servidor.
async function getEffectiveDefaultThresholds() {
  const keys = Object.values(DEFAULT_THRESHOLDS).flatMap((r) => [r.settingHigh, r.settingMedium]);
  const stored = await getSettings(keys);

  const effective = {};
  for (const [field, rule] of Object.entries(DEFAULT_THRESHOLDS)) {
    effective[field] = {
      type: rule.type,
      high: stored[rule.settingHigh] ?? rule.high,
      medium: stored[rule.settingMedium] ?? rule.medium,
    };
  }
  return effective;
}

function resolveThresholds(server, defaults = DEFAULT_THRESHOLDS) {
  const resolved = {};
  for (const [field, rule] of Object.entries(DEFAULT_THRESHOLDS)) {
    const fallback = defaults[field] ?? rule;
    resolved[field] = {
      type: rule.type,
      high: server?.[rule.highField] ?? fallback.high,
      medium: server?.[rule.mediumField] ?? fallback.medium,
    };
  }
  return resolved;
}

function isInMaintenance(server) {
  return Boolean(server?.maintenanceUntil && new Date(server.maintenanceUntil) > new Date());
}

function evaluateTelemetry(server, telemetry, defaults = DEFAULT_THRESHOLDS) {
  if (isInMaintenance(server)) return [];

  const thresholds = resolveThresholds(server, defaults);
  const alerts = [];

  for (const [field, rule] of Object.entries(thresholds)) {
    const value = telemetry[field];
    if (value === undefined || value === null) continue;

    let severity = null;
    if (value >= rule.high) severity = 'CRITICAL';
    else if (value >= rule.medium) severity = 'HIGH';

    if (severity) {
      const threshold = severity === 'CRITICAL' ? rule.high : rule.medium;
      alerts.push({
        type: rule.type,
        severity,
        description: `${server.name}: ${field} en ${value.toFixed(1)}% (umbral ${threshold}%)`,
        metadata: { field, value, serverId: server.id },
      });
    }
  }

  // Senal opcional que manda el script de auto-monitoreo del propio VPS
  // (deploy/host-monitor.sh): lista de contenedores Docker que dejaron de
  // estar "healthy"/"running". No es una metrica generica de ningun agente
  // Windows, por eso vive aca como un campo suelto en metadata en vez de un
  // umbral mas en resolveThresholds.
  const unhealthy = telemetry.metadata?.unhealthyContainers;
  if (Array.isArray(unhealthy) && unhealthy.length > 0) {
    alerts.push({
      type: 'CUSTOM',
      severity: 'HIGH',
      description: `${server.name}: ${unhealthy.length} contenedor(es) Docker caído(s) o degradado(s): ${unhealthy.join(', ')}`,
      metadata: { unhealthyContainers: unhealthy, serverId: server.id },
      dedupKey: 'CUSTOM:containers',
    });
  }

  return alerts;
}

function evaluateBackup(server, backup) {
  if (isInMaintenance(server)) return null;

  if (backup.result === 'FAILED') {
    return {
      type: 'BACKUP_FAILED',
      severity: 'HIGH',
      description: `${server.name}: el backup falló (${backup.method}). ${backup.detail ?? ''}`.trim(),
      metadata: { method: backup.method, detail: backup.detail, serverId: server.id },
    };
  }

  if (backup.result === 'WARNING' || (backup.result === 'SUCCESS' && !backup.vssServiceOk)) {
    return {
      type: 'BACKUP_WARNING',
      severity: 'MEDIUM',
      description: `${server.name}: backup con advertencias (${backup.method})${backup.vssServiceOk ? '' : ' — servicio VSS detenido'}.`,
      metadata: { method: backup.method, detail: backup.detail, serverId: server.id },
    };
  }

  return null;
}

// Condiciones que controla cada chequeo: las que no se vuelvan a detectar en
// el chequeo siguiente se auto-resuelven (ver eventPipeline.resolveCleared).
const TELEMETRY_MANAGED_KEYS = [
  ...Object.entries(DEFAULT_THRESHOLDS).map(([field, rule]) => `${rule.type}:${field}`),
  ...Object.keys(DEFAULT_THRESHOLDS).map((field) => `ANOMALY_DETECTED:${field}`),
  'CUSTOM:containers',
];
const BACKUP_MANAGED_KEYS = ['BACKUP_FAILED', 'BACKUP_WARNING'];

function getHealthStatus(telemetry, server, defaults = DEFAULT_THRESHOLDS) {
  // El heartbeat (services/heartbeat.js) mantiene server.status al dia: si
  // dice OFFLINE es porque dejo de reportar telemetria hace rato, sin
  // importar que valores traia su ULTIMA telemetria (podrian ser viejos y
  // "buenos" justo antes de caerse). Offline siempre pesa mas que cualquier
  // umbral.
  if (server?.status === 'OFFLINE') return 'CRITICAL';
  if (!telemetry) return 'UNKNOWN';

  const thresholds = resolveThresholds(server, defaults);
  let status = 'OK';

  for (const [field, rule] of Object.entries(thresholds)) {
    const value = telemetry[field];
    if (value === undefined || value === null) continue;

    if (value >= rule.high) return 'CRITICAL';
    if (value >= rule.medium) status = 'WARNING';
  }

  return status;
}

module.exports = {
  evaluateTelemetry,
  evaluateBackup,
  getHealthStatus,
  resolveThresholds,
  isInMaintenance,
  getEffectiveDefaultThresholds,
  DEFAULT_THRESHOLDS,
  TELEMETRY_MANAGED_KEYS,
  BACKUP_MANAGED_KEYS,
};
