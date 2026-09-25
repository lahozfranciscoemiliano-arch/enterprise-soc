import type { SecurityAlert, ServerSummary } from '../../types';

// Vista pensada para el celular de quien esta de guardia a la noche: solo lo
// que realmente necesita accion ahora (CRITICAL/HIGH abiertas, servidores
// caidos, backups fallidos), en texto grande y sin graficos ni tablas
// densas. Todo lo demas del dashboard sigue disponible en las otras
// pestañas si hace falta profundizar.
export default function GuardiaTab({
  servers,
  alerts,
  onUpdateStatus,
}: {
  servers: ServerSummary[];
  alerts: SecurityAlert[];
  onUpdateStatus: (id: string, status: 'ACKNOWLEDGED' | 'RESOLVED') => void;
}) {
  const criticalAlerts = alerts.filter((a) => a.status !== 'RESOLVED' && (a.severity === 'CRITICAL' || a.severity === 'HIGH'));
  const offlineServers = servers.filter((s) => s.status === 'OFFLINE');
  const failedBackups = servers.filter((s) => s.backup?.result === 'FAILED');

  const allClear = criticalAlerts.length === 0 && offlineServers.length === 0 && failedBackups.length === 0;

  return (
    <div className="animate-fade-in space-y-4 px-4 py-6 sm:px-6">
      {allClear ? (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-8 text-center">
          <p className="text-4xl">✅</p>
          <p className="mt-3 text-lg font-semibold text-emerald-300">Todo tranquilo</p>
          <p className="mt-1 text-sm text-emerald-400/80">Sin alertas críticas, servidores caídos, ni backups fallidos.</p>
        </div>
      ) : (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-center">
          <p className="text-lg font-semibold text-red-300">
            ⚠ {criticalAlerts.length + offlineServers.length + failedBackups.length} cosa(s) requieren atención
          </p>
        </div>
      )}

      {offlineServers.length > 0 && (
        <div className="rounded-xl border border-red-500/30 bg-gray-900/50 p-4">
          <h2 className="mb-3 text-base font-semibold text-red-300">🔴 Servidores caídos</h2>
          <div className="space-y-2">
            {offlineServers.map((s) => (
              <div key={s.id} className="rounded-lg bg-gray-950/60 px-4 py-3 text-base text-gray-100">
                {s.name}
                {s.lastSeenAt && (
                  <span className="ml-2 text-sm text-gray-500">
                    (última vez: {new Date(s.lastSeenAt).toLocaleString('es-ES')})
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {failedBackups.length > 0 && (
        <div className="rounded-xl border border-red-500/30 bg-gray-900/50 p-4">
          <h2 className="mb-3 text-base font-semibold text-red-300">🗄️ Backups fallidos</h2>
          <div className="space-y-2">
            {failedBackups.map((s) => (
              <div key={s.id} className="rounded-lg bg-gray-950/60 px-4 py-3 text-base text-gray-100">
                {s.name} <span className="text-sm text-gray-500">({s.backup?.method})</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {criticalAlerts.length > 0 && (
        <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">
          <h2 className="mb-3 text-base font-semibold text-gray-200">🚨 Alertas críticas / altas abiertas</h2>
          <div className="space-y-3">
            {criticalAlerts.map((a) => (
              <div key={a.id} className="rounded-lg border border-gray-800 bg-gray-950/60 p-4">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="text-base font-medium text-gray-100">{a.serverName ?? '—'}</span>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-xs ${
                      a.severity === 'CRITICAL' ? 'border-red-500/40 bg-red-500/10 text-red-300' : 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                    }`}
                  >
                    {a.severity}
                  </span>
                </div>
                <p className="mb-2 text-sm text-gray-400">{a.description}</p>
                {a.aiTriage && <p className="mb-2 text-sm text-sky-300/90">🤖 {a.aiTriage}</p>}
                <div className="flex gap-2">
                  {a.status === 'OPEN' && (
                    <button
                      onClick={() => onUpdateStatus(a.id, 'ACKNOWLEDGED')}
                      className="rounded-lg border border-amber-500/30 px-3 py-1.5 text-sm text-amber-400 hover:bg-amber-500/10"
                    >
                      Reconocer
                    </button>
                  )}
                  <button
                    onClick={() => onUpdateStatus(a.id, 'RESOLVED')}
                    className="rounded-lg border border-emerald-500/30 px-3 py-1.5 text-sm text-emerald-400 hover:bg-emerald-500/10"
                  >
                    Resolver
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
