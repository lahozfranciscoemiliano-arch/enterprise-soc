'use client';

import { Fragment, useCallback, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, Clock, DatabaseBackup, FolderOpen, HardDrive, Percent, ShieldOff, Timer, XCircle } from 'lucide-react';
import StatCard from '../StatCard';
import BackupJobsList from '../BackupJobsList';
import WsbDetailsPanel from '../WsbDetailsPanel';
import { BACKUP_METHOD_LABELS, BACKUP_STYLES, backupAgeLevel, formatBytes, formatDuration } from '../../lib/health';
import type { BackupHistoryEntry, BackupResult, ServerSummary } from '../../types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

const RESULT_ORDER: Record<BackupResult, number> = { FAILED: 0, WARNING: 1, UNKNOWN: 2, NOT_CONFIGURED: 3, SUCCESS: 4 };

const RESULT_FILTERS: { id: BackupResult | 'ALL'; label: string }[] = [
  { id: 'ALL', label: 'Todos' },
  { id: 'SUCCESS', label: 'Éxito' },
  { id: 'WARNING', label: 'Advertencia' },
  { id: 'FAILED', label: 'Fallido' },
  { id: 'NOT_CONFIGURED', label: 'No configurado' },
  { id: 'UNKNOWN', label: 'Sin datos' },
];

const AGE_DOT: Record<string, string> = { ok: 'bg-emerald-500', warning: 'bg-amber-500', critical: 'bg-red-500', none: 'bg-slate-300' };
const AGE_LABEL: Record<string, string> = { ok: 'Al día', warning: 'Atrasado', critical: 'Muy atrasado', none: 'Nunca corrió' };

function relativeTime(iso: string | null): string {
  if (!iso) return 'Nunca';
  const hours = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  if (hours < 1) return 'Hace instantes';
  if (hours < 24) return `Hace ${Math.round(hours)} hs`;
  return `Hace ${Math.round(hours / 24)} día(s)`;
}

function effectiveResult(s: ServerSummary): BackupResult {
  return s.backup?.result ?? 'NOT_CONFIGURED';
}

