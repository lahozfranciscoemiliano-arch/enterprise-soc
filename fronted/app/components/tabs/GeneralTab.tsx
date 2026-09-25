import { Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { motion } from 'framer-motion';
import { AlertTriangle, CheckCircle2, DatabaseBackup, Gauge, Server } from 'lucide-react';
import StatCard from '../StatCard';
import type { DashboardSummary, ServerSummary } from '../../types';

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

export default function GeneralTab({
  summary,
  servers,
}: {
  summary: DashboardSummary | null;
  servers: ServerSummary[];
}) {
  const donutData = summary
    ? [
        { name: 'Saludables', value: summary.healthBreakdown.OK, color: HEALTH_COLORS.OK },
        { name: 'Advertencias', value: summary.healthBreakdown.WARNING, color: HEALTH_COLORS.WARNING },
        { name: 'Críticos', value: summary.healthBreakdown.CRITICAL, color: HEALTH_COLORS.CRITICAL },
      ]
    : [];

  const barData = servers
    .filter((s) => s.cpuUsage !== null)
    .map((s) => ({ name: s.name, CPU: s.cpuUsage, RAM: s.memoryUsage }));

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

  return (
    <div className="space-y-4 px-6 py-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
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

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }} className={panel}>
          <h2 className="mb-2 text-sm font-semibold text-slate-700">Health Status</h2>
          <div className="h-64">
            {hasHealthData ? (
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
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-slate-400">Sin datos aún</div>
            )}
          </div>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className={panel}>
          <h2 className="mb-2 text-sm font-semibold text-slate-700">Estado de Backups</h2>
          <div className="h-64">
            {hasBackupData ? (
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
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-slate-400">Sin datos aún</div>
            )}
          </div>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }} className={panel}>
          <h2 className="mb-2 text-sm font-semibold text-slate-700">Uso de Recursos por Nodo</h2>
          <div className="h-64">
            {barData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={barData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="name" stroke="#94a3b8" fontSize={11} />
                  <YAxis stroke="#94a3b8" fontSize={11} unit="%" domain={[0, 100]} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="CPU" fill="#c2632d" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="RAM" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-slate-400">Sin datos aún</div>
            )}
          </div>
        </motion.div>
      </div>
    </div>
  );
}
