const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const prisma = require('../prismaClient');
const { withLatest } = require('./latest');
const { getSettings } = require('./settings');
const { getHealthStatus, getEffectiveDefaultThresholds } = require('./alertEngine');
const { sendReportEmail } = require('./notifications');
const { generateReportInsights } = require('./gemini');
const { getDiskForecast } = require('./diskForecast');
const { drawReportPdf } = require('./reportPdf');
const { loadBackupPolicy, backupMode } = require('./backupPolicy');

// Los PDF generados se guardan aca, igual que el .exe del agente en
// server.js (DOWNLOADS_DIR): sobreviven a un "docker compose up --build"
// porque el directorio esta montado como volumen (ver docker-compose.yml).
const REPORTS_DIR = path.join(__dirname, '..', '..', 'reports');
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

const MAX_STORED_REPORTS = 60;
const FILENAME_RE = /^enterprise-soc-report-\d{4}-\d{2}-\d{2}T\d{6}Z\.pdf$/;

function isValidReportFilename(name) {
  return typeof name === 'string' && FILENAME_RE.test(name);
}

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

// Recolecta todo lo que necesita el reporte con las mismas consultas/logica
// que ya usa el dashboard (getHealthStatus, umbrales efectivos), para que el
// PDF nunca muestre un numero distinto al que se ve en pantalla en ese
// momento.
async function collectReportData(periodDays) {
  const now = new Date();
  const periodStart = new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000);
  const periodMs = now - periodStart;
  // Serie temporal: por hora en reportes de hasta 2 dias, por dia el resto.
  const hourly = periodDays <= 2;
  const bucket = hourly ? '1 hour' : '1 day';

  const [servers, defaultThresholds, eventsInPeriod, resolvedInPeriod, fortiEventsInPeriod, fortiCriticalInPeriod, offlineEvents, fleetTrend] =
    await Promise.all([
      prisma.server.findMany({ orderBy: { name: 'asc' } }).then(withLatest),
      getEffectiveDefaultThresholds(),
      prisma.securityEvent.findMany({
        where: { createdAt: { gte: periodStart } },
        include: { server: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.securityEvent.findMany({
        where: { status: 'RESOLVED', resolvedAt: { gte: periodStart, not: null } },
        select: { createdAt: true, resolvedAt: true, severity: true },
      }),
      prisma.fortiEvent.count({ where: { createdAt: { gte: periodStart } } }),
      prisma.fortiEvent.count({ where: { createdAt: { gte: periodStart }, severity: 'CRITICAL' } }),
      // Caidas de agente que se superponen con el periodo (disponibilidad).
      prisma.securityEvent.findMany({
        where: { type: 'AGENT_OFFLINE', OR: [{ resolvedAt: null }, { resolvedAt: { gte: periodStart } }], createdAt: { lte: now } },
        select: { serverId: true, createdAt: true, resolvedAt: true },
      }),
      prisma.$queryRaw`
        SELECT date_bin(${bucket}::interval, "recordedAt", TIMESTAMP '2000-01-01') AS t,
               AVG("cpuUsage") AS cpu, AVG("memoryUsage") AS mem, MAX("diskUsage") AS disk
        FROM telemetry
        WHERE "recordedAt" >= ${periodStart}
        GROUP BY t ORDER BY t
      `,
    ]);

  const backupPolicy = await loadBackupPolicy();
  const healthBreakdown = { OK: 0, WARNING: 0, CRITICAL: 0, UNKNOWN: 0 };
  const backupBreakdown = { SUCCESS: 0, RUNNING: 0, WARNING: 0, FAILED: 0, NOT_CONFIGURED: 0, UNKNOWN: 0 };
  const serverRows = [];

  // Alertas por servidor y tipo en el periodo.
  const alertsByServer = new Map();
  const alertsByType = new Map();
  for (const e of eventsInPeriod) {
    alertsByServer.set(e.serverId, (alertsByServer.get(e.serverId) ?? 0) + 1);
    alertsByType.set(e.type, (alertsByType.get(e.type) ?? 0) + 1);
  }

  // Disponibilidad por servidor = 1 - tiempo caido (AGENT_OFFLINE) / periodo.
  const downMs = new Map();
  for (const e of offlineEvents) {
    const from = Math.max(e.createdAt.getTime(), periodStart.getTime());
    const to = Math.min((e.resolvedAt ?? now).getTime(), now.getTime());
    if (to > from) downMs.set(e.serverId, (downMs.get(e.serverId) ?? 0) + (to - from));
  }

  const disksAtRisk = [];
  let rebootPending = 0;
  let patchesOutdated = 0;
  let failedLogons = 0;
  let malwareDetections = 0;
  for (const s of servers) {
    const health = getHealthStatus(s.telemetry[0], s, defaultThresholds);
    healthBreakdown[health] += 1;
    // La VPS del NOC no tiene backups: no suma a "sin datos".
    const excluded = backupMode(s, backupPolicy) === 'EXCLUDED';
    const backupResult = excluded ? 'EXCLUDED' : s.backups[0]?.result ?? 'UNKNOWN';
    if (!excluded) backupBreakdown[backupResult] += 1;
    const availability = Math.max(0, 100 - ((downMs.get(s.id) ?? 0) / periodMs) * 100);

    const d = s.diagnostics ?? {};
    for (const v of Array.isArray(d.volumes) ? d.volumes : []) {
      if (typeof v.percent === 'number' && v.percent >= 85) disksAtRisk.push({ server: s.name, mount: v.mount, percent: v.percent, freeBytes: v.freeBytes ?? null });
    }
    if (!Array.isArray(d.volumes) && (s.telemetry[0]?.diskUsage ?? 0) >= 85) {
      disksAtRisk.push({ server: s.name, mount: 'C:', percent: s.telemetry[0].diskUsage, freeBytes: null });
    }
    const forecast = getDiskForecast(s.id);
    if (forecast?.status === 'growing' && forecast.r2 >= 0.6 && forecast.daysTo95 <= 30) {
      const row = disksAtRisk.find((x) => x.server === s.name && x.mount === 'C:');
      if (row) row.daysTo95 = forecast.daysTo95;
      else disksAtRisk.push({ server: s.name, mount: 'C:', percent: s.telemetry[0]?.diskUsage ?? null, freeBytes: null, daysTo95: forecast.daysTo95 });
    }
    if (d.rebootPending) rebootPending += 1;
    const lastPatch = d.updates?.lastInstalledAt ? new Date(d.updates.lastInstalledAt) : null;
    if ((lastPatch && now - lastPatch > 45 * 86400000) || d.updates?.pendingCritical > 0) patchesOutdated += 1;
    failedLogons += Number(d.eventSignals?.failedLogons ?? 0);
    malwareDetections += Number(d.eventSignals?.malwareDetections ?? 0);

    serverRows.push({
      name: s.name,
      tags: s.tags,
      health,
      status: s.status,
      cpuUsage: s.telemetry[0]?.cpuUsage ?? null,
      memoryUsage: s.telemetry[0]?.memoryUsage ?? null,
      diskUsage: s.telemetry[0]?.diskUsage ?? null,
      lastSeenAt: s.lastSeenAt,
      backupResult,
      backupLastAt: s.backups[0]?.lastBackupAt ?? null,
      backupSizeBytes: excluded ? null : s.backups[0]?.sizeBytes ?? null,
      alerts: alertsByServer.get(s.id) ?? 0,
      availability,
      uptimeSeconds: d.uptimeSeconds ?? null,
    });
  }
  disksAtRisk.sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0));

  const reportedServers = servers.length - healthBreakdown.UNKNOWN;
  const slaPercentage = reportedServers > 0 ? Math.round((healthBreakdown.OK / reportedServers) * 10000) / 100 : 0;
  const availabilityAvg = serverRows.length ? Math.round((serverRows.reduce((a, r) => a + r.availability, 0) / serverRows.length) * 100) / 100 : null;

  const severityCounts = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
  const offenders = new Map(); // serverName -> count
  for (const e of eventsInPeriod) {
    severityCounts[e.severity] = (severityCounts[e.severity] ?? 0) + 1;
    const name = e.server?.name ?? '?';
    offenders.set(name, (offenders.get(name) ?? 0) + 1);
  }
  const topOffenders = [...offenders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const topTypes = [...alertsByType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

  // Linea de tiempo de alertas por severidad.
  const stepMs = hourly ? 3600000 : 86400000;
  const firstBucket = hourly
    ? new Date(Math.floor(periodStart.getTime() / stepMs) * stepMs)
    : new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth(), periodStart.getUTCDate()));
  const bucketsCount = Math.max(1, Math.ceil((now - firstBucket) / stepMs));
  const timeline = Array.from({ length: bucketsCount }, (_, i) => ({ t: new Date(firstBucket.getTime() + i * stepMs), LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 }));
  for (const e of eventsInPeriod) {
    const idx = Math.floor((e.createdAt - firstBucket) / stepMs);
    if (timeline[idx]) timeline[idx][e.severity] += 1;
  }

  let avgResolutionMinutes = null;
  if (resolvedInPeriod.length > 0) {
    const totalMs = resolvedInPeriod.reduce((sum, e) => sum + (e.resolvedAt.getTime() - e.createdAt.getTime()), 0);
    avgResolutionMinutes = Math.round(totalMs / resolvedInPeriod.length / 60000);
  }

  const stillOpenCritical = eventsInPeriod.filter((e) => e.status !== 'RESOLVED' && e.severity === 'CRITICAL');
  const openNow = eventsInPeriod.filter((e) => e.status !== 'RESOLVED');
  const outages = eventsInPeriod.filter((e) => e.type === 'INTERNET_OUTAGE');
  const outageMinutes = Math.round(outages.reduce((a, e) => a + Number(e.metadata?.durationSeconds ?? 0), 0) / 60);

  // Inventario de red (si hay un servidor con AD/DHCP reportando).
  const [endpointsTotal, endpointsOnline, printers, lockedUsers, expiringPasswords, scopes, lockouts, privChanges, logonsInPeriod, unifiSites] =
    await Promise.all([
      prisma.endpoint.count(),
      prisma.endpoint.count({ where: { online: true } }),
      prisma.printer.findMany({ select: { name: true, id: true, online: true, errors: true, supplies: true } }),
      prisma.directoryUser.count({ where: { enabled: true, lockedOut: true } }),
      prisma.directoryUser.count({
        where: { enabled: true, neverExpires: false, passwordExpiresAt: { gte: new Date(), lte: new Date(Date.now() + 7 * 86400000) } },
      }),
      prisma.dhcpScope.findMany({ select: { id: true, name: true, percentInUse: true, free: true } }),
      prisma.directoryEvent.count({ where: { kind: 'lockout', at: { gte: periodStart } } }),
      prisma.directoryEvent.count({ where: { kind: 'group_member_added', at: { gte: periodStart } } }),
      prisma.logonEvent.count({ where: { at: { gte: periodStart } } }),
      prisma.unifiSite.findMany({ select: { hostName: true, siteName: true, hostOnline: true, wifiDevices: true, offlineWifi: true, wiredDevices: true, offlineWired: true, wifiClients: true } }),
    ]);
  const inventory = {
    endpointsTotal,
    endpointsOnline,
    printersTotal: printers.length,
    printersWithIssues: printers.filter((p) => !p.online || p.errors.length > 0).map((p) => `${p.name ?? p.id}${p.online ? `: ${p.errors.join(', ')}` : ': sin respuesta'}`),
    lowSupplies: printers.flatMap((p) =>
      (Array.isArray(p.supplies) ? p.supplies : []).filter((x) => x.percent !== null && x.percent <= 15).map((x) => `${p.name ?? p.id} — ${x.name} ${x.percent}%`)
    ),
    lockedUsers,
    expiringPasswords,
    scopes,
    lockouts,
    privChanges,
    logonsInPeriod,
  };
  const unifi = {
    sites: unifiSites.length,
    sitesOffline: unifiSites.filter((x) => x.hostOnline === false).length,
    aps: unifiSites.reduce((a, x) => a + x.wifiDevices, 0),
    apsOffline: unifiSites.reduce((a, x) => a + x.offlineWifi, 0),
    switches: unifiSites.reduce((a, x) => a + x.wiredDevices, 0),
    clients: unifiSites.reduce((a, x) => a + x.wifiClients, 0),
  };

  return {
    generatedAt: now,
    periodDays,
    periodStart,
    hourly,
    totalServers: servers.length,
    onlineServers: servers.filter((s) => s.status === 'ONLINE').length,
    slaPercentage,
    availabilityAvg,
    healthBreakdown,
    backupBreakdown,
    serverRows,
    eventsOpenedInPeriod: eventsInPeriod.length,
    eventsResolvedInPeriod: resolvedInPeriod.length,
    openNow: openNow.length,
    severityCounts,
    avgResolutionMinutes,
    topOffenders,
    topTypes,
    timeline,
    fleetTrend: fleetTrend.map((r) => ({ t: new Date(r.t), cpu: r.cpu === null ? null : Number(r.cpu), mem: r.mem === null ? null : Number(r.mem), disk: r.disk === null ? null : Number(r.disk) })),
    stillOpenCritical,
    fortiEventsInPeriod,
    fortiCriticalInPeriod,
    disksAtRisk,
    rebootPending,
    patchesOutdated,
    failedLogons,
    malwareDetections,
    outages: outages.length,
    outageMinutes,
    inventory,
    unifi,
  };
}

