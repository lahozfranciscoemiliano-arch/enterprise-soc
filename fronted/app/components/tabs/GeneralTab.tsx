import { Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import StatCard from '../StatCard';
import type { DashboardSummary, ServerSummary } from '../../types';

const HEALTH_COLORS = { OK: '#10b981', WARNING: '#f59e0b', CRITICAL: '#ef4444' };

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

  return (
    <div className="animate-fade-in space-y-4 px-6 py-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="SLA Confiabilidad" value={summary ? `${summary.slaPercentage.toFixed(2)}%` : '—'} color="emerald" icon="📊" />
        <StatCard label="Total Nodos" value={summary ? summary.totalServers.toString() : '—'} color="blue" icon="🖧" />
        <StatCard label="Servidores Saludables" value={summary ? summary.healthyServers.toString() : '—'} color="emerald" icon="✅" />
        <StatCard
          label="Alertas / Críticos"
          value={summary ? `${summary.openAlerts} / ${summary.criticalAlerts}` : '—'}
          color={summary && summary.criticalAlerts > 0 ? 'red' : 'blue'}
          icon="⚠️"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">
          <h2 className="mb-2 text-sm font-semibold text-gray-200">Health Status</h2>
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
                  <Tooltip contentStyle={{ background: '#111827', border: '1px solid #1f2937', fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-gray-500">Sin datos aún</div>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">
          <h2 className="mb-2 text-sm font-semibold text-gray-200">Uso de Recursos por Nodo</h2>
          <div className="h-64">
            {barData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={barData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                  <XAxis dataKey="name" stroke="#6b7280" fontSize={11} />
                  <YAxis stroke="#6b7280" fontSize={11} unit="%" domain={[0, 100]} />
                  <Tooltip contentStyle={{ background: '#111827', border: '1px solid #1f2937', fontSize: 12 }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="CPU" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="RAM" fill="#a855f7" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-gray-500">Sin datos aún</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
