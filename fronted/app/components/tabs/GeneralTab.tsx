'use client';

import { useMemo, useState } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, BellOff, CheckCircle2, ChevronDown, DatabaseBackup, Gauge, Server, ServerOff } from 'lucide-react';
import StatCard from '../StatCard';
import ResourceUsagePanel from '../ResourceUsagePanel';
import ServerDetailModal from '../ServerDetailModal';
import { SEVERITY_STYLES, timeAgo } from '../../lib/health';
import type { DashboardSummary, SecurityAlert, ServerSummary, Severity } from '../../types';

const panel = 'rounded-xl border border-slate-200 bg-white p-4 shadow-card';
const TRACK = '#eef2f7';

type Item = { id: string; name: string; hint?: string | null };

// Un grafico por estado: el anillo muestra la proporcion sobre el total, el
// numero grande del centro es la cantidad, y debajo se listan los servidores.
function StatusDonut({
  label,
  count,
  total,
  color,
  text,
  items,
  onOpen,
}: {
  label: string;
  count: number;
  total: number;
  color: string;
  text: string;
  items: Item[];
  onOpen: (id: string) => void;
}) {
  const data = [
    { name: label, value: count },
    { name: 'resto', value: Math.max(total - count, 0) },
  ];
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div className="flex min-w-0 flex-col items-center rounded-lg border border-slate-100 bg-slate-50/40 p-3">
      <div className="relative h-28 w-28">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" innerRadius={38} outerRadius={52} startAngle={90} endAngle={-270} stroke="none" isAnimationActive={false}>
              <Cell fill={count > 0 ? color : TRACK} />
              <Cell fill={TRACK} />
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className={`text-2xl font-bold leading-none ${count > 0 ? text : 'text-slate-300'}`}>{count}</span>
          <span className="mt-0.5 text-[10px] text-slate-400">{pct}%</span>
        </div>
      </div>
      <p className={`mt-1 text-xs font-semibold ${text}`}>{label}</p>
      <div className="mt-2 max-h-36 w-full overflow-y-auto">
        {items.length === 0 ? (
          <p className="text-center text-[11px] text-slate-300">Ninguno</p>
        ) : (
          <ul className="space-y-0.5">
            {items.map((it) => (
              <li key={it.id}>
                <button
                  onClick={() => onOpen(it.id)}
                  title={it.hint ?? undefined}
                  className="flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-[11px] text-slate-600 transition-colors hover:bg-white"
                >
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
                  <span className="truncate font-medium">{it.name}</span>
                  {it.hint && <span className="ml-auto shrink-0 font-mono text-[10px] text-slate-400">{it.hint}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const pctHint = (v: number | null) => (v === null ? null : `${Math.round(v)}%`);

function worstMetric(s: { cpu: number | null; ram: number | null; disk: number | null }): string | null {
  const m = [
    ['CPU', s.cpu],
    ['RAM', s.ram],
    ['Disco', s.disk],
  ].filter(([, v]) => v !== null) as [string, number][];
  if (m.length === 0) return null;
  const [k, v] = m.sort((a, b) => b[1] - a[1])[0];
  return `${k} ${pctHint(v)}`;
}

const SEV_LABEL: Record<Severity, string> = { CRITICAL: 'Crítica', HIGH: 'Alta', MEDIUM: 'Media', LOW: 'Baja' };
const SEVERITIES: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

export default function GeneralTab({
  summary,
  servers,
  alerts,
}: {
  summary: DashboardSummary | null;
  servers: ServerSummary[];
  alerts: SecurityAlert[];
}) {
  const [modalServerId, setModalServerId] = useState<string | null>(null);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [sevFilter, setSevFilter] = useState<Severity | 'ALL'>('ALL');

  const offlineCount = servers.filter((s) => s.status === 'OFFLINE').length;
  const hs = summary?.healthServers;
  const bs = summary?.backupServerList;
  const healthTotal = summary ? summary.totalServers : 0;
  const backupTotal = summary?.backupServers ?? 0;

  const openList = useMemo(() => summary?.openAlertList ?? [], [summary]);
  const sevCounts = useMemo(() => {
    const c: Record<Severity, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
    for (const a of openList) c[a.severity] += 1;
    return c;
  }, [openList]);
  const shownAlerts = sevFilter === 'ALL' ? openList : openList.filter((a) => a.severity === sevFilter);

  const modalServer = servers.find((s) => s.id === modalServerId) ?? null;
  const modalAlerts = alerts.filter((a) => a.serverId === modalServerId);

  const healthItems = (k: 'OK' | 'WARNING' | 'CRITICAL' | 'UNKNOWN') =>
    (hs?.[k] ?? []).map((s) => ({ id: s.id, name: s.name, hint: k === 'OK' ? null : k === 'UNKNOWN' ? 'sin datos' : worstMetric(s) }));
  const backupItems = (k: 'SUCCESS' | 'WARNING' | 'FAILED' | 'NOT_CONFIGURED' | 'UNKNOWN') =>
    (bs?.[k] ?? []).map((s) => ({ id: s.id, name: s.name, hint: s.lastBackupAt ? timeAgo(s.lastBackupAt) : null }));
  const backupOther = [...backupItems('NOT_CONFIGURED'), ...backupItems('UNKNOWN')];

  return (
    <div className="space-y-4 px-3 py-4 sm:px-6 sm:py-6">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard label="SLA Confiabilidad" value={summary ? `${summary.slaPercentage.toFixed(2)}%` : '—'} color="emerald" icon={<Gauge className="h-5 w-5" />} />
        <StatCard label="Total Nodos" value={summary ? summary.totalServers.toString() : '—'} color="blue" icon={<Server className="h-5 w-5" />} />
        <StatCard label="Servidores Saludables" value={summary ? summary.healthyServers.toString() : '—'} color="emerald" icon={<CheckCircle2 className="h-5 w-5" />} />
        <StatCard label="Servidores Offline" value={offlineCount.toString()} color={offlineCount > 0 ? 'red' : 'emerald'} icon={<ServerOff className="h-5 w-5" />} />
        <StatCard
          label="Backups Exitosos"
          value={summary ? `${summary.backupBreakdown.SUCCESS}/${summary.backupServers ?? summary.totalServers}` : '—'}
          color={summary && summary.backupBreakdown.FAILED > 0 ? 'red' : 'emerald'}
          icon={<DatabaseBackup className="h-5 w-5" />}
        />
        <button onClick={() => setAlertsOpen((o) => !o)} className="text-left" aria-expanded={alertsOpen}>
          <div className="relative">
            <StatCard
              label="Alertas / Críticos"
              value={summary ? `${summary.openAlerts} / ${summary.criticalAlerts}` : '—'}
              color={summary && summary.criticalAlerts > 0 ? 'red' : 'blue'}
              icon={<AlertTriangle className="h-5 w-5" />}
            />
            <motion.span animate={{ rotate: alertsOpen ? 180 : 0 }} className="absolute right-2 top-2 text-slate-400">
              <ChevronDown className="h-4 w-4" />
            </motion.span>
          </div>
        </button>
      </div>

      <AnimatePresence initial={false}>
        {alertsOpen && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className={panel}>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-slate-700">Alertas abiertas ({openList.length})</h2>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    onClick={() => setSevFilter('ALL')}
                    className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${sevFilter === 'ALL' ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 text-slate-500'}`}
                  >
                    Todas {openList.length}
                  </button>
                  {SEVERITIES.map((s) => (
                    <button
                      key={s}
                      onClick={() => setSevFilter(s)}
                      className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${sevFilter === s ? 'ring-2 ring-brand-500/40' : ''} ${SEVERITY_STYLES[s]}`}
                    >
                      {SEV_LABEL[s]} {sevCounts[s]}
                    </button>
                  ))}
                </div>
              </div>
              {shownAlerts.length === 0 ? (
                <p className="py-6 text-center text-sm text-slate-400">Sin alertas abiertas</p>
              ) : (
                <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
                  {shownAlerts.map((a) => (
                    <li key={a.id} className="flex items-start gap-2 py-2">
                      <span className={`mt-0.5 shrink-0 rounded border px-1.5 text-[10px] font-semibold ${SEVERITY_STYLES[a.severity]}`}>{SEV_LABEL[a.severity]}</span>
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-x-2 text-xs">
                          {a.serverId ? (
                            <button onClick={() => setModalServerId(a.serverId)} className="font-semibold text-slate-800 hover:text-brand-700 hover:underline">
                              {a.serverName}
                            </button>
                          ) : (
                            <span className="font-semibold text-slate-800">{a.serverName ?? '—'}</span>
                          )}
                          <span className="font-mono text-[10px] text-slate-400">{a.type}</span>
                          {a.silent && (
                            <span className="inline-flex items-center gap-0.5 text-[10px] text-slate-400">
                              <BellOff className="h-3 w-3" /> silenciosa
                            </span>
                          )}
                          {a.occurrences > 1 && <span className="text-[10px] text-slate-400">×{a.occurrences}</span>}
                        </p>
                        <p className="truncate text-[11px] text-slate-500" title={a.summary}>
                          {a.summary}
                        </p>
                      </div>
                      <span className="shrink-0 text-[10px] text-slate-400">{timeAgo(a.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }} className={panel}>
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-slate-700">Health Status</h2>
            <span className="text-[11px] text-slate-400">
              {healthTotal} nodos{summary && summary.healthBreakdown.UNKNOWN > 0 ? ` · ${summary.healthBreakdown.UNKNOWN} sin datos` : ''}
            </span>
          </div>
          {!summary ? (
            <div className="flex h-40 items-center justify-center text-sm text-slate-400">Sin datos aún</div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <StatusDonut label="Saludables" count={summary.healthBreakdown.OK} total={healthTotal} color="#10b981" text="text-emerald-600" items={healthItems('OK')} onOpen={setModalServerId} />
              <StatusDonut label="Advertencias" count={summary.healthBreakdown.WARNING} total={healthTotal} color="#f59e0b" text="text-amber-600" items={healthItems('WARNING')} onOpen={setModalServerId} />
              <StatusDonut label="Críticos" count={summary.healthBreakdown.CRITICAL} total={healthTotal} color="#ef4444" text="text-red-600" items={healthItems('CRITICAL')} onOpen={setModalServerId} />
            </div>
          )}
          {summary && healthItems('UNKNOWN').length > 0 && (
            <p className="mt-2 text-[11px] text-slate-400">
              Sin datos: {healthItems('UNKNOWN').map((s) => s.name).join(', ')}
            </p>
          )}
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className={panel}>
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-slate-700">Estado de Backups</h2>
            <span className="text-[11px] text-slate-400">{backupTotal} servidores con backup</span>
          </div>
          {!summary ? (
            <div className="flex h-40 items-center justify-center text-sm text-slate-400">Sin datos aún</div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <StatusDonut label="Exitosos" count={summary.backupBreakdown.SUCCESS} total={backupTotal} color="#10b981" text="text-emerald-600" items={backupItems('SUCCESS')} onOpen={setModalServerId} />
              <StatusDonut label="Advertencias" count={summary.backupBreakdown.WARNING} total={backupTotal} color="#f59e0b" text="text-amber-600" items={backupItems('WARNING')} onOpen={setModalServerId} />
              <StatusDonut label="Fallidos" count={summary.backupBreakdown.FAILED} total={backupTotal} color="#ef4444" text="text-red-600" items={backupItems('FAILED')} onOpen={setModalServerId} />
            </div>
          )}
          {backupOther.length > 0 && (
            <p className="mt-2 text-[11px] text-slate-400">Sin backup configurado / sin datos: {backupOther.map((s) => s.name).join(', ')}</p>
          )}
        </motion.div>
      </div>

      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
        <ResourceUsagePanel servers={servers} alerts={alerts} />
      </motion.div>

      {modalServer && <ServerDetailModal server={modalServer} alerts={modalAlerts} onClose={() => setModalServerId(null)} />}
    </div>
  );
}
