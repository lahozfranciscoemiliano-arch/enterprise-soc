const THRESHOLDS = {
  cpuUsage: { type: 'CPU_THRESHOLD', high: 90, medium: 75 },
  memoryUsage: { type: 'MEMORY_THRESHOLD', high: 90, medium: 80 },
  diskUsage: { type: 'DISK_THRESHOLD', high: 95, medium: 85 },
};

function evaluateTelemetry(server, telemetry) {
  const alerts = [];

  for (const [field, rule] of Object.entries(THRESHOLDS)) {
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

function getHealthStatus(telemetry) {
  if (!telemetry) return 'UNKNOWN';

  let status = 'OK';

  for (const [field, rule] of Object.entries(THRESHOLDS)) {
    const value = telemetry[field];
    if (value === undefined || value === null) continue;

    if (value >= rule.high) return 'CRITICAL';
    if (value >= rule.medium) status = 'WARNING';
  }

  return status;
}

function evaluateBackup(server, backup) {
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

module.exports = { evaluateTelemetry, evaluateBackup, getHealthStatus, THRESHOLDS };
