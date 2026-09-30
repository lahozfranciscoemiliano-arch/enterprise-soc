// Que se lee como "backup" en cada servidor.
//
// - MULTI: servidores de punto de venta ALOHA* (ALOHADK02, ALLOHA...). No
//   tienen Windows Server Backup: se respaldan con scripts en tareas
//   programadas, SQL, Historial de archivos o software de terceros, asi que
//   se leen TODOS los metodos que detecta el agente.
// - NATIVE: el resto de los servidores. Solo cuenta Windows Server Backup /
//   Copias de seguridad de Windows (wbadmin). Los demas metodos que el agente
//   pueda encontrar (una tarea vieja con "backup" en el nombre, un .bak
//   suelto) se descartan: eran la fuente de los avisos falsos.
// - EXCLUDED: equipos sin backup que vigilar (la VPS del propio NOC). No se
//   guarda ni se alerta nada; solo se monitorea estado, recursos y seguridad.
const { getSettings } = require('./settings');

const DEFAULT_MULTI_PREFIXES = ['ALOHA', 'ALLOHA'];
const DEFAULT_EXCLUDED = ['grupo-bistro-noc-soc-2026-vps'];
const EXCLUDED_TAGS = ['infra-vps'];
const NATIVE_METHODS = ['WINDOWS_SERVER_BACKUP', 'WBADMIN'];

function splitList(value, fallback) {
  const items = String(value ?? '')
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
}

async function loadBackupPolicy() {
  const cfg = await getSettings(['BACKUP_MULTI_METHOD_PREFIXES', 'BACKUP_EXCLUDED_SERVERS']);
  return {
    multiPrefixes: splitList(cfg.BACKUP_MULTI_METHOD_PREFIXES, DEFAULT_MULTI_PREFIXES).map((p) => p.toUpperCase()),
    excluded: new Set(splitList(cfg.BACKUP_EXCLUDED_SERVERS, DEFAULT_EXCLUDED).map((n) => n.toLowerCase())),
  };
}

function backupMode(server, policy) {
  const names = [server.name, server.hostname].filter(Boolean).map((n) => String(n).toLowerCase());
  if (names.some((n) => policy.excluded.has(n))) return 'EXCLUDED';
  if ((server.tags ?? []).some((t) => EXCLUDED_TAGS.includes(String(t).toLowerCase()))) return 'EXCLUDED';
  const upper = names.map((n) => n.toUpperCase());
  if (upper.some((n) => policy.multiPrefixes.some((p) => n.startsWith(p)))) return 'MULTI';
  return 'NATIVE';
}

// Reduce un reporte del agente (que puede combinar varios metodos) a lo que
// corresponde segun el modo del servidor. Devuelve un objeto nuevo.
function normalizeBackupReport(mode, data) {
  const jobs = Array.isArray(data.metadata?.jobs) ? data.metadata.jobs : null;
  if (mode !== 'NATIVE' || !jobs) return data;

  const native = jobs.find((j) => NATIVE_METHODS.includes(j.method));
  const metadata = { ...data.metadata };
  delete metadata.jobs;

  if (!native) {
    return {
      ...data,
      result: NATIVE_METHODS.includes(data.method) && data.result === 'UNKNOWN' ? 'UNKNOWN' : 'NOT_CONFIGURED',
      method: NATIVE_METHODS.includes(data.method) ? data.method : 'WBADMIN',
      lastBackupAt: undefined,
      targetPath: undefined,
      sizeBytes: undefined,
      detail: 'Sin Windows Server Backup / Copias de seguridad de Windows configurado en este servidor.',
      metadata,
    };
  }

  return {
    ...data,
    result: native.result,
    method: native.method,
    lastBackupAt: native.lastSuccessAt ?? native.lastRunAt ?? data.lastBackupAt,
    targetPath: native.targetPath ?? undefined,
    sizeBytes: native.sizeBytes ?? undefined,
    detail: native.detail || data.detail,
    metadata: { ...metadata, jobs: [native] },
  };
}

// Corridas del Visor de eventos con fecha en el futuro (registros corruptos o
// de cuando el reloj estuvo mal). El agente <= 1.16.0 las tomaba como la
// "ultima corrida": KSFS2 figuraba FALLIDO por eventos "del 2098-01-01"
// aunque el backup de anoche habia salido bien. Se descartan y, si el
// FALLIDO salia de una de ellas y la corrida real mas nueva fue exitosa, se
// informa el resultado real (misma regla que aplica el agente con el WMI).
const FUTURE_TOLERANCE_MS = 60 * 60 * 1000;
const FUTURE_RUN_DETAIL_RE = /^La ultima corrida de backup \(([^)]+)\) fallo \(evento \d+ de Microsoft-Windows-Backup\)\.\s*/;

function isFutureIso(iso, now = Date.now()) {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return !Number.isNaN(t) && t > now + FUTURE_TOLERANCE_MS;
}

function sanitizeBackupReport(data, now = Date.now()) {
  const runs = data.metadata?.runs;
  if (!Array.isArray(runs)) return data;
  const kept = runs.filter((r) => !isFutureIso(r?.finishedAt, now) && !isFutureIso(r?.startedAt, now));
  if (kept.length === runs.length) return data;

  const out = { ...data, metadata: { ...data.metadata, runs: kept } };
  const futureFailure = runs.some((r) => r?.result !== 'SUCCESS' && isFutureIso(r?.finishedAt, now));
  const latest = kept[0];
  if (data.result === 'FAILED' && futureFailure && latest?.result === 'SUCCESS') {
    out.result = 'SUCCESS';
    const rest = String(data.detail ?? '').replace(FUTURE_RUN_DETAIL_RE, '');
    out.detail = `Ultima corrida exitosa segun el Visor de eventos (${latest.finishedAt}); se descartaron eventos con fecha futura. ${rest}`.slice(0, 1000);
  }
  return out;
}

module.exports = { loadBackupPolicy, backupMode, normalizeBackupReport, sanitizeBackupReport, isFutureIso, NATIVE_METHODS };
