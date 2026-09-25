const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const prisma = require('../prismaClient');
const { getSettings } = require('./settings');
const { getHealthStatus, getEffectiveDefaultThresholds } = require('./alertEngine');
const { sendReportEmail } = require('./notifications');

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
  const periodStart = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);

  const [servers, defaultThresholds, eventsInPeriod, resolvedInPeriod, fortiEventsInPeriod, fortiCriticalInPeriod] =
    await Promise.all([
      prisma.server.findMany({
        orderBy: { name: 'asc' },
        include: {
          telemetry: { orderBy: { recordedAt: 'desc' }, take: 1 },
          backups: { orderBy: { recordedAt: 'desc' }, take: 1 },
        },
      }),
      getEffectiveDefaultThresholds(),
      prisma.securityEvent.findMany({
        where: { createdAt: { gte: periodStart } },
        include: { server: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.securityEvent.findMany({
        where: { status: 'RESOLVED', resolvedAt: { gte: periodStart, not: null } },
        select: { createdAt: true, resolvedAt: true },
      }),
      prisma.fortiEvent.count({ where: { createdAt: { gte: periodStart } } }),
      prisma.fortiEvent.count({ where: { createdAt: { gte: periodStart }, severity: 'CRITICAL' } }),
    ]);

  const healthBreakdown = { OK: 0, WARNING: 0, CRITICAL: 0, UNKNOWN: 0 };
  const backupBreakdown = { SUCCESS: 0, WARNING: 0, FAILED: 0, NOT_CONFIGURED: 0, UNKNOWN: 0 };
  const serverRows = [];

  for (const s of servers) {
    const health = getHealthStatus(s.telemetry[0], s, defaultThresholds);
    healthBreakdown[health] += 1;
    const backupResult = s.backups[0]?.result ?? 'UNKNOWN';
    backupBreakdown[backupResult] += 1;
    serverRows.push({
      name: s.name,
      tags: s.tags,
      health,
      cpuUsage: s.telemetry[0]?.cpuUsage ?? null,
      memoryUsage: s.telemetry[0]?.memoryUsage ?? null,
      diskUsage: s.telemetry[0]?.diskUsage ?? null,
      lastSeenAt: s.lastSeenAt,
      backupResult,
      backupLastAt: s.backups[0]?.lastBackupAt ?? null,
    });
  }

  const reportedServers = servers.length - healthBreakdown.UNKNOWN;
  const slaPercentage = reportedServers > 0 ? Math.round((healthBreakdown.OK / reportedServers) * 10000) / 100 : 0;

  const severityCounts = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
  const offenders = new Map(); // serverName -> count
  for (const e of eventsInPeriod) {
    severityCounts[e.severity] = (severityCounts[e.severity] ?? 0) + 1;
    const name = e.server?.name ?? '?';
    offenders.set(name, (offenders.get(name) ?? 0) + 1);
  }
  const topOffenders = [...offenders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

  let avgResolutionMinutes = null;
  if (resolvedInPeriod.length > 0) {
    const totalMs = resolvedInPeriod.reduce((sum, e) => sum + (e.resolvedAt.getTime() - e.createdAt.getTime()), 0);
    avgResolutionMinutes = Math.round(totalMs / resolvedInPeriod.length / 60000);
  }

  const stillOpenCritical = eventsInPeriod.filter((e) => e.status !== 'RESOLVED' && e.severity === 'CRITICAL');

  return {
    generatedAt: new Date(),
    periodDays,
    periodStart,
    totalServers: servers.length,
    slaPercentage,
    healthBreakdown,
    backupBreakdown,
    serverRows,
    eventsOpenedInPeriod: eventsInPeriod.length,
    eventsResolvedInPeriod: resolvedInPeriod.length,
    severityCounts,
    avgResolutionMinutes,
    topOffenders,
    stillOpenCritical,
    fortiEventsInPeriod,
    fortiCriticalInPeriod,
  };
}

const HEALTH_LABEL = { OK: 'OK', WARNING: 'Advertencia', CRITICAL: 'Crítico', UNKNOWN: 'Sin datos' };
const BACKUP_LABEL = {
  SUCCESS: 'Exitoso',
  WARNING: 'Advertencia',
  FAILED: 'Fallido',
  NOT_CONFIGURED: 'No configurado',
  UNKNOWN: 'Sin datos',
};

function drawReportPdf(doc, data) {
  const periodLabel = `${data.periodStart.toLocaleDateString('es-AR')} — ${data.generatedAt.toLocaleDateString('es-AR')}`;

  doc.fontSize(18).fillColor('#111827').text('Reporte Ejecutivo — Enterprise SOC', { align: 'left' });
  doc.fontSize(10).fillColor('#6b7280').text(`Período: últimos ${data.periodDays} días (${periodLabel})`);
  doc.text(`Generado: ${data.generatedAt.toLocaleString('es-AR')}`);
  doc.moveDown(1);

  doc.fontSize(13).fillColor('#111827').text('Resumen');
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor('#374151');
  doc.text(`SLA de confiabilidad actual: ${data.slaPercentage}%`);
  doc.text(`Servidores monitoreados: ${data.totalServers}`);
  doc.text(
    `Salud actual: ${data.healthBreakdown.OK} OK · ${data.healthBreakdown.WARNING} advertencia · ${data.healthBreakdown.CRITICAL} crítico · ${data.healthBreakdown.UNKNOWN} sin datos`
  );
  doc.text(
    `Backups: ${data.backupBreakdown.SUCCESS} exitosos · ${data.backupBreakdown.WARNING} con advertencias · ${data.backupBreakdown.FAILED} fallidos · ${data.backupBreakdown.NOT_CONFIGURED} sin configurar · ${data.backupBreakdown.UNKNOWN} sin datos`
  );
  doc.moveDown(1);

  doc.fontSize(13).fillColor('#111827').text('Incidentes en el período');
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor('#374151');
  doc.text(`Alertas abiertas: ${data.eventsOpenedInPeriod} (LOW ${data.severityCounts.LOW} · MEDIUM ${data.severityCounts.MEDIUM} · HIGH ${data.severityCounts.HIGH} · CRITICAL ${data.severityCounts.CRITICAL})`);
  doc.text(`Alertas resueltas: ${data.eventsResolvedInPeriod}`);
  doc.text(
    `Tiempo promedio de resolución: ${data.avgResolutionMinutes !== null ? `${data.avgResolutionMinutes} minutos` : 'sin datos suficientes'}`
  );
  doc.text(`Eventos Fortinet: ${data.fortiEventsInPeriod} (${data.fortiCriticalInPeriod} críticos)`);
  doc.moveDown(0.6);

  if (data.stillOpenCritical.length > 0) {
    doc.fontSize(11).fillColor('#b91c1c').text('⚠ Alertas críticas sin resolver:');
    doc.fontSize(9).fillColor('#374151');
    for (const e of data.stillOpenCritical.slice(0, 15)) {
      doc.text(`• [${e.createdAt.toLocaleString('es-AR')}] ${e.server?.name ?? '?'}: ${e.description}`);
    }
    doc.moveDown(0.6);
  }

  if (data.topOffenders.length > 0) {
    doc.fontSize(13).fillColor('#111827').text('Servidores con más alertas en el período');
    doc.fontSize(9).fillColor('#374151');
    for (const [name, count] of data.topOffenders) {
      doc.text(`• ${name}: ${count} alerta(s)`);
    }
    doc.moveDown(0.6);
  }

  doc.fontSize(13).fillColor('#111827').text('Detalle por servidor');
  doc.moveDown(0.3);
  doc.fontSize(8).fillColor('#374151');
  for (const s of data.serverRows) {
    const cpu = s.cpuUsage !== null ? `${s.cpuUsage.toFixed(0)}%` : '—';
    const mem = s.memoryUsage !== null ? `${s.memoryUsage.toFixed(0)}%` : '—';
    const disk = s.diskUsage !== null ? `${s.diskUsage.toFixed(0)}%` : '—';
    const tags = s.tags.length > 0 ? ` [${s.tags.join(', ')}]` : '';
    doc.text(
      `${s.name}${tags} — Salud: ${HEALTH_LABEL[s.health]} | CPU ${cpu} RAM ${mem} Disco ${disk} | Backup: ${BACKUP_LABEL[s.backupResult]}`
    );
  }

  doc.moveDown(1.2);
  doc.fontSize(8).fillColor('#9ca3af').text('Reporte generado automáticamente por Enterprise SOC.', { align: 'center' });
}

function buildPdfBuffer(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
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
  listReports,
  getReportPath,
  maybeSendScheduledReport,
  scheduleReports,
};