// Recomendaciones por reglas: se usan si la IA no esta configurada o falla,
// y tambien se le pasan a la IA como base para que priorice.
function buildRuleInsights(data) {
  const recs = [];
  const add = (priority, title, detail) => recs.push({ priority, title, detail });
  const failedBackups = data.serverRows.filter((s) => s.backupResult === 'FAILED').map((s) => s.name);
  const warnBackups = data.serverRows.filter((s) => s.backupResult === 'WARNING').map((s) => s.name);
  const offline = data.serverRows.filter((s) => s.status === 'OFFLINE').map((s) => s.name);
  const lowAvail = data.serverRows.filter((s) => s.availability < 99).map((s) => `${s.name} (${s.availability.toFixed(1)}%)`);
  if (offline.length) add('ALTA', `Recuperar ${offline.length} servidor(es) sin reportar`, `${offline.join(', ')}: verificar energía, red y el servicio del agente.`);
  if (failedBackups.length) add('ALTA', `Corregir ${failedBackups.length} backup(s) fallido(s)`, `${failedBackups.join(', ')}: revisar el destino, el espacio disponible y el log del último trabajo; sin backup no hay recuperación ante ransomware o falla de disco.`);
  if (data.stillOpenCritical.length) add('ALTA', `Cerrar ${data.stillOpenCritical.length} alerta(s) crítica(s) abiertas`, 'Asignar responsable y fecha a cada una; revisar el triage sugerido en el NOC.');
  const fullDisks = data.disksAtRisk.filter((d) => d.percent >= 90 || (d.daysTo95 && d.daysTo95 <= 14));
  if (fullDisks.length) add('ALTA', `Liberar o ampliar ${fullDisks.length} disco(s) casi llenos`, fullDisks.slice(0, 6).map((d) => `${d.server} ${d.mount} ${Math.round(d.percent ?? 0)}%`).join(', ') + '.');
  if (data.malwareDetections) add('ALTA', 'Investigar detecciones de malware', `${data.malwareDetections} detección(es) de Microsoft Defender: confirmar la cuarentena y el origen.`);
  if (warnBackups.length) add('MEDIA', `Revisar ${warnBackups.length} backup(s) con advertencias`, warnBackups.join(', ') + '.');
  if (lowAvail.length) add('MEDIA', 'Mejorar la disponibilidad de servidores inestables', `Por debajo del 99% en el período: ${lowAvail.slice(0, 6).join(', ')}. Revisar UPS, energía y conectividad.`);
  if (data.outageMinutes > 30) add('MEDIA', 'Reclamar al proveedor de internet', `${data.outages} corte(s), ${data.outageMinutes} minutos sin servicio en total. Evaluar enlace de respaldo donde no exista.`);
  if (data.patchesOutdated) add('MEDIA', `Actualizar Windows en ${data.patchesOutdated} servidor(es)`, 'Programar una ventana de mantenimiento para parches y reinicios pendientes.');
  const fullScopes = data.inventory.scopes.filter((s) => s.percentInUse >= 90);
  if (fullScopes.length) add('MEDIA', 'Ampliar ámbitos DHCP casi agotados', fullScopes.map((s) => `${s.name ?? s.id} ${Math.round(s.percentInUse)}%`).join(', ') + '.');
  if (data.inventory.lowSupplies.length) add('BAJA', `Reponer ${data.inventory.lowSupplies.length} consumible(s) de impresoras`, data.inventory.lowSupplies.slice(0, 4).join('; ') + '.');
  if (data.rebootPending) add('BAJA', `Reiniciar ${data.rebootPending} servidor(es) con reinicio pendiente`, 'Fuera del horario de atención de los locales.');
  if (recs.length === 0) add('BAJA', 'Mantener el monitoreo y las pruebas de restauración', 'Sin problemas relevantes en el período: probar la restauración de un backup al mes para validar que sirven.');

  const h = data.healthBreakdown;
  const summary =
    `En el período se monitorearon ${data.totalServers} servidores, con una disponibilidad promedio de ${data.availabilityAvg ?? '—'}%. ` +
    `${h.OK} están en estado normal${h.WARNING + h.CRITICAL ? ` y ${h.WARNING + h.CRITICAL} requieren atención` : ''}. ` +
    `Se generaron ${data.eventsOpenedInPeriod} alertas (${data.severityCounts.CRITICAL} críticas) y ${data.backupBreakdown.FAILED ? `hay ${data.backupBreakdown.FAILED} backup(s) fallido(s)` : 'los backups están al día'}.`;
  return { source: 'rules', summary, recommendations: recs.slice(0, 7) };
}

