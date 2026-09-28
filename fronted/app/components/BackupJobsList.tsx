'use client';

import { CalendarClock, FileArchive, FolderOpen, ListChecks } from 'lucide-react';
import { BACKUP_METHOD_LABELS, formatBytes, formatDuration, timeAgo } from '../lib/health';
import type { BackupJob } from '../types';

const RESULT_STYLE: Record<string, { label: string; badge: string }> = {
  SUCCESS: { label: 'OK', badge: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
  RUNNING: { label: 'En curso', badge: 'border-sky-200 bg-sky-50 text-sky-700' },
  WARNING: { label: 'Advertencia', badge: 'border-amber-200 bg-amber-50 text-amber-700' },
  FAILED: { label: 'Fallido', badge: 'border-red-200 bg-red-50 text-red-700' },
  UNKNOWN: { label: 'Sin datos', badge: 'border-slate-200 bg-slate-50 text-slate-500' },
};

/** Cada metodo de backup detectado en el equipo, con su ultimo resultado. */
export default function BackupJobsList({ jobs }: { jobs: BackupJob[] }) {
  return (
    <div>
      <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        <ListChecks className="h-3 w-3" />
        Métodos de backup detectados en el equipo ({jobs.length})
      </p>
      <div className="grid gap-2 lg:grid-cols-2">
        {jobs.map((j, i) => {
          const st = j.advisory ? { label: 'Informativo', badge: 'border-slate-200 bg-slate-50 text-slate-500' } : RESULT_STYLE[j.result] ?? RESULT_STYLE.UNKNOWN;
          return (
            <div key={`${j.name}-${i}`} className="rounded-lg border border-slate-200 bg-white p-3 text-[11px]">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold text-slate-800">{j.name}</p>
                  <p className="truncate text-slate-400">
                    {BACKUP_METHOD_LABELS[j.method] ?? j.method}
                    {j.tool && j.tool !== j.name ? ` · ${j.tool}` : ''}
                    {j.enabled === false ? ' · DESHABILITADA' : ''}
                  </p>
                </div>
                <span className={`shrink-0 rounded-full border px-2 py-0.5 font-medium ${st.badge}`}>{st.label}</span>
              </div>

              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-slate-600">
                <span className="flex items-center gap-1">
                  <CalendarClock className="h-3 w-3 text-slate-400" />
                  Última: {j.lastRunAt ? timeAgo(j.lastRunAt) : 'nunca'}
                </span>
                <span>Próxima: {j.nextRunAt ? new Date(j.nextRunAt).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }) : '—'}</span>
                {j.sizeBytes ? <span>Tamaño: {formatBytes(j.sizeBytes)}</span> : null}
                {j.durationSeconds ? <span>Duración: {formatDuration(j.durationSeconds)}</span> : null}
                {j.missedRuns ? <span className="text-amber-700">{j.missedRuns} ejecución(es) perdida(s)</span> : null}
                {j.runAs ? <span className="truncate">Usuario: {j.runAs}</span> : null}
              </div>

              {j.targetPath && (
                <p className="mt-1.5 flex items-start gap-1 text-slate-500">
                  <FolderOpen className="mt-0.5 h-3 w-3 shrink-0" />
                  <span className="break-all font-mono">{j.targetPath}</span>
                </p>
              )}
              {j.lastFile && (
                <p className="mt-1 flex items-start gap-1 text-slate-500">
                  <FileArchive className="mt-0.5 h-3 w-3 shrink-0" />
                  <span className="break-all">
                    Último archivo: <span className="font-mono">{j.lastFile.file.split(/[\\/]/).pop()}</span> ({formatBytes(j.lastFile.sizeBytes)},{' '}
                    {timeAgo(j.lastFile.modifiedAt)})
                  </span>
                </p>
              )}
              {j.stats && (
                <div className="mt-2 grid grid-cols-4 gap-1 rounded-md bg-slate-50 p-2 text-center">
                  <span>
                    <b className="block text-slate-800">{j.stats.filesCopied.toLocaleString('es')}</b>copiados
                  </span>
                  <span>
                    <b className="block text-slate-800">{j.stats.filesSkipped.toLocaleString('es')}</b>sin cambios
                  </span>
                  <span>
                    <b className={`block ${j.stats.filesFailed ? 'text-red-700' : 'text-slate-800'}`}>{j.stats.filesFailed}</b>con error
                  </span>
                  <span>
                    <b className="block text-slate-800">{j.stats.bytesCopied}</b>de {j.stats.bytesTotal}
                  </span>
                </div>
              )}
              {j.databases && j.databases.length > 0 && (
                <ul className="mt-2 max-h-28 space-y-0.5 overflow-y-auto rounded-md bg-slate-50 p-2">
                  {j.databases.map((d) => (
                    <li key={d.name} className="flex justify-between gap-2">
                      <span className="truncate font-medium text-slate-700">{d.name}</span>
                      <span className="shrink-0 text-slate-500">completo {d.lastFull ? timeAgo(d.lastFull) : 'nunca'}</span>
                    </li>
                  ))}
                </ul>
              )}
              {j.detail && <p className="mt-1.5 text-slate-500">{j.detail}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
