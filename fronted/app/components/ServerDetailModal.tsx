import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { AppWindow, Bot, DatabaseBackup, Server, Wrench } from 'lucide-react';
import { BACKUP_METHOD_LABELS, BACKUP_STYLES, HEALTH_STYLES, SEVERITY_STYLES } from '../lib/health';
import type { SecurityAlert, ServerSummary } from '../types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

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
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
      <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
      <div className="mt-1 text-lg font-semibold text-slate-900">{children}</div>
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
  const backup = server.backup;
  const backupStyle = BACKUP_STYLES[backup?.result ?? 'UNKNOWN'];

  const [eventLogAnalysis, setEventLogAnalysis] = useState<string | null>(null);
  const [eventLogErrorCount, setEventLogErrorCount] = useState<number | null>(null);
  const [analyzingEvents, setAnalyzingEvents] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  const handleAnalyzeEvents = async () => {
    setAnalyzingEvents(true);
    setAnalyzeError(null);
    try {
      const res = await fetch(`${API_URL}/api/servers/${server.id}/analyze-events`, {
        method: 'POST',
        credentials: 'include',
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'No se pudo analizar los logs');
      setEventLogAnalysis(body.analysis);
      setEventLogErrorCount(body.errorCount);
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setAnalyzingEvents(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.18 }}
        className="w-full max-w-2xl rounded-xl border border-slate-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-slate-200 p-6">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
              <Server className="h-6 w-6" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-slate-900">{server.name}</h2>
              <p className="text-xs text-slate-400">Inspección detallada en tiempo real</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100"
          >
            Cerrar
          </button>
        </div>

        {server.inMaintenance && (
          <div className="mx-6 mt-4 flex items-center gap-1.5 rounded-lg border border-sky-200 bg-sky-50 px-4 py-2 text-xs text-sky-700">
            <Wrench className="h-3.5 w-3.5 shrink-0" />
            En mantenimiento hasta {server.maintenanceUntil ? new Date(server.maintenanceUntil).toLocaleString('es-ES') : '—'} — las alertas están silenciadas.
          </div>
        )}

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

        <div className="border-t border-slate-200 p-6">
          <p className="mb-3 flex items-center gap-1.5 text-xs uppercase tracking-wide text-slate-400">
            <DatabaseBackup className="h-3.5 w-3.5" />
            Estado de Backup
          </p>

          {backup ? (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <DetailTile label="Resultado">
                  <span className={`inline-block rounded-full border px-2 py-0.5 text-sm ${backupStyle.badge}`}>
                    {backupStyle.label}
                  </span>
                </DetailTile>
                <DetailTile label="Método detectado">
                  <span className="text-base">{BACKUP_METHOD_LABELS[backup.method] ?? backup.method}</span>
                </DetailTile>
                <DetailTile label="Último backup">{relativeTime(backup.lastBackupAt)}</DetailTile>
                <DetailTile label="Servicio VSS">
                  <span className="flex items-center gap-2">
                    <span className={`h-2.5 w-2.5 rounded-full ${backup.vssServiceOk ? 'bg-emerald-500' : 'bg-red-500'}`} />
                    {backup.vssServiceOk ? 'En ejecución' : 'Detenido'}
                  </span>
                </DetailTile>
              </div>

              {backup.detail && (
                <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
                  <p className="mb-2 text-xs uppercase tracking-wide text-slate-400">Detalle</p>
                  <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap font-mono text-xs text-slate-600">
                    {backup.detail}
                  </pre>
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-slate-400">Este servidor todavía no reportó estado de backup.</p>
          )}
        </div>

        <div className="border-t border-slate-200 p-6">
          <div className="mb-3 flex items-center justify-between">
            <p className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-slate-400">
              <AppWindow className="h-3.5 w-3.5" />
              Visor de Eventos de Windows
            </p>
            <button
              onClick={handleAnalyzeEvents}
              disabled={analyzingEvents}
              className="flex items-center gap-1.5 rounded-lg border border-sky-200 px-2 py-1 text-[11px] text-sky-700 transition-colors hover:bg-sky-50 disabled:opacity-50"
            >
              {analyzingEvents ? (
                'Analizando...'
              ) : (
                <>
                  <Bot className="h-3 w-3" />
                  Analizar con IA
                </>
              )}
            </button>
          </div>
          {analyzeError && <p className="text-xs text-red-700">{analyzeError}</p>}
          {eventLogAnalysis && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              {eventLogErrorCount !== null && (
                <p className="mb-2 text-[11px] text-slate-400">{eventLogErrorCount} error(es) recientes analizados</p>
              )}
              <p className="whitespace-pre-wrap text-xs text-slate-600">{eventLogAnalysis}</p>
            </div>
          )}
          {!eventLogAnalysis && !analyzeError && (
            <p className="text-xs text-slate-400">
              Analiza los errores recientes del Visor de Eventos (System/Application) que manda el agente, buscando
              patrones que merezcan atención.
            </p>
          )}
        </div>

        <div className="border-t border-slate-200 p-6">
          <p className="mb-3 text-xs uppercase tracking-wide text-slate-400">Alertas recientes de este servidor</p>
          {alerts.length === 0 ? (
            <p className="text-sm text-slate-400">Sin alertas registradas.</p>
          ) : (
            <ul className="max-h-40 space-y-2 overflow-y-auto">
              {alerts.map((a) => (
                <li key={a.id} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-xs">
                  <span className="text-slate-600">{a.description}</span>
                  <span className={`ml-3 shrink-0 rounded-full border px-2 py-0.5 ${SEVERITY_STYLES[a.severity]}`}>
                    {a.severity}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </motion.div>
    </div>
  );
}
