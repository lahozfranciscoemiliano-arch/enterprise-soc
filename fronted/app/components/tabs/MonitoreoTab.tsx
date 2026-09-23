import { useEffect, useMemo, useState } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import ServerDetailModal from '../ServerDetailModal';
import { BACKUP_STYLES, HEALTH_STYLES, MAINTENANCE_BADGE } from '../../lib/health';
import type { SecurityAlert, ServerSummary, TelemetryPoint } from '../../types';

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
  const [selectedServerId, setSelectedServerId] = useState<string | null>(servers[0]?.id ?? null);
  const [modalServerId, setModalServerId] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedServerId && servers.length > 0) {
      setSelectedServerId(servers[0].id);
    }
  }, [servers, selectedServerId]);

  const filteredServers = useMemo(
    () => servers.filter((s) => s.name.toLowerCase().includes(filter.toLowerCase())),
    [servers, filter]
  );

  const selectedHistory = selectedServerId ? history[selectedServerId] ?? [] : [];
  const modalServer = servers.find((s) => s.id === modalServerId) ?? null;
  const modalAlerts = modalServer ? alerts.filter((a) => a.serverName === modalServer.name).slice(0, 20) : [];

  return (
    <div className="animate-fade-in space-y-4 px-6 py-6">
      <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-200">CPU / RAM en tiempo real</h2>
          {servers.length > 0 && (
            <select
              value={selectedServerId ?? ''}
              onChange={(e) => setSelectedServerId(e.target.value)}
              className="rounded-lg border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-200"
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
          {selectedHistory.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-gray-500">Esperando telemetría...</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={selectedHistory}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                <XAxis dataKey="time" stroke="#6b7280" fontSize={11} />
                <YAxis stroke="#6b7280" fontSize={11} domain={[0, 100]} unit="%" />
                <Tooltip contentStyle={{ background: '#111827', border: '1px solid #1f2937', fontSize: 12 }} labelStyle={{ color: '#9ca3af' }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="cpuUsage" name="CPU %" stroke="#3b82f6" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="memoryUsage" name="RAM %" stroke="#a855f7" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-gray-200">
            Monitor de Infraestructura <span className="font-normal text-gray-500">(clic en un nodo para ver detalles)</span>
          </h2>
          <div className="flex items-center gap-2">
            <button
              onClick={onRefresh}
              disabled={refreshing}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
            >
              <span className={refreshing ? 'inline-block animate-spin' : ''}>🔄</span>
              {refreshing ? 'Actualizando...' : 'Actualizar'}
            </button>
            <input
              type="text"
              placeholder="Filtrar nodos..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-xs text-gray-200 outline-none focus:border-blue-500"
            />
          </div>
        </div>

        <div className="space-y-2">
          {filteredServers.length === 0 && <p className="py-6 text-center text-sm text-gray-500">Sin nodos que coincidan</p>}
          {filteredServers.map((s) => {
            const health = HEALTH_STYLES[s.healthStatus];
            const backup = BACKUP_STYLES[s.backup?.result ?? 'UNKNOWN'];
            return (
              <button
                key={s.id}
                onClick={() => setModalServerId(s.id)}
                className="flex w-full flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-800 bg-gray-950/50 px-4 py-3 text-left text-xs transition-colors hover:border-gray-700 hover:bg-gray-900"
              >
                <span className="flex items-center gap-2 font-medium text-gray-200">
                  🖥️ {s.name}
                  <span className={`h-2 w-2 rounded-full ${health.dot}`} />
                </span>
                <span className={`rounded-full border px-2 py-0.5 ${health.badge}`}>{health.label}</span>
                <span className={`rounded-full border px-2 py-0.5 ${backup.badge}`}>🗄️ {backup.label}</span>
                {s.inMaintenance && (
                  <span className={`rounded-full border px-2 py-0.5 ${MAINTENANCE_BADGE}`}>🔧 EN MANTENIMIENTO</span>
                )}
                <span className="text-gray-400">
                  {s.cpuUsage !== null ? `CPU ${s.cpuUsage.toFixed(0)}% · RAM ${s.memoryUsage!.toFixed(0)}% · Disco ${s.diskUsage!.toFixed(0)}%` : 'Sin telemetría'}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {modalServer && (
        <ServerDetailModal server={modalServer} alerts={modalAlerts} onClose={() => setModalServerId(null)} />
      )}
    </div>
  );
}