function buildPdfBuffer(data) {
  return new Promise((resolve, reject) => {
    // Margen inferior chico: el pie de pagina se dibuja a mano cerca del
    // borde; el limite del contenido lo maneja reportPdf.js (bufferPages
    // para numerar "Pagina X de Y" al final).
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 40, bottom: 10, left: 40, right: 40 },
      bufferPages: true,
      info: { Title: 'Reporte ejecutivo NOC/SOC - Grupo Bistro', Author: 'Enterprise SOC' },
    });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    drawReportPdf(doc, data);
    doc.end();
  });
}

function reportFilename(date = new Date()) {
  const datePart = date.toISOString().slice(0, 10); // YYYY-MM-DD
  const timePart = date.toISOString().slice(11, 19).replace(/:/g, ''); // HHMMSS
  return `enterprise-soc-report-${datePart}T${timePart}Z.pdf`;
}

function csvEscape(value) {
  const str = String(value ?? '');
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

// CSV con el detalle por servidor del periodo -- complementa el PDF para
// quien prefiera abrirlo en Excel y manipular los numeros (filtrar, armar
// su propio grafico, pegar en otro reporte).
function buildReportCsv(data) {
  const header = ['servidor', 'tags', 'salud', 'cpuUsage', 'memoryUsage', 'diskUsage', 'backupResult', 'ultimoBackup'];
  const rows = data.serverRows.map((s) => [
    s.name,
    s.tags.join('|'),
    s.health,
    s.cpuUsage ?? '',
    s.memoryUsage ?? '',
    s.diskUsage ?? '',
    s.backupResult,
    s.backupLastAt ? new Date(s.backupLastAt).toISOString() : '',
  ]);

  const lines = [header, ...rows].map((row) => row.map(csvEscape).join(','));
  return `﻿${lines.join('\n')}\n`; // BOM: para que Excel detecte UTF-8 solo
}

async function generateReportCsv({ periodDays = 7 } = {}) {
  const data = await collectReportData(periodDays);
  return buildReportCsv(data);
}

function pruneOldReports() {
  const files = fs
    .readdirSync(REPORTS_DIR)
    .filter(isValidReportFilename)
    .sort()
    .reverse();
  for (const file of files.slice(MAX_STORED_REPORTS)) {
    try {
      fs.unlinkSync(path.join(REPORTS_DIR, file));
    } catch (err) {
      console.error('Error borrando reporte viejo', file, err);
    }
  }
}

async function generateAndStoreReport({ periodDays = 7 } = {}) {
  const data = await collectReportData(periodDays);
  const rules = buildRuleInsights(data);
  data.insights = (await generateReportInsights(data, rules)) ?? rules;
  const buffer = await buildPdfBuffer(data);
  const filename = reportFilename(data.generatedAt);
  fs.writeFileSync(path.join(REPORTS_DIR, filename), buffer);
  pruneOldReports();
  return { filename, buffer, data };
}

function listReports() {
  return fs
    .readdirSync(REPORTS_DIR)
    .filter(isValidReportFilename)
    .map((filename) => {
      const stat = fs.statSync(path.join(REPORTS_DIR, filename));
      return { filename, sizeBytes: stat.size, sizeLabel: formatBytes(stat.size), createdAt: stat.mtime };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

function getReportPath(filename) {
  if (!isValidReportFilename(filename)) return null;
  const full = path.join(REPORTS_DIR, filename);
  return fs.existsSync(full) ? full : null;
}

// Chequeo periodico (no un cron real): compara la config guardada contra
// cuando se mando el ultimo reporte (REPORT_LAST_SENT_AT, guardado directo
// en la tabla Setting sin pasar por el modulo settings.js porque es un dato
// interno, no algo que el panel deba mostrar como campo editable). Correr
// esto cada 15 minutos es mas que suficiente precision para un reporte
// diario/semanal.
async function maybeSendScheduledReport() {
  const cfg = await getSettings(['REPORT_ENABLED', 'REPORT_FREQUENCY', 'REPORT_HOUR', 'REPORT_EMAIL_TO']);
  if (!cfg.REPORT_ENABLED || !cfg.REPORT_EMAIL_TO) return;

  const frequency = cfg.REPORT_FREQUENCY === 'weekly' ? 'weekly' : 'daily';
  const targetHour = cfg.REPORT_HOUR ?? 8;

  const now = new Date();
  if (now.getUTCHours() !== targetHour) return;
  if (frequency === 'weekly' && now.getUTCDay() !== 1) return; // lunes

  const lastSentRow = await prisma.setting.findUnique({ where: { key: 'REPORT_LAST_SENT_AT' } });
  const lastSent = lastSentRow ? new Date(lastSentRow.value) : null;
  const minGapMs = (frequency === 'weekly' ? 6 : 1) * 24 * 60 * 60 * 1000; // evita reenviar dentro de la misma ventana
  if (lastSent && now.getTime() - lastSent.getTime() < minGapMs) return;

  try {
    const periodDays = frequency === 'weekly' ? 7 : 1;
    const { filename, buffer } = await generateAndStoreReport({ periodDays });
    await sendReportEmail({ to: cfg.REPORT_EMAIL_TO, filename, buffer });
    await prisma.setting.upsert({
      where: { key: 'REPORT_LAST_SENT_AT' },
      update: { value: now.toISOString() },
      create: { key: 'REPORT_LAST_SENT_AT', value: now.toISOString() },
    });
    console.log(`Reporte ejecutivo (${frequency}) enviado a ${cfg.REPORT_EMAIL_TO}: ${filename}`);
  } catch (err) {
    console.error('Error generando/enviando el reporte ejecutivo programado', err);
  }
}

const REPORT_CHECK_INTERVAL_MS = 15 * 60 * 1000;

function scheduleReports() {
  setInterval(() => {
    maybeSendScheduledReport().catch((err) => console.error('Error en el chequeo de reportes programados', err));
  }, REPORT_CHECK_INTERVAL_MS);
}

module.exports = {
  generateAndStoreReport,
  generateReportCsv,
  listReports,
  getReportPath,
  maybeSendScheduledReport,
  scheduleReports,
};
