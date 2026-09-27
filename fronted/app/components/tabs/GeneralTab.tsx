import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { motion } from 'framer-motion';
import { AlertTriangle, CheckCircle2, DatabaseBackup, Gauge, Server, ServerOff } from 'lucide-react';
import StatCard from '../StatCard';
import ResourceUsagePanel from '../ResourceUsagePanel';
import type { DashboardSummary, SecurityAlert, ServerSummary } from '../../types';

const HEALTH_COLORS = { OK: '#10b981', WARNING: '#f59e0b', CRITICAL: '#ef4444' };
const BACKUP_COLORS = {
  SUCCESS: '#10b981',
  WARNING: '#f59e0b',
  FAILED: '#ef4444',
  NOT_CONFIGURED: '#cbd5e1',
  UNKNOWN: '#94a3b8',
};
const TOOLTIP_STYLE = { background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 12, boxShadow: '0 4px 12px -2px rgb(15 23 42 / 0.08)' };

const panel = 'rounded-xl border border-slate-200 bg-white p-4 shadow-card';

function DonutCenter({ value, label }: { value: number; label: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
      <span className="text-2xl font-semibold text-slate-800">{value}</span>
      <span className="text-[11px] text-slate-400">{label}</span>
    </div>
  );
}

export default function GeneralTab({
  summary,
  servers,
  alerts,
}: {
  summary: DashboardSummary | null;
  servers: ServerSummary[];
  alerts: SecurityAlert[];
}) {
  const donutData = summary
    ? [
        { name: 'Saludables', value: summary.healthBreakdown.OK, color: HEALTH_COLORS.OK },
        { name: 'Advertencias', value: summary.healthBreakdown.WARNING, color: HEALTH_COLORS.WARNING },
        { name: 'Críticos', value: summary.healthBreakdown.CRITICAL, color: HEALTH_COLORS.CRITICAL },
      ]
    : [];
  const hasHealthData = donutData.some((d) => d.value > 0);

  const backupDonutData = summary
    ? [
        { name: 'Exitosos', value: summary.backupBreakdown.SUCCESS, color: BACKUP_COLORS.SUCCESS },
        { name: 'Advertencias', value: summary.backupBreakdown.WARNING, color: BACKUP_COLORS.WARNING },
        { name: 'Fallidos', value: summary.backupBreakdown.FAILED, color: BACKUP_COLORS.FAILED },
        { name: 'No configurados', value: summary.backupBreakdown.NOT_CONFIGURED, color: BACKUP_COLORS.NOT_CONFIGURED },
        { name: 'Sin datos', value: summary.backupBreakdown.UNKNOWN, color: BACKUP_COLORS.UNKNOWN },
      ]
    : [];
  const hasBackupData = backupDonutData.some((d) => d.value > 0);

  const offlineCount = servers.filter((s) => s.status === 'OFFLINE').length;

  return (
    <div className="space-y-4 px-3 py-4 sm:px-6 sm:py-6">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label="SLA Confiabilidad"
          value={summary ? `${summary.slaPercentage.toFixed(2)}%` : '—'}
          color="emerald"
          icon={<Gauge className="h-5 w-5" />}
        />
        <StatCard
          label="Total Nodos"
          value={summary ? summary.totalServers.toString() : '—'}
          color="blue"
          icon={<Server className="h-5 w-5" />}
        />
        <StatCard
          label="Servidores Saludables"
          value={summary ? summary.healthyServers.toString() : '—'}
          color="emerald"
          icon={<CheckCircle2 className="h-5 w-5" />}
        />
        <StatCard
          label="Servidores Offline"
          value={offlineCount.toString()}
          color={offlineCount > 0 ? 'red' : 'emerald'}
          icon={<ServerOff className="h-5 w-5" />}
        />
        <StatCard
          label="Backups Exitosos"
          value={summary ? `${summary.backupBreakdown.SUCCESS}/${summary.totalServers}` : '—'}
          color={summary && summary.backupBreakdown.FAILED > 0 ? 'red' : 'emerald'}
          icon={<DatabaseBackup className="h-5 w-5" />}
        />
        <StatCard
          label="Alertas / Críticos"
          value={summary ? `${summary.openAlerts} / ${summary.criticalAlerts}` : '—'}
          color={summary && summary.criticalAlerts > 0 ? 'red' : 'blue'}
          icon={<AlertTriangle className="h-5 w-5" />}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }} className={panel}>
          <h2 className="mb-2 text-sm font-semibold text-slate-700">Health Status</h2>
          <div className="relative h-52 sm:h-64">
            {hasHealthData ? (
              <>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={donutData} dataKey="value" nameKey="name" innerRadius={60} outerRadius={90} paddingAngle={2}>
                      {donutData.map((d) => (
                        <Cell key={d.name} fill={d.color} stroke="none" />
                      ))}
                    </Pie>
                    <Legend verticalAlign="bottom" iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} />
                  </PieChart>
                </ResponsiveContainer>
                <DonutCenter value={summary?.totalServers ?? 0} label="nodos" />
              </>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-slate-400">Sin datos aún</div>
            )}
          </div>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className={panel}>
          <h2 className="mb-2 text-sm font-semibold text-slate-700">Estado de Backups</h2>
          <div className="relative h-52 sm:h-64">
            {hasBackupData ? (
              <>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={backupDonutData} dataKey="value" nameKey="name" innerRadius={60} outerRadius={90} paddingAngle={2}>
                      {backupDonutData.map((d) => (
                        <Cell key={d.name} fill={d.color} stroke="none" />
                      ))}
                    </Pie>
                    <Legend verticalAlign="bottom" iconType="circle" wrapperStyle={{ fontSize: 11 }} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} />
                  </PieChart>
                </ResponsiveContainer>
                <DonutCenter value={summary?.backupBreakdown.SUCCESS ?? 0} label="exitosos" />
              </>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-slate-400">Sin datos aún</div>
            )}
          </div>
        </motion.div>
      </div>

      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
        <ResourceUsagePanel servers={servers} alerts={alerts} />
      </motion.div>
    </div>
  );
}
