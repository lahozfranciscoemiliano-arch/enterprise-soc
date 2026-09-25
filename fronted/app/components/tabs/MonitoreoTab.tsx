'use client';

import { useEffect, useMemo, useState } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AnimatePresence, motion } from 'framer-motion';
import { DatabaseBackup, RefreshCw, Search, Server, Wrench } from 'lucide-react';
import ServerDetailModal from '../ServerDetailModal';
import { BACKUP_STYLES, HEALTH_STYLES, MAINTENANCE_BADGE } from '../../lib/health';
import type { HealthStatus, SecurityAlert, ServerSummary, TelemetryPoint } from '../../types';

const TOOLTIP_STYLE = { background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 12, boxShadow: '0 4px 12px -2px rgb(15 23 42 / 0.08)' };

type HealthFilter = HealthStatus | 'ALL';

const HEALTH_FILTERS: { id: HealthFilter; label: string }[] = [
  { id: 'ALL', label: 'Todos' },
  { id: 'OK', label: 'OK' },
  { id: 'WARNING', label: 'Advertencia' },
  { id: 'CRITICAL', label: 'Crítico' },
  { id: 'UNKNOWN', label: 'Sin datos' },
];

export default function MonitoreoTab({
  servers,
  history,
  alerts,
  onRefresh,
  refreshing,
}: {
  servers: ServerSummary[];
  history: Record<string, TelemetryPoint[]>;
  alerts: SecurityAlert[];
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [filter, setFilter] = useState('');
  const [healthFilter, setHealthFilter] = useState<HealthFilter>('ALL');
  const [selectedServerId, setSelectedServerId] = useState<string | null>(servers[0]?.id ?? null);
  const [modalServerId, setModalServerId] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedServerId && servers.length > 0) {
      setSelectedServerId(servers[0].id);
    }
  }, [servers, selectedServerId]);

  const healthCounts = useMemo(() => {
    const counts: Record<HealthStatus, number> = { OK: 0, WARNING: 0, CRITICAL: 0, UNKNOWN: 0 };
    for (const s of servers) counts[s.healthStatus]++;
    return counts;
  }, [servers]);

  const filteredServers = useMemo(
    () =>
      servers
        .filter((s) => s.name.toLowerCase().includes(filter.toLowerCase()))
        .filter((s) => healthFilter === 'ALL' || s.healthStatus === healthFilter),
    [servers, filter, healthFilter]
  );

  const selectedServer = servers.find((s) => s.id === selectedServerId) ?? null;
  const selectedHistory = selectedServerId ? history[selectedServerId] ?? [] : [];
  const modalServer = servers.find((s) => s.id === modalServerId) ?? null;
  const modalAlerts = modalServer ? alerts.filter((a) => a.serverName === modalServer.name).slice(0, 20) : [];

  return (
    <div className="space-y-4 px-6 py-6">
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-800">
            CPU / RAM en tiempo real
            {selectedServer && <span className="ml-2 font-normal text-slate-400">— {selectedServer.name}</span>}
          </h2>
          {servers.length > 0 && (
            <select
              value={selectedServerId ?? ''}
              onChange={(e) => setSelectedServerId(e.target.value)}
              className="rounded-lg border border-slate-300 bg-slate-50 px-2 py-1 text-xs text-slate-700 outline-none focus:border-brand-500"
            >
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="h-64">
          <AnimatePresence mode="wait">
            {selectedHistory.length === 0 ? (
              <motion.div
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex h-full items-center justify-center text-sm text-slate-400"
              >
                Esperando telemetría...
              </motion.div>
            ) : (
              <motion.div key={selectedServerId} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="h-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={selectedHistory}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="time" stroke="#94a3b8" fontSize={11} />
                    <YAxis stroke="#94a3b8" fontSize={11} domain={[0, 100]} unit="%" />
                    <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: '#475569' }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Line type="monotone" dataKey="cpuUsage" name="CPU %" stroke="#c2632d" strokeWidth={2} dot={false} isAnimationActive />
                    <Line type="monotone" dataKey="memoryUsage" name="RAM %" stroke="#3b82f6" strokeWidth={2} dot={false} isAnimationActive />
                  </LineChart>
                </ResponsiveContainer>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-800">
            Monitor de Infraestructura <span className="font-normal text-slate-400">(clic en un nodo para ver detalles)</span>
          </h2>
          <div className="flex items-center gap-2">
            <motion.button
              whileTap={{ scale: 0.97 }}
              onClick={onRefresh}
              disabled={refreshing}
              className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-700 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              {refreshing ? 'Actualizando...' : 'Actualizar'}
            </motion.button>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder="Filtrar nodos..."
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="rounded-lg border border-slate-300 bg-slate-50 py-1.5 pl-8 pr-3 text-xs text-slate-800 outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10 transition-colors"
              />
            </div>
          </div>
        </div>

        <div className="mb-4 flex flex-wrap gap-1.5">
          {HEALTH_FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setHealthFilter(f.id)}
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                healthFilter === f.id
                  ? 'border-brand-600 bg-brand-600 text-white'
                  : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'
              }`}
            >
              {f.label}
              {f.id !== 'ALL' && (
                <span className={healthFilter === f.id ? 'text-white/80' : 'text-slate-400'}>{healthCounts[f.id]}</span>
              )}
            </button>
          ))}
        </div>

        <p className="mb-2 text-xs text-slate-400">
          {filteredServers.length} de {servers.length} nodo(s)
        </p>

        <div className="space-y-2">
          <AnimatePresence initial={false}>
            {filteredServers.length === 0 && (
              <motion.p
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="py-6 text-center text-sm text-slate-400"
              >
                Sin nodos que coincidan
              </motion.p>
            )}
            {filteredServers.map((s) => {
              const health = HEALTH_STYLES[s.healthStatus];
              const backup = BACKUP_STYLES[s.backup?.result ?? 'UNKNOWN'];
              return (
                <motion.button
                  key={s.id}
                  layout
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.18 }}
                  onClick={() => setModalServerId(s.id)}
                  className="flex w-full flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 text-left text-xs transition-colors hover:border-slate-300 hover:bg-slate-50"
                >
                  <span className="flex items-center gap-2 font-medium text-slate-800">
                    <Server className="h-3.5 w-3.5 text-slate-400" />
                    {s.name}
                    <span className={`h-2 w-2 rounded-full ${health.dot}`} />
                  </span>
                  <span className={`rounded-full border px-2 py-0.5 ${health.badge}`}>{health.label}</span>
                  <span className={`flex items-center gap-1 rounded-full border px-2 py-0.5 ${backup.badge}`}>
                    <DatabaseBackup className="h-3 w-3" />
                    {backup.label}
                  </span>
                  {s.inMaintenance && (
                    <span className={`flex items-center gap-1 rounded-full border px-2 py-0.5 ${MAINTENANCE_BADGE}`}>
                      <Wrench className="h-3 w-3" />
                      EN MANTENIMIENTO
                    </span>
                  )}
                  <span className="text-slate-500">
                    {s.cpuUsage !== null ? `CPU ${s.cpuUsage.toFixed(0)}% · RAM ${s.memoryUsage!.toFixed(0)}% · Disco ${s.diskUsage!.toFixed(0)}%` : 'Sin telemetría'}
                  </span>
                </motion.button>
              );
            })}
          </AnimatePresence>
        </div>
      </div>

      {modalServer && (
        <ServerDetailModal server={modalServer} alerts={modalAlerts} onClose={() => setModalServerId(null)} />
      )}
    </div>
  );
}
