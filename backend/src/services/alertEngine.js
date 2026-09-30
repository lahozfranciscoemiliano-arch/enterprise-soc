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

// Resumen legible de los trabajos de backup con problemas (agente >= 1.5.0
// manda cada metodo detectado en metadata.jobs).
function describeBackupJobs(backup, results) {
  const jobs = Array.isArray(backup.metadata?.jobs) ? backup.metadata.jobs : [];
  return jobs
    .filter((j) => results.includes(j.result) && !j.advisory)
    .slice(0, 4)
    .map((j) => `"${j.name}" (${j.tool ?? j.method}): ${j.detail ?? j.result}`)
    .join(' | ');
}

function evaluateBackup(server, backup) {
  if (isInMaintenance(server)) return null;

  if (backup.result === 'FAILED') {
    const jobs = describeBackupJobs(backup, ['FAILED']);
    return {
      type: 'BACKUP_FAILED',
      severity: 'HIGH',
      description: `${server.name}: backup FALLIDO. ${jobs || `${backup.method}: ${backup.detail ?? ''}`}`.trim().slice(0, 900),
      metadata: { method: backup.method, detail: backup.detail, serverId: server.id },
    };
  }

  if (backup.result === 'WARNING' || (backup.result === 'SUCCESS' && !backup.vssServiceOk)) {
    const jobs = describeBackupJobs(backup, ['WARNING']);
    return {
      type: 'BACKUP_WARNING',
      severity: 'MEDIUM',
      description: `${server.name}: backup con advertencias. ${jobs || backup.method}${backup.vssServiceOk ? '' : ' — servicio VSS (instantáneas) deshabilitado'}.`.slice(0, 900),
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

// Umbrales que rigen para un servidor, en la forma {cpuUsage: {high, medium}, ...}.
// El frontend los recibe con /api/servers para colorear barras y calcular la
// salud con los MISMOS valores que el backend (antes usaba los de fabrica
// fijos en el codigo y, con umbrales cambiados en Admin, la salud "saltaba"
// entre OK y ADVERTENCIA/CRITICO con cada telemetria en vivo).
function effectiveThresholds(server, defaults = DEFAULT_THRESHOLDS) {
  const out = {};
  for (const [field, rule] of Object.entries(resolveThresholds(server, defaults))) {
    out[field] = { high: rule.high, medium: rule.medium };
  }
  return out;
}

// Volumenes de datos (D:, E:, ...) del ultimo diagnostico del agente. La
// telemetria solo trae la unidad del sistema (C:): sin esto un servidor con
// E: al 99.9% figuraba "saludable" en General/Monitoreo aunque tuviera una
// alerta CRITICA abierta por ese disco.
const VOLUME_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function dataVolumes(server) {
  const volumes = server?.diagnostics?.volumes;
  if (!Array.isArray(volumes)) return [];
  const at = server.diagnosticsAt ? new Date(server.diagnosticsAt).getTime() : NaN;
  if (!Number.isFinite(at) || Date.now() - at > VOLUME_MAX_AGE_MS) return [];
  return volumes
    .filter((v) => {
      const mount = String(v?.mount || '').toUpperCase();
      return mount && mount !== 'C:' && mount !== '/' && typeof v.percent === 'number';
    })
    .map((v) => ({
      mount: String(v.mount).toUpperCase(),
      percent: v.percent,
      freeBytes: v.freeBytes ?? null,
      totalBytes: v.totalBytes ?? null,
    }));
}

function worstDataVolume(server) {
  return dataVolumes(server).reduce((worst, v) => (!worst || v.percent > worst.percent ? v : worst), null);
}

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

  // Mismos umbrales de disco para los volumenes de datos.
  const volume = worstDataVolume(server);
  if (volume) {
    if (volume.percent >= thresholds.diskUsage.high) return 'CRITICAL';
    if (volume.percent >= thresholds.diskUsage.medium) status = 'WARNING';
  }

  return status;
}

module.exports = {
  evaluateTelemetry,
  evaluateBackup,
  getHealthStatus,
  effectiveThresholds,
  dataVolumes,
  worstDataVolume,
  resolveThresholds,
  isInMaintenance,
  getEffectiveDefaultThresholds,
  DEFAULT_THRESHOLDS,
  TELEMETRY_MANAGED_KEYS,
  BACKUP_MANAGED_KEYS,
};
