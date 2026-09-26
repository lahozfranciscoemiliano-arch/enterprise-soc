// Pronostico de llenado de disco: regresion lineal sobre el maximo diario de
// uso de C: de los ultimos 14 dias. "Al ritmo actual, C: se llena en 9 dias"
// es mucho mas util que enterarse cuando ya esta al 95%.
//
// Se recalcula una vez por hora para todos los servidores (una sola query
// agregada; nada que hacer en cada telemetria) y se cachea en memoria.
const prisma = require('../prismaClient');
const { isInMaintenance } = require('./alertEngine');
const { createAndDispatchEvent, autoResolveEvents } = require('./eventPipeline');

const WINDOW_DAYS = 14;
const MIN_DAYS = 4; // con menos historia la tendencia no es confiable
const MIN_GROWTH_PER_DAY = 0.05; // % por dia; por debajo se considera estable
const ALERT_HIGH_DAYS = 7;
const ALERT_MEDIUM_DAYS = 21;

let forecasts = new Map(); // serverId -> forecast
let lastRunAt = null;

function linearRegression(points) {
  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  // R^2: que tan "recta" es la tendencia (un salto puntual no es tendencia).
  const meanY = sumY / n;
  const ssTot = points.reduce((s, p) => s + (p.y - meanY) ** 2, 0);
  const ssRes = points.reduce((s, p) => s + (p.y - (slope * p.x + intercept)) ** 2, 0);
  return { slope, intercept, r2: ssTot === 0 ? 1 : 1 - ssRes / ssTot };
}

function computeForecast(daily) {
  if (daily.length < MIN_DAYS) return { status: 'insufficient-data', days: daily.length };
  const t0 = daily[0].day.getTime();
  const points = daily.map((d) => ({ x: (d.day.getTime() - t0) / 86400000, y: d.max }));
  const reg = linearRegression(points);
  if (!reg) return { status: 'insufficient-data', days: daily.length };

  const current = daily[daily.length - 1].max;
  const growthPerDay = reg.slope;
  if (growthPerDay < MIN_GROWTH_PER_DAY) {
    return { status: 'stable', current, growthPerDay: Number(growthPerDay.toFixed(3)), r2: Number(reg.r2.toFixed(2)) };
  }
  const daysTo95 = current >= 95 ? 0 : (95 - current) / growthPerDay;
  const daysToFull = current >= 100 ? 0 : (100 - current) / growthPerDay;
  return {
    status: 'growing',
    current,
    growthPerDay: Number(growthPerDay.toFixed(3)),
    daysTo95: Math.round(daysTo95),
    daysToFull: Math.round(daysToFull),
    fullAt: new Date(Date.now() + daysToFull * 86400000).toISOString(),
    r2: Number(reg.r2.toFixed(2)),
  };
}

async function runDiskForecast() {
  const rows = await prisma.$queryRaw`
    SELECT "serverId", date_trunc('day', "recordedAt") AS day, MAX("diskUsage") AS max
    FROM telemetry
    WHERE "recordedAt" >= NOW() - (${WINDOW_DAYS} || ' days')::interval
    GROUP BY "serverId", day
    ORDER BY "serverId", day
  `;

  const byServer = new Map();
  for (const row of rows) {
    if (!byServer.has(row.serverId)) byServer.set(row.serverId, []);
    byServer.get(row.serverId).push({ day: new Date(row.day), max: Number(row.max) });
  }

  const servers = await prisma.server.findMany({ where: { id: { in: [...byServer.keys()] } } });
  const next = new Map();

  for (const server of servers) {
    const forecast = computeForecast(byServer.get(server.id));
    next.set(server.id, forecast);
    if (isInMaintenance(server)) continue;

    // Solo tendencias consistentes (R^2 >= 0.6): un pico puntual de un
    // archivo temporal no es "el disco se esta llenando".
    const alarming = forecast.status === 'growing' && forecast.r2 >= 0.6 && forecast.daysTo95 <= ALERT_MEDIUM_DAYS;
    if (alarming) {
      // eslint-disable-next-line no-await-in-loop
      await createAndDispatchEvent({
        serverId: server.id,
        serverName: server.name,
        type: 'DISK_FORECAST',
        severity: forecast.daysTo95 <= ALERT_HIGH_DAYS ? 'HIGH' : 'MEDIUM',
        description: `${server.name}: al ritmo actual (+${forecast.growthPerDay.toFixed(2)}%/día) el disco C: llega al 95% en ~${forecast.daysTo95} día(s) y se llena en ~${forecast.daysToFull}. Liberar espacio o ampliar antes.`,
        metadata: forecast,
        dedupKey: 'DISK_FORECAST',
      });
    } else {
      // eslint-disable-next-line no-await-in-loop
      await autoResolveEvents(server.id, ['DISK_FORECAST'], server.name);
    }
  }

  forecasts = next;
  lastRunAt = new Date();
  return { lastRunAt, servers: next.size };
}

function getDiskForecast(serverId) {
  return forecasts.get(serverId) ?? null;
}

function scheduleDiskForecast() {
  setTimeout(() => {
    runDiskForecast().catch((err) => console.error('Error en el pronóstico de disco', err));
    setInterval(() => {
      runDiskForecast().catch((err) => console.error('Error en el pronóstico de disco', err));
    }, 60 * 60 * 1000);
  }, 90 * 1000);
}

module.exports = { runDiskForecast, getDiskForecast, scheduleDiskForecast, computeForecast };
