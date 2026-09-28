const prisma = require('../prismaClient');
const { getSettings } = require('./settings');
const { logAudit } = require('./auditLog');

// Valores de fabrica si no se configuro nada en Admin -> Configuracion ->
// Retencion de datos. Pensados para un disco chico (30GB en el VPS de
// referencia): telemetria es, por lejos, la tabla que mas crece (una fila
// cada ~60s por servidor), asi que tiene la retencion mas corta.
const DEFAULT_RETENTION_DAYS = {
  TELEMETRY_RETENTION_DAYS: 30,
  SECURITY_EVENT_RETENTION_DAYS: 365,
  BACKUP_STATUS_RETENTION_DAYS: 180,
  FORTI_EVENT_RETENTION_DAYS: 180,
  AUDIT_LOG_RETENTION_DAYS: 365,
};

// Sesiones/tuneles ya inservibles (vencidos, revocados o cerrados) no
// dependen de ninguna politica de retencion configurable: no tiene sentido
// conservarlos mas de unas semanas, son puro ruido operativo.
const SESSION_CLEANUP_DAYS = 30;
const REMOTE_SESSION_CLEANUP_DAYS = 30;

function cutoffDate(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

let lastRun = null; // { startedAt, finishedAt, deleted: {...}, error: string|null }

function getLastRun() {
  return lastRun;
}

// VACUUM despues de borrar en lote ayuda a que Postgres devuelva el espacio
// libre al sistema de archivos antes (autovacuum lo haria igual, pero no en
// un momento predecible) -- relevante con 30GB de disco total, no miles de
// GB de sobra para esperar. Nombres de tabla fijos (no interpolan input de
// usuario), por eso es seguro con $executeRawUnsafe.
async function vacuumTables(tables) {
  for (const table of tables) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await prisma.$executeRawUnsafe(`VACUUM (ANALYZE) "${table}"`);
    } catch (err) {
      console.error(`Error en VACUUM de "${table}"`, err);
    }
  }
}

