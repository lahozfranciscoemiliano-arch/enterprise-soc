import { useEffect } from 'react';
import { HEALTH_STYLES, SEVERITY_STYLES } from '../lib/health';
import type { SecurityAlert, ServerSummary } from '../types';

function relativeTime(iso: string | null): string {
  if (!iso) return 'Sin datos';
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'Hace instantes';
  if (minutes < 60) return `Hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Hace ${hours} hs`;
  return `Hace ${Math.round(hours / 24)} días`;
}

function DetailTile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-950/50 p-4">
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <div className="mt-1 text-lg font-semibold text-gray-100">{children}</div>
    </div>
  );
}

export default function ServerDetailModal({
  server,
  alerts,
  onClose,
}: {
  server: ServerSummary;
  alerts: SecurityAlert[];
  onClose: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const health = HEALTH_STYLES[server.healthStatus];
  const isOnline = server.status === 'ONLINE';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl animate-fade-in-scale rounded-xl border border-gray-800 bg-gray-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-gray-800 p-6">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-blue-500/10 text-2xl">🖥️</div>
            <div>
              <h2 className="text-lg font-semibold text-gray-100">{server.name}</h2>
              <p className="text-xs text-gray-500">Inspección detallada en tiempo real</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800"
          >
            Cerrar
          </button>
        </div>

        <div className="grid grid-cols-1 gap-3 p-6 sm:grid-cols-2">
          <DetailTile label="Estado de Conexión">
            <span className="flex items-center gap-2">
              <span className={`h-2.5 w-2.5 rounded-full ${isOnline ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
              {server.status}
            </span>
          </DetailTile>
          <DetailTile label="Estado de Salud">
            <span className={`inline-block rounded-full border px-2 py-0.5 text-sm ${health.badge}`}>{health.label}</span>
          </DetailTile>
          <DetailTile label="CPU">{server.cpuUsage !== null ? `${server.cpuUsage.toFixed(1)}%` : '—'}</DetailTile>
          <DetailTile label="RAM">{server.memoryUsage !== null ? `${server.memoryUsage.toFixed(1)}%` : '—'}</DetailTile>
          <DetailTile label="Disco">{server.diskUsage !== null ? `${server.diskUsage.toFixed(1)}%` : '—'}</DetailTile>
          <DetailTile label="Última Telemetría">{relativeTime(server.recordedAt)}</DetailTile>
        </div>

        <div className="border-t border-gray-800 p-6">
          <p className="mb-3 text-xs uppercase tracking-wide text-gray-500">Alertas recientes de este servidor</p>
          {alerts.length === 0 ? (
            <p className="text-sm text-gray-500">Sin alertas registradas.</p>
          ) : (
            <ul className="max-h-40 space-y-2 overflow-y-auto">
              {alerts.map((a) => (
                <li key={a.id} className="flex items-center justify-between rounded-lg bg-gray-950/50 px-3 py-2 text-xs">
                  <span className="text-gray-300">{a.description}</span>
                  <span className={`ml-3 shrink-0 rounded-full border px-2 py-0.5 ${SEVERITY_STYLES[a.severity]}`}>
                    {a.severity}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
