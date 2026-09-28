// Monitoreo de Monark (servicios, procesos, respuesta, SQL) y sus
// micro-cortes. Lo alimenta el agente >= 1.12.0 cada 60 s
// (POST /api/agent/apps). ALOHA, carpetas compartidas y Active Directory se
// sacaron de este monitoreo a pedido.
//
// Todas las alertas de este modulo son SILENCIOSAS: quedan visibles en el
// NOC (pestaña Aplicaciones, listado de alertas) pero no notifican por email,
// Telegram ni la app. Son para analizar la operativa, no para despertar a
// nadie.
const prisma = require('../prismaClient');
const { getSettings } = require('./settings');
const { createAndDispatchEvent, resolveCleared } = require('./eventPipeline');
const { isInMaintenance } = require('./alertEngine');
const { broadcast } = require('../websocket/socketServer');

// Umbrales de "degradado" (medidos desde el propio servidor).
const CPU_DEGRADED = 85; // % CPU de los procesos de la aplicacion
const LATENCY_DEGRADED_MS = 500; // respuesta de sus puertos en localhost
const SQL_SLOW_MS = 1000; // consulta simple a SQL Server
const SQL_LONG_REQUEST_MS = 60000; // consulta corriendo hace mas de 1 min
const MICROCUTS_ALERT = 3; // cortes en la ultima hora para avisar inestabilidad
const MAX_PROBE_TARGETS = 12;
const EXCLUDED_SHARES = /^(netlogon|sysvol|print\$|ipc\$|admin\$|[a-z]\$|bootdrv)$/i;

const APP_LABEL = { MONARK: 'Monark' };

function evaluateApp(app) {
  const m = app.metrics ?? {};
  const problems = [];
  let status = 'ok';
  if (m.servicesDown?.length) {
    status = 'down';
    problems.push(`servicio(s) detenido(s): ${m.servicesDown.join(', ')}`);
  }
  if (app.ports?.length && m.samples && m.portFailures >= m.samples * Math.min(app.ports.length, 4)) {
    status = 'down';
    problems.push('no responde en ninguno de sus puertos');
  }
  const perf = [];
  if ((m.cpuAvg ?? 0) >= CPU_DEGRADED) perf.push(`CPU de la aplicación al ${Math.round(m.cpuAvg)}%`);
  if ((m.latencyAvg ?? 0) >= LATENCY_DEGRADED_MS) perf.push(`responde lento (${Math.round(m.latencyAvg)} ms promedio, máx. ${Math.round(m.latencyMax)} ms)`);
  if (m.portFailures > 0 && status !== 'down') perf.push(`${m.portFailures} intento(s) de conexión sin respuesta`);
  for (const inst of app.sql?.instances ?? []) {
    if (inst.error) perf.push(`SQL ${inst.instance}: ${String(inst.error).slice(0, 120)}`);
    else if ((inst.queryMs ?? 0) >= SQL_SLOW_MS) perf.push(`SQL ${inst.instance} lento (${inst.queryMs} ms por consulta simple)`);
    for (const db of inst.databases ?? []) {
      if (db.blocked > 0) perf.push(`base ${db.name}: ${db.blocked} consulta(s) bloqueada(s)`);
      if (db.longestMs >= SQL_LONG_REQUEST_MS) perf.push(`base ${db.name}: una consulta lleva ${Math.round(db.longestMs / 1000)} s`);
    }
  }
  if (perf.length && status === 'ok') status = 'degraded';
  return { status, problems, perf };
}

function sqlSummary(sql) {
  const inst = (sql?.instances ?? []).filter((i) => !i.error);
  if (!inst.length) return { sqlMs: null, blocked: null };
  return {
    sqlMs: Math.max(...inst.map((i) => i.queryMs ?? 0)),
    blocked: inst.reduce((a, i) => a + (i.databases ?? []).reduce((b, d) => b + (d.blocked ?? 0), 0), 0),
  };
}

