import { motion } from 'framer-motion';
import { AlertTriangle, Bot, CheckCircle2, DatabaseBackup, ServerCrash, Siren } from 'lucide-react';
import type { SecurityAlert, ServerSummary } from '../../types';
import AlertOpsActions from '../ops/AlertOpsActions';
import FailedLogonDetail from '../FailedLogonDetail';
import AlertRepeatInfo from '../AlertRepeatInfo';
import { AlertRecommendation } from '../AlertActionsExtra';

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
    <div className="space-y-4 px-4 py-6 sm:px-6">
      {allClear ? (
        <motion.div
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          className="rounded-xl border border-emerald-200 bg-emerald-50 p-8 text-center"
        >
          <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-500" />
          <p className="mt-3 text-lg font-semibold text-emerald-700">Todo tranquilo</p>
          <p className="mt-1 text-sm text-emerald-700/80">Sin alertas críticas, servidores caídos, ni backups fallidos.</p>
        </motion.div>
      ) : (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-red-200 bg-red-50 p-4 text-center">
          <AlertTriangle className="h-5 w-5 shrink-0 text-red-600" />
          <p className="text-lg font-semibold text-red-700">
            {criticalAlerts.length + offlineServers.length + failedBackups.length} cosa(s) requieren atención
          </p>
        </div>
      )}

      {offlineServers.length > 0 && (
        <div className="rounded-xl border border-red-200 bg-white p-4">
          <h2 className="mb-3 flex items-center gap-1.5 text-base font-semibold text-red-700">
            <ServerCrash className="h-4 w-4" />
            Servidores caídos
          </h2>
          <div className="space-y-2">
            {offlineServers.map((s) => (
              <div key={s.id} className="rounded-lg bg-slate-50 px-4 py-3 text-base text-slate-900">
                {s.name}
                {s.lastSeenAt && (
                  <span className="ml-2 text-sm text-slate-400">
                    (última vez: {new Date(s.lastSeenAt).toLocaleString('es-ES')})
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {failedBackups.length > 0 && (
        <div className="rounded-xl border border-red-200 bg-white p-4">
          <h2 className="mb-3 flex items-center gap-1.5 text-base font-semibold text-red-700">
            <DatabaseBackup className="h-4 w-4" />
            Backups fallidos
          </h2>
          <div className="space-y-2">
            {failedBackups.map((s) => (
              <div key={s.id} className="rounded-lg bg-slate-50 px-4 py-3 text-base text-slate-900">
                {s.name} <span className="text-sm text-slate-400">({s.backup?.method})</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {criticalAlerts.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
          <h2 className="mb-3 flex items-center gap-1.5 text-base font-semibold text-slate-800">
            <Siren className="h-4 w-4 text-red-500" />
            Alertas críticas / altas abiertas
          </h2>
          <div className="space-y-3">
            {criticalAlerts.map((a) => (
              <div key={a.id} className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="text-base font-medium text-slate-900">{a.serverName ?? '—'}</span>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-xs ${
                      a.severity === 'CRITICAL' ? 'border-red-200 bg-red-50 text-red-700' : 'border-amber-200 bg-amber-50 text-amber-700'
                    }`}
                  >
                    {a.severity}
                  </span>
                </div>
                <p className="mb-2 text-sm text-slate-500">{a.description}</p>
                <AlertRepeatInfo alert={a} className="mb-2" />
                {a.details && <FailedLogonDetail detail={a.details} />}
                <div className="mb-2">
                  <AlertRecommendation alert={a} defaultOpen />
                  <AlertOpsActions alert={a} />
                </div>
                {a.aiTriage && (
                  <p className="mb-2 flex items-start gap-1.5 text-sm text-sky-700/90">
                    <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {a.aiTriage}
                  </p>
                )}
                <div className="flex gap-2">
                  {a.status === 'OPEN' && (
                    <button
                      onClick={() => onUpdateStatus(a.id, 'ACKNOWLEDGED')}
                      className="rounded-lg border border-amber-200 px-3 py-1.5 text-sm text-amber-700 hover:bg-amber-50"
                    >
                      Reconocer
                    </button>
                  )}
                  <button
                    onClick={() => onUpdateStatus(a.id, 'RESOLVED')}
                    className="rounded-lg border border-emerald-200 px-3 py-1.5 text-sm text-emerald-700 hover:bg-emerald-50"
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
