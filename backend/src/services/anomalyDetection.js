// Deteccion de anomalias estadistica: complementa los umbrales fijos de
// alertEngine.js (CPU>90%, etc.) con una nocion de "normal para ESTE
// servidor a ESTA hora". Un Kansas con trafico altisimo al mediodia y casi
// nulo a las 3am nunca va a cruzar un umbral fijo razonable en ninguno de
// los dos horarios, pero un pico a las 3am que normalmente esta en 5% y de
// golpe esta en 40% es una señal real que los umbrales fijos no detectan.
//
// No usa IA generativa -- es estadistica simple (media + desvio estandar
// por servidor+metrica+hora-del-dia), calculada una vez por hora sobre los
// ultimos 14 dias y cacheada en memoria. Recalcularla en cada telemetria
// (cada 60s x 21 servidores) seria carisimo para el Postgres del VPS; una
// vez por hora es mas que suficiente porque el patron "normal" de un
// servidor no cambia de un minuto a otro.
const prisma = require('../prismaClient');

const BASELINE_WINDOW_DAYS = 14;
const MIN_SAMPLES_PER_BUCKET = 20; // menos que esto, el promedio no es confiable
const MIN_STDDEV_FLOOR = 3; // evita z-scores gigantes por ruido en metricas casi constantes
const Z_SCORE_THRESHOLD = 3.5;

const METRICS = [
  { field: 'cpuUsage', label: 'CPU', meanCol: 'cpu_mean', stdCol: 'cpu_std' },
  { field: 'memoryUsage', label: 'RAM', meanCol: 'mem_mean', stdCol: 'mem_std' },
  { field: 'diskUsage', label: 'disco', meanCol: 'disk_mean', stdCol: 'disk_std' },
];

// serverId -> Map<hourOfDay(0-23), { cpu:{mean,std}, mem:{...}, disk:{...}, n }>
let baselines = new Map();
let lastRefreshAt = null;

async function refreshBaselines() {
  const rows = await prisma.$queryRaw`
    SELECT
      "serverId",
      EXTRACT(HOUR FROM "recordedAt")::int AS hour,
      AVG("cpuUsage") AS cpu_mean, STDDEV_POP("cpuUsage") AS cpu_std,
      AVG("memoryUsage") AS mem_mean, STDDEV_POP("memoryUsage") AS mem_std,
      AVG("diskUsage") AS disk_mean, STDDEV_POP("diskUsage") AS disk_std,
      COUNT(*)::int AS n
    FROM telemetry
    WHERE "recordedAt" >= NOW() - (${BASELINE_WINDOW_DAYS} || ' days')::interval
    GROUP BY "serverId", hour
  `;

  const next = new Map();
  for (const row of rows) {
    if (row.n < MIN_SAMPLES_PER_BUCKET) continue;
    if (!next.has(row.serverId)) next.set(row.serverId, new Map());
    next.get(row.serverId).set(row.hour, {
      n: row.n,
      cpu: { mean: Number(row.cpu_mean), std: Number(row.cpu_std) || 0 },
      mem: { mean: Number(row.mem_mean), std: Number(row.mem_std) || 0 },
      disk: { mean: Number(row.disk_mean), std: Number(row.disk_std) || 0 },
    });
  }

  baselines = next;
  lastRefreshAt = new Date();
  console.log(`Baselines de anomalías recalculadas: ${next.size} servidor(es) con historial suficiente`);
}

const METRIC_TO_BASELINE_KEY = { cpuUsage: 'cpu', memoryUsage: 'mem', diskUsage: 'disk' };

// Devuelve alertas tipo ANOMALY_DETECTED para los campos que NO esten ya en
// `excludeFields` (los que evaluateTelemetry ya cubrio con un umbral fijo en
// esta misma telemetria -- evita duplicar el mismo pico como dos alertas
// distintas).
function evaluateAnomalies(server, telemetry, excludeFields = new Set()) {
  const serverBaselines = baselines.get(server.id);
  if (!serverBaselines) return [];

  const hour = new Date(telemetry.recordedAt ?? Date.now()).getUTCHours();
  const bucket = serverBaselines.get(hour);
  if (!bucket) return [];

  const anomalies = [];

  for (const metric of METRICS) {
    if (excludeFields.has(metric.field)) continue;

    const value = telemetry[metric.field];
    if (value === undefined || value === null) continue;

    const baseline = bucket[METRIC_TO_BASELINE_KEY[metric.field]];
    const std = Math.max(baseline.std, MIN_STDDEV_FLOOR);
    const z = (value - baseline.mean) / std;

    // Solo interesan los picos (z positivo grande): un uso mas BAJO de lo
    // normal no es un problema operativo.
    if (z >= Z_SCORE_THRESHOLD) {
      anomalies.push({
        type: 'ANOMALY_DETECTED',
        severity: z >= Z_SCORE_THRESHOLD * 1.5 ? 'HIGH' : 'MEDIUM',
        description: `${server.name}: ${metric.label} en ${value.toFixed(1)}%, muy por encima de lo habitual para este servidor a esta hora (promedio ~${baseline.mean.toFixed(1)}%).`,
        metadata: { field: metric.field, value, baselineMean: baseline.mean, baselineStd: baseline.std, zScore: z, hour, serverId: server.id },
      });
    }
  }

  return anomalies;
}

function getBaselineStatus() {
  return { lastRefreshAt, serversWithBaseline: baselines.size };
}

const BASELINE_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

function scheduleAnomalyBaselineRefresh() {
  refreshBaselines().catch((err) => console.error('Error calculando baselines de anomalías', err));
  setInterval(() => {
    refreshBaselines().catch((err) => console.error('Error calculando baselines de anomalías', err));
  }, BASELINE_REFRESH_INTERVAL_MS);
}

module.exports = { evaluateAnomalies, refreshBaselines, getBaselineStatus, scheduleAnomalyBaselineRefresh };