async function runHousekeeping() {
  const startedAt = new Date();
  const deleted = {};

  try {
    const cfg = await getSettings(Object.keys(DEFAULT_RETENTION_DAYS));
    const retention = {};
    for (const [key, fallback] of Object.entries(DEFAULT_RETENTION_DAYS)) {
      retention[key] = cfg[key] ?? fallback;
    }

    const touchedTables = [];

    if (retention.TELEMETRY_RETENTION_DAYS > 0) {
      const r = await prisma.telemetry.deleteMany({
        where: { recordedAt: { lt: cutoffDate(retention.TELEMETRY_RETENTION_DAYS) } },
      });
      deleted.telemetry = r.count;
      if (r.count > 0) touchedTables.push('telemetry');
    }

    if (retention.BACKUP_STATUS_RETENTION_DAYS > 0) {
      const r = await prisma.backupStatus.deleteMany({
        where: { recordedAt: { lt: cutoffDate(retention.BACKUP_STATUS_RETENTION_DAYS) } },
      });
      deleted.backupStatus = r.count;
      if (r.count > 0) touchedTables.push('backup_status');
    }

    // Solo se purgan alertas ya RESUELTAS: una OPEN/ACKNOWLEDGED vieja sigue
    // siendo un problema pendiente, no basura -- por mas dias que hayan
    // pasado, purgarla la sacaria de la vista sin que nadie la haya resuelto.
    if (retention.SECURITY_EVENT_RETENTION_DAYS > 0) {
      const r = await prisma.securityEvent.deleteMany({
        // Por fecha de cierre, no de apertura: una alerta deduplicada puede
        // haber estado activa meses (createdAt viejo) y cerrarse ayer.
        where: {
          status: 'RESOLVED',
          OR: [
            { resolvedAt: { lt: cutoffDate(retention.SECURITY_EVENT_RETENTION_DAYS) } },
            { resolvedAt: null, createdAt: { lt: cutoffDate(retention.SECURITY_EVENT_RETENTION_DAYS) } },
          ],
        },
      });
      deleted.securityEvents = r.count;
      if (r.count > 0) touchedTables.push('security_events');
    }

    if (retention.FORTI_EVENT_RETENTION_DAYS > 0) {
      const r = await prisma.fortiEvent.deleteMany({
        where: { createdAt: { lt: cutoffDate(retention.FORTI_EVENT_RETENTION_DAYS) } },
      });
      deleted.fortiEvents = r.count;
      if (r.count > 0) touchedTables.push('forti_events');
    }

    // Inventario y monitores: retencion fija, no configurable (historial de
    // sesiones/auditoria del AD 180 dias, resultados de monitores 30 dias).
    {
      const logons = await prisma.logonEvent.deleteMany({ where: { at: { lt: cutoffDate(180) } } });
      const dirEvents = await prisma.directoryEvent.deleteMany({ where: { at: { lt: cutoffDate(180) } } });
      const checks = await prisma.serviceCheckResult.deleteMany({ where: { at: { lt: cutoffDate(30) } } });
      deleted.logonEvents = logons.count;
      deleted.directoryEvents = dirEvents.count;
      deleted.serviceCheckResults = checks.count;
      if (logons.count > 0) touchedTables.push('logon_events');
      if (dirEvents.count > 0) touchedTables.push('directory_events');
      if (checks.count > 0) touchedTables.push('service_check_results');
    }

    if (retention.AUDIT_LOG_RETENTION_DAYS > 0) {
      const r = await prisma.auditLog.deleteMany({
        where: { createdAt: { lt: cutoffDate(retention.AUDIT_LOG_RETENTION_DAYS) } },
      });
      deleted.auditLogs = r.count;
      if (r.count > 0) touchedTables.push('audit_logs');
    }

    const sessionCutoff = cutoffDate(SESSION_CLEANUP_DAYS);
    const sessionsResult = await prisma.session.deleteMany({
      where: { OR: [{ expiresAt: { lt: sessionCutoff } }, { revokedAt: { lt: sessionCutoff } }] },
    });
    deleted.sessions = sessionsResult.count;
    if (sessionsResult.count > 0) touchedTables.push('sessions');

    const remoteCutoff = cutoffDate(REMOTE_SESSION_CLEANUP_DAYS);
    const remoteSessionsResult = await prisma.remoteSession.deleteMany({
      where: { status: { in: ['CLOSED', 'EXPIRED', 'FAILED'] }, createdAt: { lt: remoteCutoff } },
    });
    deleted.remoteSessions = remoteSessionsResult.count;
    if (remoteSessionsResult.count > 0) touchedTables.push('remote_sessions');

    // Monitoreo de aplicaciones: muestras por minuto (30 dias) y micro-cortes
    // (180 dias, para comparar meses).
    const appSamples = await prisma.appSample.deleteMany({ where: { at: { lt: cutoffDate(30) } } });
    const probeStats = await prisma.probeStat.deleteMany({ where: { at: { lt: cutoffDate(30) } } });
    const microOutages = await prisma.microOutage.deleteMany({ where: { startedAt: { lt: cutoffDate(180) } } });
    // Instancias que dejaron de reportar hace mas de 7 dias (servidor dado de baja).
    await prisma.appInstance.deleteMany({ where: { lastSeenAt: { lt: cutoffDate(7) } } });
    deleted.appSamples = appSamples.count;
    deleted.probeStats = probeStats.count;
    deleted.microOutages = microOutages.count;
    if (appSamples.count) touchedTables.push('app_samples');
    if (probeStats.count) touchedTables.push('probe_stats');

    if (touchedTables.length > 0) await vacuumTables(touchedTables);

    const finishedAt = new Date();
    lastRun = { startedAt, finishedAt, deleted, retention, error: null };

    const totalDeleted = Object.values(deleted).reduce((a, b) => a + b, 0);
    console.log(`Housekeeping completado: ${totalDeleted} filas borradas`, deleted);

    logAudit({
      userId: null,
      action: 'HOUSEKEEPING_RUN',
      targetType: 'System',
      metadata: { deleted, retention, durationMs: finishedAt - startedAt },
    });

    return lastRun;
  } catch (err) {
    console.error('Error corriendo housekeeping', err);
    lastRun = { startedAt, finishedAt: new Date(), deleted, error: err.message };
    return lastRun;
  }
}

const HOUSEKEEPING_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Primera corrida a los 2 minutos de arrancar (no bloquea el arranque del
// servidor ni compite con la carga inicial de otros servicios), despues una
// vez por dia. Un housekeeping fallido nunca debe tirar el proceso: los
// errores quedan en lastRun/consola para revisarlos desde el panel.
function scheduleHousekeeping() {
  setTimeout(() => {
    runHousekeeping().catch((err) => console.error('Error en housekeeping programado', err));
    setInterval(() => {
      runHousekeeping().catch((err) => console.error('Error en housekeeping programado', err));
    }, HOUSEKEEPING_INTERVAL_MS);
  }, 2 * 60 * 1000);
}

module.exports = { runHousekeeping, getLastRun, scheduleHousekeeping, DEFAULT_RETENTION_DAYS };
