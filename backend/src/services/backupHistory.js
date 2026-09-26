// Historial de backups "real": una entrada por CORRIDA de backup, no por
// chequeo. El agente revisa cada 30 min, asi que antes el historial mostraba
// la misma corrida repetida decenas de veces.
//
// Fuentes, de la mas rica a la mas pobre (se combinan y deduplican por
// fecha de fin de la corrida):
//   1. metadata.runs del ultimo reporte (agente >= 1.3.0): corridas leidas
//      del Visor de Eventos de Windows, con inicio, fin, duracion y tambien
//      las que fallaron.
//   2. metadata.versions (agente >= 1.3.0 con wbadmin): fechas de todos los
//      backups exitosos que Windows todavia conserva.
//   3. Las filas guardadas en backup_status (una por corrida desde este
//      cambio; agentes viejos incluidos) -- aportan tamaño y destino.

const MINUTE = 60 * 1000;

function minuteKey(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : Math.round(t / MINUTE);
}

function buildBackupHistory(rows, { onlySuccess = false, limit = 30 } = {}) {
  const entries = new Map(); // minuteKey -> entry
  const latest = rows[0];
  const meta = latest?.metadata ?? {};

  const add = (key, entry) => {
    if (key === null) return;
    // La misma corrida puede llegar de dos fuentes con 1-2 min de diferencia
    // (evento de fin vs. identificador de version de wbadmin).
    const existingKey = [key, key - 1, key + 1, key - 2, key + 2].find((k) => entries.has(k));
    if (existingKey === undefined) {
      entries.set(key, entry);
      return;
    }
    const existing = entries.get(existingKey);
    for (const [k, v] of Object.entries(entry)) {
      if (existing[k] === null || existing[k] === undefined) existing[k] = v;
    }
  };

  for (const run of Array.isArray(meta.runs) ? meta.runs : []) {
    add(minuteKey(run.finishedAt), {
      result: run.result === 'SUCCESS' ? 'SUCCESS' : 'FAILED',
      startedAt: run.startedAt ?? null,
      finishedAt: run.finishedAt,
      durationSeconds: run.durationSeconds ?? null,
      source: 'eventlog',
    });
  }

  for (const v of Array.isArray(meta.versions) ? meta.versions : []) {
    add(minuteKey(v), { result: 'SUCCESS', startedAt: null, finishedAt: v, durationSeconds: null, source: 'wbadmin' });
  }

  for (const row of rows) {
    const key = minuteKey(row.lastBackupAt);
    const base = {
      result: row.result,
      startedAt: null,
      finishedAt: row.lastBackupAt ? row.lastBackupAt.toISOString?.() ?? row.lastBackupAt : null,
      durationSeconds: row.metadata?.durationSeconds ?? null,
      sizeBytes: row.sizeBytes ?? null,
      targetPath: row.targetPath ?? null,
      method: row.method,
      detail: row.detail ?? null,
      checkedAt: row.recordedAt,
      source: 'check',
    };
    if (key !== null) {
      add(key, base);
    } else if (row.result === 'FAILED' || row.result === 'WARNING') {
      // Sin fecha de backup: solo interesa como registro de una falla.
      entries.set(`row:${row.id}`, { ...base, finishedAt: null });
    }
  }

  // Defaults comunes (metodo/destino del ultimo reporte si la fuente no los trae).
  let list = [...entries.values()].map((e, i) => ({
    id: `${e.finishedAt ?? e.checkedAt ?? i}`,
    result: e.result,
    method: e.method ?? latest?.method ?? null,
    startedAt: e.startedAt ?? null,
    finishedAt: e.finishedAt ?? null,
    durationSeconds: e.durationSeconds ?? null,
    sizeBytes: e.sizeBytes ?? null,
    targetPath: e.targetPath ?? latest?.targetPath ?? null,
    detail: e.detail ?? null,
    source: e.source,
  }));

  if (onlySuccess) list = list.filter((e) => e.result === 'SUCCESS');

  const when = (e) => new Date(e.finishedAt ?? e.startedAt ?? 0).getTime();
  list.sort((a, b) => when(b) - when(a));
  return list.slice(0, limit);
}

module.exports = { buildBackupHistory };
