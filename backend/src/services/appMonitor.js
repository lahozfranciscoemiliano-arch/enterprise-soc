// Monitoreo de aplicaciones de negocio (Monark, ALOHA) y micro-cortes de
// carpetas compartidas / Active Directory. Lo alimenta el agente >= 1.11.0
// cada 60 s (POST /api/agent/apps).
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

const APP_LABEL = { MONARK: 'Monark', ALOHA: 'ALOHA POS' };

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
  const apps = Array.isArray(report.apps) ? report.apps : [];
  const alerts = [];
  const managed = ['APP_SERVICE_DOWN:MONARK', 'APP_SERVICE_DOWN:ALOHA', 'APP_PERFORMANCE:MONARK', 'APP_PERFORMANCE:ALOHA'];

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

  // Sondas (carpetas compartidas, AD, puertos de las aplicaciones).
  const probes = Array.isArray(report.probes) ? report.probes : [];
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
    if (!e?.key || !e.startedAt) continue;
    const startedAt = new Date(e.startedAt);
    if (Number.isNaN(startedAt.getTime())) continue;
    const data = {
      label: String(e.label ?? e.key).slice(0, 200),
      category: ['SMB', 'AD', 'APP'].includes(e.category) ? e.category : 'APP',
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

  // Inestabilidad: 3 o mas micro-cortes en la ultima hora hacia el mismo
  // destino (carpeta compartida / controlador de dominio).
  const since = new Date(now.getTime() - 60 * 60 * 1000);
  const recent = await prisma.microOutage.groupBy({
    by: ['probeKey', 'label', 'category'],
    where: { serverId: server.id, startedAt: { gte: since }, category: { in: ['SMB', 'AD'] } },
    _count: { _all: true },
    _sum: { durationSeconds: true },
  });
  for (const p of probes.filter((x) => x.category === 'SMB' || x.category === 'AD')) managed.push(`NETWORK_MICROCUTS:${p.key}`);
  for (const r of recent) {
    managed.push(`NETWORK_MICROCUTS:${r.probeKey}`);
    if (r._count._all < MICROCUTS_ALERT) continue;
    alerts.push({
      type: 'NETWORK_MICROCUTS',
      severity: 'MEDIUM',
      description: `${server.name}: ${r._count._all} micro-cortes en la última hora hacia ${r.label} (${r._sum.durationSeconds ?? 0} s sin acceso en total). Afecta el uso de ${r.category === 'AD' ? 'inicio de sesión, permisos y unidades de red' : 'la carpeta compartida'}.`,
      metadata: { probeKey: r.probeKey, count: r._count._all },
      dedupKey: `NETWORK_MICROCUTS:${r.probeKey}`,
    });
  }

  await prisma.server.update({ where: { id: server.id }, data: { appRoles: report.roles ?? null } });

  if (!isInMaintenance(server)) {
    await Promise.all(alerts.map((a) => createAndDispatchEvent({ serverId: server.id, serverName: server.name, ...a, silent: true })));
    await resolveCleared(server.id, [...new Set(managed)], alerts.map((a) => a.dedupKey), server.name);
  }
  broadcast({ type: 'APPS_UPDATE', serverId: server.id, at: now.toISOString() });
  return { probeTargets: await probeTargetsFor(server) };
}

// Carpetas compartidas que este servidor tiene que probar: las cargadas en
// Admin (APP_SHARE_TARGETS, una ruta UNC por linea) y, automaticamente, las
// de los servidores de archivos / controladores de dominio del NOC.
function parseUnc(unc) {
  const m = String(unc).trim().match(/^\\\\([^\\]+)\\([^\\]+)/);
  return m ? { host: m[1], share: m[2] } : null;
}

async function probeTargetsFor(server) {
  const cfg = await getSettings(['APP_SHARE_TARGETS']);
  const targets = [];
  const add = (host, share, origin) => {
    const key = `SMB:${host.toLowerCase()}:${share.toLowerCase()}`;
    if (targets.some((t) => t.key === key)) return;
    targets.push({ key, label: `\\\\${host}\\${share}`, category: 'SMB', kind: 'smb', host, share, target: `\\\\${host}\\${share}`, origin });
  };
  for (const line of String(cfg.APP_SHARE_TARGETS ?? '').split(/[\n,;]+/)) {
    const t = parseUnc(line);
    if (t) add(t.host, t.share, 'manual');
  }
  const fileServers = await prisma.server.findMany({ where: { NOT: { id: server.id } }, select: { name: true, hostname: true, ipAddress: true, appRoles: true } });
  for (const fs of fileServers) {
    const roles = fs.appRoles ?? {};
    // Solo servidores de archivos centrales (DC o nombre tipo FS); las
    // carpetas de los ALOHA (BOOTDRV) las usan sus terminales, no la red.
    if (!roles.fileServer || (!roles.dc && !/fs/i.test(fs.name))) continue;
    for (const share of (roles.shares ?? []).filter((s) => !EXCLUDED_SHARES.test(s)).slice(0, 6)) {
      add(fs.hostname || fs.name, share, 'auto');
    }
  }
  return targets.slice(0, MAX_PROBE_TARGETS);
}