async function ingestReport(server, report) {
  const now = new Date();
  // Solo Monark (un agente viejo puede mandar tambien ALOHA: se ignora).
  const apps = (Array.isArray(report.apps) ? report.apps : []).filter((a) => APP_LABEL[a.key]);
  const alerts = [];
  const managed = ['APP_SERVICE_DOWN:MONARK', 'APP_PERFORMANCE:MONARK'];

  for (const app of apps) {
    if (!APP_LABEL[app.key]) continue;
    const { status, problems, perf } = evaluateApp(app);
    const detected = {
      services: app.services ?? [],
      processNames: app.processNames ?? [],
      installed: app.installed ?? [],
      databases: app.databases ?? [],
      shares: app.shares ?? [],
      ports: app.ports ?? [],
    };
    const statusInfo = [...problems, ...perf].join(' · ') || null;
    await prisma.appInstance.upsert({
      where: { serverId_appKey: { serverId: server.id, appKey: app.key } },
      create: { serverId: server.id, appKey: app.key, label: APP_LABEL[app.key], status, statusInfo, detected, metrics: app.metrics ?? null, sql: app.sql ?? null, lastSeenAt: now },
      update: { status, statusInfo, detected, metrics: app.metrics ?? null, ...(app.sql ? { sql: app.sql } : {}), lastSeenAt: now },
    });
    const m = app.metrics ?? {};
    const { sqlMs, blocked } = sqlSummary(app.sql);
    await prisma.appSample.create({
      data: {
        serverId: server.id,
        appKey: app.key,
        at: now,
        cpu: m.cpuAvg ?? null,
        memMb: m.memMb ?? null,
        latencyMs: m.latencyAvg ?? null,
        latencyMax: m.latencyMax ?? null,
        sqlMs,
        blocked,
        servicesDown: m.servicesDown?.length ?? 0,
        restarts: m.restarts ?? 0,
      },
    });

    if (problems.length) {
      alerts.push({
        type: 'APP_SERVICE_DOWN',
        severity: 'HIGH',
        description: `${server.name}: ${APP_LABEL[app.key]} con problemas — ${problems.join('; ')}.`,
        metadata: { app: app.key },
        dedupKey: `APP_SERVICE_DOWN:${app.key}`,
      });
    }
    if (perf.length) {
      alerts.push({
        type: 'APP_PERFORMANCE',
        severity: 'MEDIUM',
        description: `${server.name}: ${APP_LABEL[app.key]} lento o saturado — ${perf.join('; ')}.`,
        metadata: { app: app.key, cpu: m.cpuAvg, latencyMs: m.latencyAvg },
        dedupKey: `APP_PERFORMANCE:${app.key}`,
        // 3 minutos seguidos: un pico de un minuto no es saturacion.
        confirmations: 3,
      });
    }
  }
  // Aplicacion que ya no se detecta en este servidor: se da de baja.
  if (Array.isArray(report.apps)) {
    await prisma.appInstance.deleteMany({ where: { serverId: server.id, appKey: { notIn: apps.map((a) => a.key) } } });
  }

  // Sondas: solo las de la propia aplicacion (puertos/servicios de Monark);
  // las de carpetas compartidas y AD de agentes viejos se descartan.
  const isMonarkKey = (k) => String(k ?? '').startsWith('MONARK:');
  const probes = (Array.isArray(report.probes) ? report.probes : []).filter((p) => isMonarkKey(p.key));
  if (probes.length) {
    await prisma.probeStat.createMany({
      data: probes.map((p) => ({
        serverId: server.id,
        probeKey: String(p.key).slice(0, 200),
        label: String(p.label ?? p.key).slice(0, 200),
        category: String(p.category ?? 'APP'),
        kind: String(p.kind ?? 'tcp'),
        target: p.target ? String(p.target).slice(0, 200) : null,
        at: now,
        samples: p.samples ?? 0,
        failures: p.failures ?? 0,
        slow: p.slow ?? 0,
        avgMs: p.avgMs ?? null,
        maxMs: p.maxMs ?? null,
        p95Ms: p.p95Ms ?? null,
      })),
    });
  }

  // Micro-cortes: cerrados y en curso (upsert por inicio).
  for (const e of Array.isArray(report.events) ? report.events : []) {
    if (!e?.key || !e.startedAt || !isMonarkKey(e.key)) continue;
    const startedAt = new Date(e.startedAt);
    if (Number.isNaN(startedAt.getTime())) continue;
    const data = {
      label: String(e.label ?? e.key).slice(0, 200),
      category: 'APP',
      cause: String(e.cause ?? 'sin respuesta').slice(0, 120),
      target: e.detail ? String(e.detail).slice(0, 200) : null,
      endedAt: e.endedAt ? new Date(e.endedAt) : null,
      durationSeconds: e.durationSeconds ?? null,
    };
    await prisma.microOutage.upsert({
      where: { serverId_probeKey_startedAt: { serverId: server.id, probeKey: String(e.key).slice(0, 200), startedAt } },
      create: { serverId: server.id, probeKey: String(e.key).slice(0, 200), startedAt, ...data },
      update: data,
    });
  }


  if (!isInMaintenance(server)) {
    await Promise.all(alerts.map((a) => createAndDispatchEvent({ serverId: server.id, serverName: server.name, ...a, silent: true })));
    await resolveCleared(server.id, [...new Set(managed)], alerts.map((a) => a.dedupKey), server.name);
  }
  broadcast({ type: 'APPS_UPDATE', serverId: server.id, at: now.toISOString() });
  return { probeTargets: [] };
}

