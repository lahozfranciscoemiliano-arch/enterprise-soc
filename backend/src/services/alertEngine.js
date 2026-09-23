// Umbrales globales por defecto. Un servidor puede sobreescribirlos via sus
// campos cpuThresholdHigh/cpuThresholdMedium/etc (ver resolveThresholds).
const DEFAULT_THRESHOLDS = {
  cpuUsage: {
    type: 'CPU_THRESHOLD',
    high: 90,
    medium: 75,
    highField: 'cpuThresholdHigh',
    mediumField: 'cpuThresholdMedium',
  },
  memoryUsage: {
    type: 'MEMORY_THRESHOLD',
    high: 90,
    medium: 80,
    highField: 'memThresholdHigh',
    mediumField: 'memThresholdMedium',
  },
  diskUsage: {
    type: 'DISK_THRESHOLD',
    high: 95,
    medium: 85,
    highField: 'diskThresholdHigh',
    mediumField: 'diskThresholdMedium',
  },
};

function resolveThresholds(server) {
  const resolved = {};
  for (const [field, rule] of Object.entries(DEFAULT_THRESHOLDS)) {
    resolved[field] = {
      type: rule.type,
      high: server?.[rule.highField] ?? rule.high,
      medium: server?.[rule.mediumField] ?? rule.medium,
    };
  }
  return resolved;
}

function isInMaintenance(server) {
  return Boolean(server?.maintenanceUntil && new Date(server.maintenanceUntil) > new Date());
}

function evaluateTelemetry(server, telemetry) {
  if (isInMaintenance(server)) return [];

  const thresholds = resolveThresholds(server);
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

function getHealthStatus(telemetry, server) {
  if (!telemetry) return 'UNKNOWN';

  const thresholds = resolveThresholds(server);
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
  DEFAULT_THRESHOLDS,
};
