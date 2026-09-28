'use client';

import { AlertTriangle, CalendarClock, HardDrive, Server, ShieldCheck } from 'lucide-react';
import { formatBytes, formatDuration, timeAgo } from '../lib/health';
import type { WsbDetails } from '../types';

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' });
}

function Field({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`truncate text-xs text-slate-700 ${mono ? 'font-mono' : ''}`}>{value ?? '—'}</p>
    </div>
  );
}

function YesNo({ value }: { value: boolean | undefined }) {
  if (value === undefined) return <>—</>;
  return <span className={value ? 'text-emerald-600' : 'text-slate-400'}>{value ? 'Habilitado' : 'Deshabilitado'}</span>;
}

/** Detalle de Windows Server Backup: lo mismo que reportaba Backup-Collect-Local.ps1. */
export default function WsbDetailsPanel({ wsb }: { wsb: WsbDetails }) {
  const job = wsb.lastJob;
  const policy = wsb.policy;
  const failure = wsb.lastFailure;
  const failureIsRecent = failure?.at && (!wsb.finishedAt || failure.at > wsb.finishedAt);

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-slate-200 bg-white p-3">
        <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          <Server className="h-3 w-3" />
          Último backup de Windows Server Backup
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Field label="Finalizó" value={`${fmtDate(wsb.finishedAt ?? wsb.lastSuccessAt)} (${timeAgo(wsb.finishedAt ?? wsb.lastSuccessAt ?? null)})`} />
          <Field label="Tipo" value={wsb.backupType} />
          <Field label="Transferido" value={formatBytes(wsb.transferredBytes ?? null)} mono />
          <Field label="Duración" value={formatDuration(job?.durationSeconds)} mono />
          <Field label="Copias restaurables" value={wsb.versions ?? '—'} />
          <Field label="Próximo backup" value={fmtDate(wsb.nextBackupAt)} />
        </div>
        {wsb.target && (
          <p className="mt-2 break-all text-[11px] text-slate-500">
            Destino: <span className="font-mono">{wsb.target}</span>
          </p>
        )}
      </div>

      {wsb.volumes && wsb.volumes.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <p className="flex items-center gap-1.5 border-b border-slate-200 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            <HardDrive className="h-3 w-3" />
            Volúmenes respaldados ({wsb.volumes.length})
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b border-slate-100 text-left text-slate-400">
                  <th className="px-3 py-1.5 font-medium">Volumen</th>
                  <th className="px-3 py-1.5 font-medium">Estado</th>
                  <th className="px-3 py-1.5 font-medium">Transferido</th>
                  <th className="px-3 py-1.5 font-medium">Tamaño en disco</th>
                </tr>
              </thead>
              <tbody>
                {wsb.volumes.map((v, i) => {
                  const failed = v.hresult && v.hresult !== '0';
                  return (
                    <tr key={`${v.name}-${i}`} className="border-b border-slate-100 last:border-0">
                      <td className="px-3 py-1.5 font-mono text-slate-700">{v.name}</td>
                      <td className="px-3 py-1.5">
                        <span className={failed ? 'text-red-600' : 'text-emerald-600'}>{failed ? `Error ${v.hresult}` : 'Completado'}</span>
                      </td>
                      <td className="px-3 py-1.5 font-mono text-slate-600">{formatBytes(v.transferredBytes)}</td>
                      <td className="px-3 py-1.5 font-mono text-slate-600">{formatBytes(v.sizeOnDiskBytes || null)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {policy && (
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            <CalendarClock className="h-3 w-3" />
            Configuración activa (política)
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="Programación" value={policy.schedule?.length ? policy.schedule.join(', ') : 'Sin programar'} />
            <Field label="Opción VSS" value={policy.vssOption} />
            <Field label="Recuperación completa (BMR)" value={<YesNo value={policy.bmr} />} />
            <Field label="Estado del sistema" value={<YesNo value={policy.systemState} />} />
          </div>
          {policy.volumes && policy.volumes.length > 0 && (
            <p className="mt-2 text-[11px] text-slate-500">
              Volúmenes incluidos: <span className="font-mono">{policy.volumes.join(', ')}</span>
            </p>
          )}
          {policy.targets && policy.targets.length > 0 && (
            <p className="mt-1 break-all text-[11px] text-slate-500">
              Destinos configurados: <span className="font-mono">{policy.targets.join(' · ')}</span>
            </p>
          )}
        </div>
      )}

      {job && (
        <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
          <ShieldCheck className="h-3.5 w-3.5 text-slate-400" />
          Último trabajo: <strong className="font-medium text-slate-700">{job.state || '—'}</strong>
          {job.startedAt && <span>· inició {fmtDate(job.startedAt)}</span>}
          {job.endedAt && <span>· terminó {fmtDate(job.endedAt)}</span>}
          {job.error && <span className="text-red-600">· {job.error}</span>}
        </p>
      )}

      {failure && failureIsRecent && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-[11px] text-red-700">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <div>
            <p className="font-semibold">
              Última falla: {fmtDate(failure.at)} (evento {failure.eventId ?? '?'}
              {failure.hresult ? `, código ${failure.hresult}` : ''})
            </p>
            {failure.message && <p className="mt-0.5">{failure.message}</p>}
            {job?.failureLog && <p className="mt-0.5 break-all font-mono text-red-600/80">Log: {job.failureLog}</p>}
          </div>
        </div>
      )}
      {wsb.message && <p className="text-[11px] text-slate-500">{wsb.message}</p>}
    </div>
  );
}