// ---------------------------------------------------------------------------
// Consultas para la pestaña Aplicaciones
// ---------------------------------------------------------------------------
async function overview() {
  const [instances, servers] = await Promise.all([
    prisma.appInstance.findMany({ where: { appKey: 'MONARK' }, orderBy: [{ appKey: 'asc' }] }),
    prisma.server.findMany({ select: { id: true, name: true, status: true } }),
  ]);
  const byId = new Map(servers.map((s) => [s.id, s]));

  // Tendencia de 24 h por instancia (cada 20 min).
  const trend = await prisma.$queryRaw`
    SELECT "serverId", "appKey", date_bin('20 minutes'::interval, "at", TIMESTAMP '2000-01-01') AS t,
           AVG("cpu") AS cpu, AVG("latencyMs") AS lat, MAX("latencyMax") AS "latMax", MAX("sqlMs") AS sql,
           SUM("servicesDown") AS down, SUM("restarts") AS restarts
    FROM app_samples WHERE "at" >= NOW() - INTERVAL '24 hours'
    GROUP BY "serverId", "appKey", t ORDER BY t`;
  const trendKey = (s, a) => `${s}|${a}`;
  const trendMap = new Map();
  for (const r of trend) {
    const k = trendKey(r.serverId, r.appKey);
    if (!trendMap.has(k)) trendMap.set(k, []);
    const num = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);
    trendMap.get(k).push({ t: r.t, cpu: num(r.cpu), lat: num(r.lat), latMax: num(r.latMax), sql: num(r.sql), down: Number(r.down ?? 0), restarts: Number(r.restarts ?? 0) });
  }

  const ongoing = await prisma.microOutage.findMany({ where: { category: 'APP', endedAt: null, startedAt: { gte: new Date(Date.now() - 86400000) } }, orderBy: { startedAt: 'desc' }, take: 50 });

  return {
    instances: instances.map((i) => ({
      ...i,
      serverName: byId.get(i.serverId)?.name ?? '?',
      serverStatus: byId.get(i.serverId)?.status ?? null,
      trend: trendMap.get(trendKey(i.serverId, i.appKey)) ?? [],
    })),
    ongoing: ongoing.map((o) => ({ ...o, serverName: byId.get(o.serverId)?.name ?? '?' })),
    microcuts24h: await prisma.microOutage.count({ where: { category: 'APP', startedAt: { gte: new Date(Date.now() - 86400000) } } }),
  };
}

// Analisis de micro-cortes: listado + distribucion por hora del dia y por
// dia, y conclusiones en texto (cuando pasan, a donde, desde donde).
async function microcutAnalysis({ days = 7, serverId } = {}) {
  const since = new Date(Date.now() - days * 86400000);
  const where = { startedAt: { gte: since }, category: 'APP', ...(serverId ? { serverId } : {}) };
  const [rows, servers] = await Promise.all([
    prisma.microOutage.findMany({ where, orderBy: { startedAt: 'desc' }, take: 2000 }),
    prisma.server.findMany({ select: { id: true, name: true } }),
  ]);
  const names = new Map(servers.map((s) => [s.id, s.name]));
  const tz = process.env.APP_TIMEZONE || 'America/Argentina/Buenos_Aires';
  const hourOf = (d) => Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(d)) % 24;
  const dayOf = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);

  const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, APP: 0 }));
  const byDayMap = new Map();
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = dayOf(new Date(Date.now() - i * 86400000));
    byDayMap.set(d, { day: d, APP: 0, seconds: 0 });
  }
  const perTarget = new Map();
  const perOrigin = new Map();
  let totalSeconds = 0;
  for (const r of rows) {
    const h = hourOf(r.startedAt);
    byHour[h][r.category] = (byHour[h][r.category] ?? 0) + 1;
    const d = byDayMap.get(dayOf(r.startedAt));
    if (d) {
      d[r.category] += 1;
      d.seconds += r.durationSeconds ?? 0;
    }
    totalSeconds += r.durationSeconds ?? 0;
    perTarget.set(r.label, (perTarget.get(r.label) ?? 0) + 1);
    const origin = names.get(r.serverId) ?? '?';
    perOrigin.set(origin, (perOrigin.get(origin) ?? 0) + 1);
  }

  const insights = [];
  if (rows.length) {
    const hourTotals = byHour.map((b) => b.APP);
    // Franja de 2 horas con mas cortes.
    let best = 0;
    let bestH = 0;
    for (let h = 0; h < 24; h += 1) {
      const v = hourTotals[h] + hourTotals[(h + 1) % 24];
      if (v > best) {
        best = v;
        bestH = h;
      }
    }
    const share = Math.round((best / rows.length) * 100);
    if (share >= 25) insights.push(`El ${share}% de los cortes de Monark ocurre entre las ${bestH}:00 y las ${(bestH + 2) % 24}:00: revisar qué corre en ese horario (backups, procesos masivos, sincronizaciones o picos de uso).`);
    const topT = [...perTarget.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topT) insights.push(`El componente más afectado es ${topT[0]} (${topT[1]} de ${rows.length} cortes).`);
    const topO = [...perOrigin.entries()].sort((a, b) => b[1] - a[1]);
    if (topO.length > 1) insights.push(`Servidor con más cortes: ${topO[0][0]} (${topO[0][1]}).`);
    const slow = rows.filter((r) => r.cause.startsWith('lento')).length;
    if (slow / rows.length >= 0.5) insights.push(`${Math.round((slow / rows.length) * 100)}% son por lentitud (no caída total): suele indicar saturación de CPU, disco o SQL del servidor.`);
    const restarts = rows.filter((r) => r.cause === 'reinicio').length;
    if (restarts) insights.push(`${restarts} reinicio(s) de procesos de Monark: revisar el Visor de eventos (Application) por errores o cierres inesperados.`);
    const avgSec = Math.round(totalSeconds / rows.length);
    insights.push(`Duración promedio: ${avgSec} s; ${Math.round(totalSeconds / 60)} min sin acceso en total en ${days} días.`);
  }

  return {
    days,
    total: rows.length,
    totalSeconds,
    ongoing: rows.filter((r) => !r.endedAt).length,
    byHour,
    byDay: [...byDayMap.values()],
    insights,
    events: rows.slice(0, 500).map((r) => ({ ...r, serverName: names.get(r.serverId) ?? '?' })),
  };
}