export default function BackupsTab({ servers: allServers }: { servers: ServerSummary[] }) {
  // La VPS del NOC (y cualquier equipo excluido en Admin) no tiene backups que vigilar.
  const servers = useMemo(() => allServers.filter((s) => s.backupMode !== 'EXCLUDED'), [allServers]);
  const [filter, setFilter] = useState('');
  const [resultFilter, setResultFilter] = useState<BackupResult | 'ALL'>('ALL');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [history, setHistory] = useState<Record<string, BackupHistoryEntry[] | 'loading' | 'error'>>({});
  // Por defecto el historial muestra solo los backups que salieron bien
  // (lo que interesa para saber "desde que fecha puedo restaurar").
  const [onlySuccess, setOnlySuccess] = useState(true);

  const resultCounts = useMemo(() => {
    const counts: Record<BackupResult, number> = { SUCCESS: 0, WARNING: 0, FAILED: 0, NOT_CONFIGURED: 0, UNKNOWN: 0 };
    for (const s of servers) counts[effectiveResult(s)]++;
    return counts;
  }, [servers]);

  const fleetStats = useMemo(() => {
    const totalBytes = servers.reduce((sum, s) => sum + (s.backup?.sizeBytes ?? 0), 0);
    const withSize = servers.filter((s) => s.backup?.sizeBytes).length;
    const configured = servers.length - resultCounts.NOT_CONFIGURED;
    const successRate = configured > 0 ? (resultCounts.SUCCESS / configured) * 100 : null;
    return { totalBytes, withSize, successRate };
  }, [servers, resultCounts]);

  const rows = useMemo(
    () =>
      [...servers]
        .sort((a, b) => RESULT_ORDER[effectiveResult(a)] - RESULT_ORDER[effectiveResult(b)] || a.name.localeCompare(b.name))
        .filter((s) => s.name.toLowerCase().includes(filter.toLowerCase()))
        .filter((s) => resultFilter === 'ALL' || effectiveResult(s) === resultFilter),
    [servers, filter, resultFilter]
  );

  const loadHistory = useCallback(async (serverId: string, successOnly: boolean) => {
    const key = `${serverId}:${successOnly}`;
    setHistory((prev) => ({ ...prev, [key]: 'loading' }));
    try {
      const res = await fetch(`${API_URL}/api/servers/${serverId}/backup-status?limit=30&onlySuccess=${successOnly}`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error('request failed');
      const data: BackupHistoryEntry[] = await res.json();
      setHistory((prev) => ({ ...prev, [key]: data }));
    } catch {
      setHistory((prev) => ({ ...prev, [key]: 'error' }));
    }
  }, []);

  const toggleExpand = useCallback(
    (serverId: string) => {
      setExpandedId((prev) => (prev === serverId ? null : serverId));
      if (!history[`${serverId}:${onlySuccess}`]) loadHistory(serverId, onlySuccess);
    },
    [history, onlySuccess, loadHistory]
  );

  const changeOnlySuccess = (value: boolean) => {
    setOnlySuccess(value);
    if (expandedId && !history[`${expandedId}:${value}`]) loadHistory(expandedId, value);
  };

  return (
    <div className="space-y-4 px-3 py-4 sm:px-6 sm:py-6">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard
          label="Tamaño Total Respaldado"
          value={fleetStats.withSize > 0 ? formatBytes(fleetStats.totalBytes) : '—'}
          color="blue"
          icon={<HardDrive className="h-5 w-5" />}
        />
        <StatCard
          label="Tasa de Éxito"
          value={fleetStats.successRate !== null ? `${fleetStats.successRate.toFixed(0)}%` : '—'}
          color={fleetStats.successRate !== null && fleetStats.successRate < 90 ? 'amber' : 'emerald'}
          icon={<Percent className="h-5 w-5" />}
        />
        <StatCard label="Backups Fallidos" value={resultCounts.FAILED.toString()} color={resultCounts.FAILED > 0 ? 'red' : 'emerald'} icon={<XCircle className="h-5 w-5" />} />
        <StatCard
          label="Sin Configurar"
          value={resultCounts.NOT_CONFIGURED.toString()}
          color={resultCounts.NOT_CONFIGURED > 0 ? 'amber' : 'emerald'}
          icon={<ShieldOff className="h-5 w-5" />}
        />
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
            <DatabaseBackup className="h-4 w-4 text-slate-400" />
            Backups por servidor
            <span className="font-normal text-slate-400">(clic para ver el historial)</span>
          </h2>
          <input
            type="text"
            placeholder="Filtrar nodos..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs text-slate-800 outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10 transition-colors"
          />
        </div>

        <div className="mb-4 flex flex-wrap gap-1.5">
          {RESULT_FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setResultFilter(f.id)}
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                resultFilter === f.id ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'
              }`}
            >
              {f.label}
              {f.id !== 'ALL' && <span className={resultFilter === f.id ? 'text-white/80' : 'text-slate-400'}>{resultCounts[f.id]}</span>}
            </button>
          ))}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-xs sm:min-w-0">
            <thead>
              <tr className="border-b border-slate-200 text-slate-400">
                <th className="py-2 pr-4 font-medium">Servidor</th>
                <th className="py-2 pr-4 font-medium">Resultado</th>
                <th className="py-2 pr-4 font-medium">Método</th>
                <th className="py-2 pr-4 font-medium">Último backup</th>
                <th className="py-2 pr-4 font-medium">Antigüedad</th>
                <th className="py-2 pr-4 font-medium">Duración</th>
                <th className="py-2 pr-4 font-medium">Tamaño</th>
                <th className="py-2 pr-4 font-medium">VSS</th>
                <th className="w-8 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="py-6 text-center text-slate-400">
                    Sin nodos que coincidan
                  </td>
                </tr>
              )}
              {rows.map((s) => {
                const backup = s.backup;
                const result = effectiveResult(s);
                const style = BACKUP_STYLES[result];
                const age = backupAgeLevel(backup?.lastBackupAt ?? null);
                const isOpen = expandedId === s.id;
                const hist = history[`${s.id}:${onlySuccess}`];

                return (
                  <Fragment key={s.id}>
                    <tr
                      onClick={() => toggleExpand(s.id)}
                      className="cursor-pointer border-b border-slate-200 transition-colors hover:bg-slate-50"
                    >
                      <td className="py-2.5 pr-4 font-medium text-slate-800">{s.name}</td>
                      <td className="py-2.5 pr-4">
                        <span className={`rounded-full border px-2 py-0.5 text-[11px] ${style.badge}`}>{style.label}</span>
                      </td>
                      <td className="py-2.5 pr-4 text-slate-500">{backup ? BACKUP_METHOD_LABELS[backup.method] ?? backup.method : '—'}</td>
                      <td className="py-2.5 pr-4 text-slate-500">{relativeTime(backup?.lastBackupAt ?? null)}</td>
                      <td className="py-2.5 pr-4">
                        <span className="flex items-center gap-1.5 text-slate-500">
                          <span className={`h-2 w-2 rounded-full ${AGE_DOT[age]}`} />
                          {AGE_LABEL[age]}
                        </span>
                      </td>
                      <td className="py-2.5 pr-4 font-mono text-slate-500">{formatDuration(backup?.durationSeconds)}</td>
                      <td className="py-2.5 pr-4 font-mono text-slate-500">{formatBytes(backup?.sizeBytes ?? null)}</td>
                      <td className="py-2.5 pr-4">
                        {backup ? (
                          <span className={backup.vssServiceOk ? 'text-emerald-600' : 'text-red-600'}>
                            {backup.vssServiceOk ? 'OK' : 'Deshabilitado'}
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-2 text-right">
                        <motion.span animate={{ rotate: isOpen ? 180 : 0 }} transition={{ duration: 0.2 }} className="inline-block text-slate-400">
                          <ChevronDown className="h-3.5 w-3.5" />
                        </motion.span>
                      </td>
                    </tr>

                    <AnimatePresence initial={false}>
                      {isOpen && (
                        <tr className="border-b border-slate-200 bg-slate-50">
                          <td colSpan={9} className="p-0">
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: 'auto', opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.2 }}
                              className="overflow-hidden"
                            >
                              <div className="space-y-3 px-4 py-4">
                                {backup?.wsb && <WsbDetailsPanel wsb={backup.wsb} />}
                                {backup?.targetPath && !backup?.wsb?.target && (
                                  <p className="flex items-center gap-1.5 text-[11px] text-slate-500">
                                    <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                                    <span className="break-all font-mono">{backup.targetPath}</span>
                                  </p>
                                )}
                                {backup?.jobs && (backup.jobs.length > 1 || !backup.wsb) && <BackupJobsList jobs={backup.jobs} />}
                                {backup?.detail && !backup?.jobs?.length && !backup?.wsb && (
                                  <pre className="whitespace-pre-wrap rounded-lg border border-slate-200 bg-white p-3 font-sans text-[11px] text-slate-600">
                                    {backup.detail}
                                  </pre>
                                )}

                                <div>
                                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                                    <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                                      <Clock className="h-3 w-3" />
                                      Historial de backups
                                      {backup?.successfulRuns ? (
                                        <span className="font-normal normal-case text-slate-400">
                                          · {backup.successfulRuns} copia(s) restaurable(s)
                                        </span>
                                      ) : null}
                                    </p>
                                    <div className="flex rounded-lg border border-slate-200 bg-white p-0.5 text-[11px]" onClick={(e) => e.stopPropagation()}>
                                      {[
                                        { v: true, label: 'Solo exitosos' },
                                        { v: false, label: 'Todas las corridas' },
                                      ].map((o) => (
                                        <button
                                          key={o.label}
                                          onClick={() => changeOnlySuccess(o.v)}
                                          className={`rounded-md px-2 py-0.5 transition-colors ${
                                            onlySuccess === o.v ? 'bg-brand-600 text-white' : 'text-slate-500 hover:bg-slate-50'
                                          }`}
                                        >
                                          {o.label}
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                  {hist === 'loading' && <p className="text-xs text-slate-400">Cargando...</p>}
                                  {hist === 'error' && <p className="text-xs text-red-600">No se pudo cargar el historial.</p>}
                                  {Array.isArray(hist) && hist.length === 0 && (
                                    <p className="text-xs text-slate-400">
                                      {onlySuccess ? 'Sin backups exitosos registrados todavía.' : 'Sin corridas registradas todavía.'}
                                    </p>
                                  )}
                                  {Array.isArray(hist) && hist.length > 0 && (
                                    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                                      <table className="w-full text-[11px]">
                                        <thead>
                                          <tr className="border-b border-slate-200 bg-slate-50 text-left text-slate-400">
                                            <th className="px-3 py-1.5 font-medium">Finalizó</th>
                                            <th className="px-3 py-1.5 font-medium">Resultado</th>
                                            <th className="px-3 py-1.5 font-medium">
                                              <span className="inline-flex items-center gap-1">
                                                <Timer className="h-3 w-3" />
                                                Duración
                                              </span>
                                            </th>
                                            <th className="px-3 py-1.5 font-medium">Tamaño</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {hist.map((h, i) => (
                                            <motion.tr
                                              key={h.id}
                                              initial={{ opacity: 0, y: 4 }}
                                              animate={{ opacity: 1, y: 0 }}
                                              transition={{ delay: Math.min(i * 0.02, 0.3) }}
                                              className="border-b border-slate-100 last:border-0"
                                            >
                                              <td className="px-3 py-1.5 text-slate-600">
                                                {h.finishedAt ? new Date(h.finishedAt).toLocaleString('es-ES') : 'Sin fecha'}
                                                {h.detail && h.result !== 'SUCCESS' && (
                                                  <p className="mt-0.5 line-clamp-2 text-[10px] text-slate-400">{h.detail}</p>
                                                )}
                                              </td>
                                              <td className="px-3 py-1.5">
                                                <span className={`rounded-full border px-2 py-0.5 ${BACKUP_STYLES[h.result].badge}`}>
                                                  {BACKUP_STYLES[h.result].label}
                                                </span>
                                              </td>
                                              <td className="px-3 py-1.5 font-mono text-slate-500">{formatDuration(h.durationSeconds)}</td>
                                              <td className="px-3 py-1.5 font-mono text-slate-500">{formatBytes(h.sizeBytes)}</td>
                                            </motion.tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </motion.div>
                          </td>
                        </tr>
                      )}
                    </AnimatePresence>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