// ---------------------------------------------------------------------------
// Consultas para la pestaña Aplicaciones
// ---------------------------------------------------------------------------
async function overview() {
  const [instances, servers] = await Promise.all([
    prisma.appInstance.findMany({ orderBy: [{ appKey: 'asc' }] }),
    prisma.server.findMany({ select: { id: true, name: true, status: true, appRoles: true } }),
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

  // Destinos de red (carpetas / AD): disponibilidad y latencia de 24 h
  // agregadas por destino y por servidor de origen.
  const probeRows = await prisma.$queryRaw`
    SELECT "probeKey", "category", MAX("label") AS label, "serverId",
           SUM("samples") AS samples, SUM("failures") AS failures, SUM("slow") AS slow,
           AVG("avgMs") AS avg, MAX("maxMs") AS max, MAX("at") AS last
    FROM probe_stats WHERE "at" >= NOW() - INTERVAL '24 hours' AND "category" IN ('SMB', 'AD')
    GROUP BY "probeKey", "category", "serverId"`;
  const cuts24 = await prisma.microOutage.groupBy({
    by: ['probeKey', 'serverId'],
    where: { startedAt: { gte: new Date(Date.now() - 86400000) } },
    _count: { _all: true },
    _sum: { durationSeconds: true },
  });
  const cutsKey = new Map(cuts24.map((c) => [`${c.probeKey}|${c.serverId}`, c]));
  const targets = new Map();
  for (const r of probeRows) {
    if (!targets.has(r.probeKey)) targets.set(r.probeKey, { key: r.probeKey, label: r.label, category: r.category, origins: [] });
    const samples = Number(r.samples);
    const failures = Number(r.failures);
    const c = cutsKey.get(`${r.probeKey}|${r.serverId}`);
    targets.get(r.probeKey).origins.push({
      serverId: r.serverId,
      serverName: byId.get(r.serverId)?.name ?? '?',
      availability: samples ? Math.round((1 - failures / samples) * 10000) / 100 : null,
      slowPct: samples ? Math.round((Number(r.slow) / samples) * 1000) / 10 : null,
      avgMs: r.avg === null ? null : Math.round(Number(r.avg)),
      maxMs: r.max === null ? null : Math.round(Number(r.max)),
      microcuts: c?._count._all ?? 0,
      downSeconds: c?._sum.durationSeconds ?? 0,
      lastAt: r.last,
    });
  }
  const ongoing = await prisma.microOutage.findMany({ where: { endedAt: null, startedAt: { gte: new Date(Date.now() - 86400000) } }, orderBy: { startedAt: 'desc' }, take: 50 });

  return {
    instances: instances.map((i) => ({
      ...i,
      serverName: byId.get(i.serverId)?.name ?? '?',
      serverStatus: byId.get(i.serverId)?.status ?? null,
      trend: trendMap.get(trendKey(i.serverId, i.appKey)) ?? [],
    })),
    targets: [...targets.values()].map((t) => ({
      ...t,
      origins: t.origins.sort((a, b) => b.microcuts - a.microcuts || a.serverName.localeCompare(b.serverName)),
      microcuts: t.origins.reduce((a, o) => a + o.microcuts, 0),
      availability: t.origins.length ? Math.min(...t.origins.map((o) => o.availability ?? 100)) : null,
    })),
    ongoing: ongoing.map((o) => ({ ...o, serverName: byId.get(o.serverId)?.name ?? '?' })),
    fileServers: servers.filter((s) => s.appRoles?.fileServer || s.appRoles?.dc).map((s) => ({ id: s.id, name: s.name, dc: Boolean(s.appRoles?.dc), shares: s.appRoles?.shares ?? [] })),
  };
}

// Analisis de micro-cortes: listado + distribucion por hora del dia y por
// dia, y conclusiones en texto (cuando pasan, a donde, desde donde).
async function microcutAnalysis({ days = 7, category, serverId } = {}) {
  const since = new Date(Date.now() - days * 86400000);
  const where = { startedAt: { gte: since }, ...(category ? { category } : {}), ...(serverId ? { serverId } : {}) };
  const [rows, servers] = await Promise.all([
    prisma.microOutage.findMany({ where, orderBy: { startedAt: 'desc' }, take: 2000 }),
    prisma.server.findMany({ select: { id: true, name: true } }),
  ]);
  const names = new Map(servers.map((s) => [s.id, s.name]));
  const tz = process.env.APP_TIMEZONE || 'America/Argentina/Buenos_Aires';
  const hourOf = (d) => Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(d)) % 24;
  const dayOf = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);

  const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, SMB: 0, AD: 0, APP: 0 }));
  const byDayMap = new Map();
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = dayOf(new Date(Date.now() - i * 86400000));
    byDayMap.set(d, { day: d, SMB: 0, AD: 0, APP: 0, seconds: 0 });
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
    const hourTotals = byHour.map((b) => b.SMB + b.AD + b.APP);
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
    if (share >= 25) insights.push(`El ${share}% de los micro-cortes ocurre entre las ${bestH}:00 y las ${(bestH + 2) % 24}:00: revisar qué corre en ese horario (backups, cierres de ALOHA, tareas de sincronización o picos de uso de los locales).`);
    const topT = [...perTarget.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topT) insights.push(`El destino más afectado es ${topT[0]} (${topT[1]} de ${rows.length} cortes).`);
    const topO = [...perOrigin.entries()].sort((a, b) => b[1] - a[1]);
    if (topO.length > 1 && topO[0][1] / rows.length >= 0.5) {
      insights.push(`La mayoría se mide desde ${topO[0][0]} (${topO[0][1]}): el problema parece estar en el enlace o la red de esa sucursal, no en el servidor de destino.`);
    } else if (topO.length > 1) {
      insights.push(`Se miden desde ${topO.length} servidores distintos: si coinciden en horario, el problema está del lado del servidor de destino o del enlace central.`);
    }
    const slow = rows.filter((r) => r.cause.startsWith('lento')).length;
    if (slow / rows.length >= 0.5) insights.push(`${Math.round((slow / rows.length) * 100)}% son por lentitud (no caída total): suele indicar saturación del enlace o del disco del servidor de archivos.`);
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

module.exports = { ingestReport, overview, microcutAnalysis, appHistory, evaluateApp, probeTargetsFor };
