'use client';

import { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, Cpu, Gauge, HardDrive, MemoryStick } from 'lucide-react';
import ServerDetailModal from './ServerDetailModal';
import { HEALTH_STYLES, resourceLevel, RESOURCE_LEVEL_COLOR } from '../lib/health';
import type { SecurityAlert, ServerSummary } from '../types';

const COLLAPSED_ROWS = 8;

function MetricBar({ label, value, kind, icon: Icon }: {
  label: string;
  value: number;
  kind: 'cpuUsage' | 'memoryUsage' | 'diskUsage';
  icon: React.ComponentType<{ className?: string }>;
}) {
  const level = resourceLevel(value, kind);
  const color = RESOURCE_LEVEL_COLOR[level];

  return (
    <div className="min-w-0 flex-1">
      <div className="mb-1 flex items-center justify-between gap-2 text-[11px]">
        <span className="flex items-center gap-1 font-medium text-slate-500">
          <Icon className="h-3 w-3" />
          {label}
        </span>
        <span className={`font-semibold tabular-nums ${color.text}`}>{value.toFixed(0)}%</span>
      </div>
      <div className={`h-1.5 w-full overflow-hidden rounded-full ${color.track}`}>
        <motion.div
          className={`h-full rounded-full ${color.bar}`}
          initial={{ width: 0 }}
          animate={{ width: `${Math.min(value, 100)}%` }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
        />
      </div>
    </div>
  );
}

function FleetStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-lg font-semibold text-slate-800">{value}</span>
      <span className="text-[11px] text-slate-400">{label}</span>
    </div>
  );
}

export default function ResourceUsagePanel({ servers, alerts }: { servers: ServerSummary[]; alerts: SecurityAlert[] }) {
  const [showAll, setShowAll] = useState(false);
  const [modalServerId, setModalServerId] = useState<string | null>(null);

  const reporting = useMemo(
    () =>
      servers
        .filter((s): s is ServerSummary & { cpuUsage: number; memoryUsage: number; diskUsage: number } =>
          s.cpuUsage !== null && s.memoryUsage !== null && s.diskUsage !== null
        )
        .sort((a, b) => Math.max(b.cpuUsage, b.memoryUsage, b.diskUsage) - Math.max(a.cpuUsage, a.memoryUsage, a.diskUsage)),
    [servers]
  );

  const notReporting = servers.length - reporting.length;

  const averages = useMemo(() => {
    if (reporting.length === 0) return null;
    const sum = reporting.reduce(
      (acc, s) => ({ cpu: acc.cpu + s.cpuUsage, ram: acc.ram + s.memoryUsage, disk: acc.disk + s.diskUsage }),
      { cpu: 0, ram: 0, disk: 0 }
    );
    return {
      cpu: sum.cpu / reporting.length,
      ram: sum.ram / reporting.length,
      disk: sum.disk / reporting.length,
    };
  }, [reporting]);

  const visible = showAll ? reporting : reporting.slice(0, COLLAPSED_ROWS);
  const modalServer = servers.find((s) => s.id === modalServerId) ?? null;
  const modalAlerts = modalServer ? alerts.filter((a) => a.serverName === modalServer.name).slice(0, 20) : [];

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700">
          <Gauge className="h-4 w-4 text-slate-400" />
          Uso de Recursos por Nodo
          <span className="hidden font-normal text-slate-400 sm:inline">(ordenado por mayor uso)</span>
        </h2>
        {averages && (
          <div className="flex items-center gap-4 sm:gap-5">
            <FleetStat label="CPU prom." value={`${averages.cpu.toFixed(0)}%`} />
            <FleetStat label="RAM prom." value={`${averages.ram.toFixed(0)}%`} />
            <FleetStat label="Disco prom." value={`${averages.disk.toFixed(0)}%`} />
          </div>
        )}
      </div>

      {reporting.length === 0 ? (
        <div className="flex h-32 items-center justify-center text-sm text-slate-400">
          Esperando telemetría de los nodos...
        </div>
      ) : (
        <>
          <div className="space-y-1.5">
            {visible.map((s, i) => {
              const health = HEALTH_STYLES[s.healthStatus];
              return (
                <motion.button
                  key={s.id}
                  layout
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(i * 0.03, 0.3) }}
                  onClick={() => setModalServerId(s.id)}
                  className="grid w-full grid-cols-3 items-center gap-x-3 gap-y-2 rounded-lg sm:grid-cols-[1.25rem_minmax(0,11rem)_repeat(3,minmax(0,1fr))] sm:gap-4 border border-transparent px-3 py-2.5 text-left transition-colors hover:border-slate-200 hover:bg-slate-50"
                >
                  <span className="hidden text-xs font-medium tabular-nums text-slate-300 sm:inline">{i + 1}</span>
                  <span className="col-span-3 flex min-w-0 items-center gap-2 sm:col-span-1">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${health.dot}`} />
                    <span className="truncate text-sm font-medium text-slate-800">{s.name}</span>
                  </span>
                  <MetricBar label="CPU" value={s.cpuUsage} kind="cpuUsage" icon={Cpu} />
                  <MetricBar label="RAM" value={s.memoryUsage} kind="memoryUsage" icon={MemoryStick} />
                  <MetricBar label="Disco" value={s.diskUsage} kind="diskUsage" icon={HardDrive} />
                </motion.button>
              );
            })}
          </div>

          {reporting.length > COLLAPSED_ROWS && (
            <button
              onClick={() => setShowAll((v) => !v)}
              className="mx-auto mt-3 flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700"
            >
              <motion.span animate={{ rotate: showAll ? 180 : 0 }} transition={{ duration: 0.2 }}>
                <ChevronDown className="h-3.5 w-3.5" />
              </motion.span>
              {showAll ? 'Mostrar menos' : `Mostrar los ${reporting.length} nodos`}
            </button>
          )}

          {notReporting > 0 && (
            <p className="mt-3 border-t border-slate-100 pt-2 text-center text-[11px] text-slate-400">
              {notReporting} nodo(s) sin telemetría todavía
            </p>
          )}
        </>
      )}

      <AnimatePresence>
        {modalServer && (
          <ServerDetailModal server={modalServer} alerts={modalAlerts} onClose={() => setModalServerId(null)} />
        )}
      </AnimatePresence>
    </div>
  );
}