async function appHistory(serverId, appKey, hours = 24) {
  const bucket = hours <= 6 ? '1 minute' : hours <= 48 ? '10 minutes' : '1 hour';
  const rows = await prisma.$queryRaw`
    SELECT date_bin(${bucket}::interval, "at", TIMESTAMP '2000-01-01') AS t,
           AVG("cpu") AS cpu, MAX("memMb") AS mem, AVG("latencyMs") AS lat, MAX("latencyMax") AS "latMax",
           MAX("sqlMs") AS sql, MAX("blocked") AS blocked, SUM("servicesDown") AS down, SUM("restarts") AS restarts
    FROM app_samples
    WHERE "serverId" = ${serverId} AND "appKey" = ${appKey} AND "at" >= NOW() - (${hours} || ' hours')::interval
    GROUP BY t ORDER BY t`;
  const num = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);
  return rows.map((r) => ({ t: r.t, cpu: num(r.cpu), mem: num(r.mem), lat: num(r.lat), latMax: num(r.latMax), sql: num(r.sql), blocked: num(r.blocked), down: Number(r.down ?? 0), restarts: Number(r.restarts ?? 0) }));
}

// Al arrancar: se borra lo que quedo del monitoreo de ALOHA, carpetas
// compartidas y AD (ya no se monitorean) y se cierran sus alertas.
async function purgeRemovedMonitoring() {
  try {
    await prisma.appInstance.deleteMany({ where: { appKey: { not: 'MONARK' } } });
    await prisma.appSample.deleteMany({ where: { appKey: { not: 'MONARK' } } });
    await prisma.probeStat.deleteMany({ where: { NOT: { probeKey: { startsWith: 'MONARK:' } } } });
    await prisma.microOutage.deleteMany({ where: { NOT: { probeKey: { startsWith: 'MONARK:' } } } });
    await prisma.$executeRaw`UPDATE servers SET "appRoles" = NULL WHERE "appRoles" IS NOT NULL`;
    const now = new Date();
    await prisma.securityEvent.updateMany({
      where: {
        status: { in: ['OPEN', 'ACKNOWLEDGED'] },
        OR: [{ type: 'NETWORK_MICROCUTS' }, { dedupKey: { in: ['APP_SERVICE_DOWN:ALOHA', 'APP_PERFORMANCE:ALOHA'] } }],
      },
      data: { status: 'RESOLVED', resolvedAt: now, autoResolved: true },
    });
  } catch (err) {
    console.error('No se pudo limpiar el monitoreo de ALOHA/carpetas/AD', err.message);
  }
}

module.exports = { ingestReport, overview, microcutAnalysis, appHistory, evaluateApp, purgeRemovedMonitoring };
