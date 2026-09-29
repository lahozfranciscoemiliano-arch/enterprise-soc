'use client';

import { useMemo, useState } from 'react';
import { ExternalLink, RotateCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { timeAgo } from '../../lib/health';
import { useLiveData } from '../inventory/useLiveData';
import type { PatchItem, ServerPatches } from '../../types';

const SEVERITY: Record<string, { label: string; badge: string; rank: number }> = {
  Critical: { label: 'Crítica', badge: 'bg-red-50 text-red-700 border-red-200', rank: 0 },
  Important: { label: 'Importante', badge: 'bg-orange-50 text-orange-700 border-orange-200', rank: 1 },
  Moderate: { label: 'Moderada', badge: 'bg-yellow-50 text-yellow-700 border-yellow-200', rank: 2 },
  Low: { label: 'Baja', badge: 'bg-slate-100 text-slate-600 border-slate-200', rank: 3 },
};
const NONE = { label: 'Sin clasificar', badge: 'bg-slate-50 text-slate-500 border-slate-200', rank: 4 };

function kbUrl(p: PatchItem) {
  if (p.kb[0]) return `https://support.microsoft.com/help/${p.kb[0].replace(/^KB/i, '')}`;
  return p.url;
}

export default function PatchesView() {
  const { data } = useLiveData<ServerPatches[]>('/api/patches', { event: 'soc:diagnostics', intervalMs: 300_000 });
  const [open, setOpen] = useState<string | null>(null);
  const [onlyCritical, setOnlyCritical] = useState(false);

  const rows = useMemo(
    () =>
      [...(data ?? [])].sort(
        (a, b) => (b.pendingCritical ?? -1) - (a.pendingCritical ?? -1) || (b.pending ?? -1) - (a.pending ?? -1) || a.name.localeCompare(b.name)
      ),
    [data]
  );
  const totals = useMemo(() => {
    const t = { critical: 0, important: 0, servers: 0 };
    for (const s of rows) {
      const c = s.list.filter((p) => p.severity === 'Critical').length;
      const i = s.list.filter((p) => p.severity === 'Important').length;
      t.critical += c;
      t.important += i;
      if (c + i > 0) t.servers += 1;
    }
    return t;
  }, [rows]);

  if (!data) return <p className="py-6 text-center text-sm text-slate-400">Cargando...</p>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <p className="text-slate-500">
          <b className="text-red-700">{totals.critical}</b> críticas y <b className="text-orange-700">{totals.important}</b> importantes sin instalar en{' '}
          <b>{totals.servers}</b> servidor(es). Windows Update se consulta cada 12 h (o con la acción “Buscar actualizaciones”).
        </p>
        <label className="flex items-center gap-1.5 text-slate-600">
          <input type="checkbox" checked={onlyCritical} onChange={(e) => setOnlyCritical(e.target.checked)} /> Solo críticas / importantes
        </label>
      </div>
      <ul className="space-y-1.5">
        {rows.map((s) => {
          const list = s.list
            .filter((p) => !onlyCritical || p.severity === 'Critical' || p.severity === 'Important')
            .sort((a, b) => (SEVERITY[a.severity ?? '']?.rank ?? 4) - (SEVERITY[b.severity ?? '']?.rank ?? 4));
          const isOpen = open === s.id;
          const ok = s.pending === 0;
          return (
            <li key={s.id} className="rounded-xl border border-slate-200 bg-white">
              <button onClick={() => setOpen(isOpen ? null : s.id)} className="flex w-full flex-wrap items-center gap-2 p-3 text-left text-xs">
                {ok ? <ShieldCheck className="h-4 w-4 text-emerald-500" /> : <ShieldAlert className={`h-4 w-4 ${s.pendingCritical ? 'text-red-600' : 'text-amber-500'}`} />}
                <span className="font-semibold text-slate-800">{s.name}</span>
                {s.pending === null ? (
                  <span className="text-slate-400">sin datos de Windows Update</span>
                ) : (
                  <span className="text-slate-500">
                    {s.pending} pendiente(s){s.pendingCritical ? <b className="text-red-700"> · {s.pendingCritical} crítica(s)/importante(s)</b> : ''}
                  </span>
                )}
                {s.rebootPending && (
                  <span className="flex items-center gap-1 rounded bg-amber-50 px-1.5 text-[10px] text-amber-700">
                    <RotateCw className="h-3 w-3" /> reinicio pendiente
                  </span>
                )}
                <span className="ml-auto text-[10px] text-slate-400">
                  último parche {s.lastInstalledAt ? timeAgo(s.lastInstalledAt) : '—'} · consultado {s.checkedAt ? timeAgo(s.checkedAt) : '—'}
                </span>
              </button>
              {isOpen && (
                <div className="border-t border-slate-100 p-3">
                  {list.length === 0 ? (
                    <p className="text-xs text-slate-400">{s.pending ? 'El agente todavía no envió el detalle (agente 1.14.0 o superior).' : 'Nada pendiente.'}</p>
                  ) : (
                    <table className="w-full text-left text-xs">
                      <tbody>
                        {list.map((p) => {
                          const sev = SEVERITY[p.severity ?? ''] ?? NONE;
                          const url = kbUrl(p);
                          return (
                            <tr key={`${p.title}-${p.kb.join()}`} className="border-b border-slate-50 align-top">
                              <td className="py-1.5 pr-2">
                                <span className={`whitespace-nowrap rounded border px-1.5 text-[10px] ${sev.badge}`}>{sev.label}</span>
                              </td>
                              <td className="py-1.5 pr-2 font-mono text-[11px] text-slate-600">{p.kb.join(', ') || '—'}</td>
                              <td className="py-1.5 pr-2 text-slate-700">
                                {p.title}
                                <span className="block text-[10px] text-slate-400">
                                  {[p.categories.join(', '), p.sizeMb ? `${p.sizeMb} MB` : null, p.reboot ? 'requiere reinicio' : null, p.releasedAt ? `publicada ${new Date(p.releasedAt).toLocaleDateString('es-AR')}` : null]
                                    .filter(Boolean)
                                    .join(' · ')}
                                </span>
                              </td>
                              <td className="py-1.5 text-right">
                                {url && (
                                  <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] text-brand-700 hover:underline">
                                    Boletín <ExternalLink className="h-3 w-3" />
                                  </a>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
