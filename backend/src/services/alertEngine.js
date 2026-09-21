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

module.exports = { evaluateTelemetry };
