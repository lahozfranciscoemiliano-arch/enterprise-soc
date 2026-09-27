'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Activity,
  AlertTriangle,
  AppWindow,
  Bot,
  CheckCircle2,
  Clock,
  Cog,
  DatabaseBackup,
  Download,
  Gauge,
  Globe,
  HardDrive,
  type LucideIcon,
  Power,
  RotateCw,
  Router,
  Server,
  ShieldAlert,
  ShieldCheck,
  TrendingUp,
  Wifi,
  Wrench,
  X,
} from 'lucide-react';
import MetricsPanel from './MetricsPanel';
import AlertRepeatInfo from './AlertRepeatInfo';
import {
  BACKUP_METHOD_LABELS,
  BACKUP_STYLES,
  formatBytes,
  formatDuration,
  formatUptime,
  HEALTH_STYLES,
  internetLevel,
  ISP_LABEL,
  RESOURCE_LEVEL_COLOR,
  resourceLevel,
  SEVERITY_STYLES,
  timeAgo,
} from '../lib/health';
import type { SecurityAlert, ServerDetails, ServerSummary } from '../types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

type Section = 'metricas' | 'salud' | 'red' | 'backup' | 'eventos';

const SECTIONS: { id: Section; label: string; icon: LucideIcon }[] = [
  { id: 'metricas', label: 'Métricas en vivo', icon: Activity },
  { id: 'salud', label: 'Salud preventiva', icon: ShieldCheck },
  { id: 'red', label: 'Red e internet', icon: Globe },
  { id: 'backup', label: 'Backup', icon: DatabaseBackup },
  { id: 'eventos', label: 'Alertas y eventos', icon: AlertTriangle },
];

const SEVERITY_PENALTY: Record<string, number> = { CRITICAL: 25, HIGH: 15, MEDIUM: 8, LOW: 3 };

function Card({ title, icon: Icon, children, className = '' }: { title: string; icon: LucideIcon; children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-slate-200 bg-white p-4 ${className}`}>
      <p className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        <Icon className="h-3.5 w-3.5" />
        {title}
      </p>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-slate-100 py-1.5 text-xs last:border-0">
      <span className="text-slate-500">{label}</span>
      <span className="text-right font-medium text-slate-800">{children}</span>
    </div>
  );
}

function Pill({ ok, children }: { ok: boolean | null; children: React.ReactNode }) {
  const cls =
    ok === null
      ? 'border-slate-200 bg-slate-50 text-slate-500'
      : ok
        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
        : 'border-red-200 bg-red-50 text-red-700';
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls}`}>{children}</span>;
}

function ScoreRing({ score }: { score: number }) {
  const radius = 34;
  const circumference = 2 * Math.PI * radius;
  const color = score >= 85 ? '#10b981' : score >= 60 ? '#f59e0b' : '#ef4444';
  return (
    <div className="relative h-24 w-24 shrink-0">
      <svg viewBox="0 0 80 80" className="h-full w-full -rotate-90">
        <circle cx="40" cy="40" r={radius} stroke="#e2e8f0" strokeWidth="7" fill="none" />
        <motion.circle
          cx="40"
          cy="40"
          r={radius}
          stroke={color}
          strokeWidth="7"
          fill="none"
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: circumference * (1 - score / 100) }}
          transition={{ duration: 0.9, ease: 'easeOut' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-bold tabular-nums text-slate-900">{score}</span>
        <span className="text-[9px] uppercase tracking-wide text-slate-400">de 100</span>
      </div>
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
  const [section, setSection] = useState<Section>('metricas');
  const [details, setDetails] = useState<ServerDetails | null>(null);
  const [detailsError, setDetailsError] = useState<string | null>(null);

  const [eventLogAnalysis, setEventLogAnalysis] = useState<string | null>(null);
  const [eventLogErrorCount, setEventLogErrorCount] = useState<number | null>(null);
  const [analyzingEvents, setAnalyzingEvents] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    // El fondo no scrollea mientras el modal esta abierto.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  const loadDetails = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/servers/${server.id}/details`, { credentials: 'include' });
      if (!res.ok) throw new Error('No se pudo cargar el detalle del servidor');
      setDetails(await res.json());
      setDetailsError(null);
    } catch (err) {
      setDetailsError(err instanceof Error ? err.message : 'Error desconocido');
    }
  }, [server.id]);

  useEffect(() => {
    loadDetails();
    const t = setInterval(() => !document.hidden && loadDetails(), 60_000);
    return () => clearInterval(t);
  }, [loadDetails]);

  const handleAnalyzeEvents = async () => {
    setAnalyzingEvents(true);
    setAnalyzeError(null);
    try {
      const res = await fetch(`${API_URL}/api/servers/${server.id}/analyze-events`, { method: 'POST', credentials: 'include' });
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

  const health = HEALTH_STYLES[server.healthStatus];
  const isOnline = server.status === 'ONLINE';
  const backup = server.backup;
  const backupStyle = BACKUP_STYLES[backup?.result ?? 'UNKNOWN'];
  const diag = details?.diagnostics ?? null;
  const net = server.network ?? details?.network ?? null;
  const activeAlerts = details?.activeAlerts ?? alerts.filter((a) => a.status !== 'RESOLVED');

  const score = useMemo(() => {
    const penalty = activeAlerts.reduce((sum, a) => sum + (SEVERITY_PENALTY[a.severity] ?? 0), 0);
    return Math.max(0, 100 - penalty);
  }, [activeAlerts]);

  const patchAgeDays = diag?.updates?.lastInstalledAt
    ? Math.floor((Date.now() - new Date(diag.updates.lastInstalledAt).getTime()) / 86400000)
    : null;
  const signals = diag?.eventSignals ?? {};
  const forecast = details?.diskForecast ?? null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-2 backdrop-blur-sm animate-fade-in sm:p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.97, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        role="dialog"
        aria-modal="true"
        aria-label={`Detalle de ${server.name}`}
        // Nunca mas alto/ancho que la ventana: el encabezado queda fijo y el
        // contenido scrollea por dentro.
        className="flex h-[calc(100dvh-1rem)] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 shadow-2xl sm:h-[min(calc(100dvh-2rem),960px)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 border-b border-slate-200 bg-white">
          <div className="flex items-start justify-between gap-3 px-5 py-4">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
                <Server className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h2 className="truncate text-lg font-semibold text-slate-900">{server.name}</h2>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className="flex items-center gap-1 text-slate-500">
                    <span className={`h-2 w-2 rounded-full ${isOnline ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
                    {isOnline ? 'En línea' : 'Sin conexión'}
                  </span>
                  <span className={`rounded-full border px-2 py-0.5 ${health.badge}`}>{health.label}</span>
                  {details?.ipAddress && <span className="font-mono text-slate-400">{details.ipAddress}</span>}
                  {server.agentVersion && <span className="text-slate-400">· agente v{server.agentVersion}</span>}
                  {diag?.uptimeSeconds !== undefined && <span className="text-slate-400">· encendido hace {formatUptime(diag.uptimeSeconds)}</span>}
                </div>
              </div>
            </div>
            <button
              onClick={onClose}
              className="shrink-0 rounded-lg border border-slate-200 p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800"
              aria-label="Cerrar"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex gap-1 overflow-x-auto px-3">
            {SECTIONS.filter((s) => s.id !== 'backup' || server.backupMode !== 'EXCLUDED').map((s) => {
              const Icon = s.icon;
              const active = section === s.id;
              const badge = s.id === 'eventos' && activeAlerts.length > 0 ? activeAlerts.length : null;
              return (
                <button
                  key={s.id}
                  onClick={() => setSection(s.id)}
                  className={`relative flex shrink-0 items-center gap-1.5 px-3 py-2.5 text-xs font-medium transition-colors ${
                    active ? 'text-brand-700' : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {s.label}
                  {badge !== null && (
                    <span className="rounded-full bg-red-100 px-1.5 text-[10px] font-semibold text-red-700">{badge}</span>
                  )}
                  {active && <motion.span layoutId="detail-tab" className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-brand-600" />}
                </button>
              );
            })}
          </div>
        </div>

        {server.inMaintenance && (
          <div className="mx-5 mt-3 flex shrink-0 items-center gap-1.5 rounded-lg border border-sky-200 bg-sky-50 px-4 py-2 text-xs text-sky-700">
            <Wrench className="h-3.5 w-3.5 shrink-0" />
            En mantenimiento hasta {server.maintenanceUntil ? new Date(server.maintenanceUntil).toLocaleString('es-ES') : '—'} — las alertas están silenciadas.
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-5">
          <AnimatePresence mode="wait">
            <motion.div key={section} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
              {section === 'metricas' && <MetricsPanel server={server} chartHeight={230} />}

              {section === 'salud' && (
                <div className="space-y-3">
                  {detailsError && <p className="text-xs text-red-600">{detailsError}</p>}
                  <div className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center">
                    <ScoreRing score={score} />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-900">Índice de salud preventiva</p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {activeAlerts.length === 0
                          ? 'Sin condiciones de riesgo activas. El agente revisa discos, servicios, parches, antivirus y el Visor de Eventos cada 5 minutos.'
                          : `${activeAlerts.length} condición(es) activa(s) restan puntos. Resolverlas antes de que escalen a una caída.`}
                      </p>
                      {details?.diagnosticsAt && (
                        <p className="mt-1 text-[11px] text-slate-400">Último diagnóstico {timeAgo(details.diagnosticsAt)}</p>
                      )}
                    </div>
                  </div>

                  {!diag ? (
                    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800">
                      Este servidor todavía no mandó el diagnóstico extendido. Se activa solo cuando el agente se actualiza a la
                      versión 1.3.0 (automático en el próximo ciclo una vez publicada) — hasta entonces se ven solo CPU/RAM/disco.
                    </div>
                  ) : (
                    <div className="grid gap-3 lg:grid-cols-2">
                      <Card title="Almacenamiento" icon={HardDrive}>
                        <div className="space-y-2.5">
                          {(diag.volumes ?? []).map((v) => {
                            const level = RESOURCE_LEVEL_COLOR[resourceLevel(v.percent, 'diskUsage')];
                            return (
                              <div key={v.mount}>
                                <div className="mb-1 flex items-center justify-between text-xs">
                                  <span className="font-medium text-slate-700">
                                    {v.mount} <span className="font-normal text-slate-400">{v.fs}</span>
                                  </span>
                                  <span className={`font-semibold tabular-nums ${level.text}`}>
                                    {v.percent.toFixed(1)}%{' '}
                                    <span className="font-normal text-slate-400">· {formatBytes(v.freeBytes ?? null)} libres</span>
                                  </span>
                                </div>
                                <div className={`h-2 overflow-hidden rounded-full ${level.track}`}>
                                  <motion.div
                                    className={`h-full rounded-full ${level.bar}`}
                                    initial={{ width: 0 }}
                                    animate={{ width: `${v.percent}%` }}
                                    transition={{ duration: 0.8, ease: 'easeOut' }}
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        {forecast && (
                          <div className="mt-3 flex items-start gap-2 rounded-lg bg-slate-50 p-2.5 text-[11px] text-slate-600">
                            <TrendingUp className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
                            {forecast.status === 'growing' ? (
                              <span>
                                C: crece <b>{forecast.growthPerDay.toFixed(2)}%/día</b>: llega al 95% en ~<b>{forecast.daysTo95} días</b> y se llena en ~
                                {forecast.daysToFull} ({new Date(forecast.fullAt).toLocaleDateString('es-ES')}).
                              </span>
                            ) : forecast.status === 'stable' ? (
                              <span>Uso de C: estable en los últimos 14 días (sin tendencia de llenado).</span>
                            ) : (
                              <span>Pronóstico de llenado disponible con al menos 4 días de historia.</span>
                            )}
                          </div>
                        )}
                        {(diag.physicalDisks ?? []).length > 0 && (
                          <div className="mt-3 space-y-1">
                            {(diag.physicalDisks ?? []).map((d, i) => (
                              <div key={`${d.name}-${i}`} className="flex items-center justify-between text-xs">
                                <span className="truncate text-slate-600">
                                  {d.name} <span className="text-slate-400">({d.mediaType ?? '—'}, {formatBytes(d.sizeBytes ?? null)})</span>
                                </span>
                                <Pill ok={d.health === 'Unknown' ? null : d.health === 'Healthy' && !d.predictFailure}>
                                  {d.predictFailure ? 'SMART: falla prevista' : d.health === 'Healthy' ? 'Saludable' : d.health === 'Unknown' ? 'Sin dato' : d.health}
                                </Pill>
                              </div>
                            ))}
                          </div>
                        )}
                      </Card>

                      <Card title="Señales tempranas (últimas 24 h)" icon={Gauge}>
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                          {[
                            { key: 'diskBadBlocks', label: 'Sectores defectuosos', warn: 3 },
                            { key: 'diskErrors', label: 'Reintentos de E/S (info)', warn: 500 },
                            { key: 'unexpectedShutdowns', label: 'Apagados inesperados', warn: 1 },
                            { key: 'bugchecks', label: 'Pantallazos azules', warn: 1 },
                            { key: 'lowMemory', label: 'Memoria agotada', warn: 1 },
                            { key: 'failedLogons', label: 'Logins fallidos', warn: 50 },
                            { key: 'malwareDetections', label: 'Malware', warn: 1 },
                          ].map((s) => {
                            const value = signals[s.key as keyof typeof signals];
                            const bad = typeof value === 'number' && value >= s.warn;
                            return (
                              <div
                                key={s.key}
                                className={`rounded-lg border p-2.5 ${bad ? 'border-red-200 bg-red-50' : 'border-slate-200 bg-slate-50'}`}
                              >
                                <p className={`text-lg font-semibold tabular-nums ${bad ? 'text-red-700' : 'text-slate-800'}`}>{value ?? '—'}</p>
                                <p className="text-[10px] leading-tight text-slate-500">{s.label}</p>
                              </div>
                            );
                          })}
                        </div>
                      </Card>

                      <Card title="Actualizaciones y reinicios" icon={Download}>
                        <Row label="Última actualización instalada">
                          {diag.updates?.lastInstalledAt ? (
                            <span className={patchAgeDays !== null && patchAgeDays > 45 ? 'text-amber-700' : ''}>
                              hace {patchAgeDays} días
                            </span>
                          ) : (
                            '—'
                          )}
                        </Row>
                        <Row label="Pendientes (críticas/importantes)">
                          {diag.updates?.pending === null || diag.updates?.pending === undefined
                            ? 'consultando…'
                            : `${diag.updates.pending} (${diag.updates.pendingCritical ?? 0})`}
                        </Row>
                        <Row label="Reinicio pendiente">
                          <Pill ok={!diag.rebootPending}>{diag.rebootPending ? 'Sí' : 'No'}</Pill>
                        </Row>
                        <Row label="Último arranque">
                          {diag.lastBootAt ? new Date(diag.lastBootAt).toLocaleString('es-ES') : '—'}
                        </Row>
                        <Row label="Archivo de paginación">{diag.pagefilePercent !== undefined ? `${diag.pagefilePercent}%` : '—'}</Row>
                      </Card>

                      <Card title="Seguridad del equipo" icon={ShieldAlert}>
                        {diag.defender ? (
                          <>
                            <Row label="Antivirus (Defender)">
                              <Pill ok={diag.defender.antivirusEnabled}>{diag.defender.antivirusEnabled ? 'Activo' : 'Deshabilitado'}</Pill>
                            </Row>
                            <Row label="Protección en tiempo real">
                              <Pill ok={diag.defender.realTimeEnabled}>{diag.defender.realTimeEnabled ? 'Activa' : 'Apagada'}</Pill>
                            </Row>
                            <Row label="Antigüedad de firmas">
                              <span className={(diag.defender.signatureAgeDays ?? 0) > 7 ? 'text-red-700' : ''}>
                                {diag.defender.signatureAgeDays ?? '—'} día(s)
                              </span>
                            </Row>
                            <Row label="Último análisis rápido">{diag.defender.quickScanAgeDays ?? '—'} día(s)</Row>
                          </>
                        ) : (
                          <p className="text-xs text-slate-400">Microsoft Defender no está presente (otro antivirus o sin datos).</p>
                        )}
                      </Card>

                      <Card title="Servicios automáticos detenidos" icon={Cog}>
                        {(diag.stoppedServices ?? []).length === 0 ? (
                          <p className="flex items-center gap-1.5 text-xs text-emerald-700">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Todos los servicios de inicio automático están corriendo.
                          </p>
                        ) : (
                          <ul className="max-h-48 space-y-1 overflow-y-auto">
                            {(diag.stoppedServices ?? []).map((svc) => (
                              <li key={svc.name} className="flex items-center justify-between gap-2 rounded-md bg-slate-50 px-2 py-1 text-xs">
                                <span className="truncate text-slate-700">{svc.displayName}</span>
                                <span className="shrink-0 font-mono text-[10px] text-slate-400">{svc.name}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </Card>

                      <Card title="Procesos que más consumen" icon={Activity}>
                        <div className="grid grid-cols-2 gap-3 text-xs">
                          <div>
                            <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-400">CPU</p>
                            {(diag.topProcesses?.byCpu ?? []).map((p, i) => (
                              <div key={`${p.name}-${i}`} className="flex justify-between gap-2 py-0.5">
                                <span className="truncate text-slate-700">{p.name}</span>
                                <span className="tabular-nums text-slate-500">{p.cpu.toFixed(1)}%</span>
                              </div>
                            ))}
                          </div>
                          <div>
                            <p className="mb-1 text-[10px] uppercase tracking-wide text-slate-400">Memoria</p>
                            {(diag.topProcesses?.byMemory ?? []).map((p, i) => (
                              <div key={`${p.name}-${i}`} className="flex justify-between gap-2 py-0.5">
                                <span className="truncate text-slate-700">{p.name}</span>
                                <span className="tabular-nums text-slate-500">{formatBytes(p.memBytes)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </Card>
                    </div>
                  )}
                </div>
              )}

              {section === 'red' && (
                <div className="space-y-3">
                  {!net ? (
                    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800">
                      Sin mediciones de red todavía: el agente mide internet desde el sitio a partir de la versión 1.3.0.
                    </div>
                  ) : (
                    <div className="grid gap-3 lg:grid-cols-2">
                      <Card title="Salida a internet" icon={Globe}>
                        {(() => {
                          const level = internetLevel(net);
                          const color = level === 'none' ? null : RESOURCE_LEVEL_COLOR[level];
                          return (
                            <div className="mb-3 flex items-center gap-3">
                              <div className={`flex h-12 w-12 items-center justify-center rounded-xl ${color?.track ?? 'bg-slate-100'}`}>
                                <Wifi className={`h-6 w-6 ${color?.text ?? 'text-slate-400'}`} />
                              </div>
                              <div>
                                <p className={`text-lg font-semibold ${color?.text ?? 'text-slate-500'}`}>
                                  {net.internetUp === false ? 'SIN INTERNET' : level === 'warning' ? 'Degradado' : 'Operativo'}
                                </p>
                                <p className="text-[11px] text-slate-400">Medido desde el propio sitio {timeAgo(net.at)}</p>
                              </div>
                            </div>
                          );
                        })()}
                        <Row label="Latencia (1.1.1.1 / 8.8.8.8)">{net.latencyMs !== null ? `${net.latencyMs} ms` : '—'}</Row>
                        <Row label="Pérdida de paquetes">{net.lossPct !== null ? `${net.lossPct}%` : '—'}</Row>
                        <Row label="Resolución DNS">
                          <Pill ok={net.dnsOk}>{net.dnsOk === null ? 'Sin dato' : net.dnsOk ? `OK · ${net.dnsMs} ms` : 'Falla'}</Pill>
                        </Row>
                        <Row label="Gateway / firewall">
                          {net.gateway ? (
                            <span className="font-mono">
                              {net.gateway} · {net.gatewayLatencyMs !== null ? `${net.gatewayLatencyMs} ms` : 'no responde ping'}
                            </span>
                          ) : (
                            '—'
                          )}
                        </Row>
                      </Card>

                      <Card title="Enlaces del sitio (ISP)" icon={Router}>
                        <div className="mb-3 flex flex-wrap items-center gap-2">
                          <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${ISP_LABEL[net.activeIsp].badge}`}>
                            {ISP_LABEL[net.activeIsp].label}
                          </span>
                          {net.publicIp && <span className="font-mono text-xs text-slate-500">IP pública {net.publicIp}</span>}
                        </div>
                        <Row label="Principal">
                          {details?.isp.primaryName ?? server.ispPrimaryName ?? '—'}
                          {details?.isp.primaryPublicIp && <span className="ml-1 font-mono text-slate-400">({details.isp.primaryPublicIp})</span>}
                        </Row>
                        <Row label="Secundario">
                          {details?.isp.secondaryName ?? server.ispSecondaryName ?? '—'}
                          {details?.isp.secondaryPublicIp && <span className="ml-1 font-mono text-slate-400">({details.isp.secondaryPublicIp})</span>}
                        </Row>
                        {net.activeIsp === 'unknown' && (
                          <p className="mt-2 text-[11px] text-slate-400">
                            Cargá la IP pública de cada enlace en Admin → Servidores → Configurar para detectar automáticamente cuándo el
                            sitio pasa al enlace de respaldo.
                          </p>
                        )}
                      </Card>

                      {net.nics.length > 0 && (
                        <Card title="Placas de red" icon={Power} className="lg:col-span-2">
                          <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="text-left text-slate-400">
                                  <th className="py-1 pr-3 font-medium">Interfaz</th>
                                  <th className="py-1 pr-3 font-medium">Velocidad</th>
                                  <th className="py-1 pr-3 font-medium">Errores (último min)</th>
                                  <th className="py-1 font-medium">Descartes</th>
                                </tr>
                              </thead>
                              <tbody>
                                {net.nics.map((n) => (
                                  <tr key={n.name} className="border-t border-slate-100">
                                    <td className="py-1.5 pr-3 text-slate-700">{n.name}</td>
                                    <td className="py-1.5 pr-3 text-slate-600">{n.speedMbps ? `${n.speedMbps} Mbps` : '—'}</td>
                                    <td className={`py-1.5 pr-3 ${n.errors ? 'font-semibold text-red-700' : 'text-slate-600'}`}>{n.errors ?? '—'}</td>
                                    <td className={`py-1.5 ${n.drops ? 'font-semibold text-amber-700' : 'text-slate-600'}`}>{n.drops ?? '—'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </Card>
                      )}
                    </div>
                  )}
                </div>
              )}

              {section === 'backup' && (
                <div className="space-y-3">
                  {backup ? (
                    <>
                      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                        {[
                          { label: 'Resultado', value: <span className={`inline-block rounded-full border px-2 py-0.5 text-sm ${backupStyle.badge}`}>{backupStyle.label}</span> },
                          { label: 'Último backup', value: timeAgo(backup.lastBackupAt) },
                          { label: 'Duración', value: formatDuration(backup.durationSeconds) },
                          { label: 'Tamaño', value: formatBytes(backup.sizeBytes) },
                        ].map((t) => (
                          <div key={t.label} className="rounded-xl border border-slate-200 bg-white p-4">
                            <p className="text-[11px] uppercase tracking-wide text-slate-400">{t.label}</p>
                            <div className="mt-1 text-lg font-semibold text-slate-900">{t.value}</div>
                          </div>
                        ))}
                      </div>
                      <Card title="Detalle" icon={DatabaseBackup}>
                        <Row label="Método">{BACKUP_METHOD_LABELS[backup.method] ?? backup.method}</Row>
                        <Row label="Destino">
                          <span className="break-all font-mono">{backup.targetPath ?? '—'}</span>
                        </Row>
                        <Row label="Copias restaurables">{backup.successfulRuns ?? '—'}</Row>
                        <Row label="Servicio VSS">
                          <Pill ok={backup.vssServiceOk}>{backup.vssServiceOk ? 'En ejecución' : 'Detenido'}</Pill>
                        </Row>
                        <Row label="Último chequeo">{timeAgo(backup.recordedAt)}</Row>
                        {backup.detail && (
                          <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 font-mono text-[11px] text-slate-600">
                            {backup.detail}
                          </pre>
                        )}
                        <p className="mt-2 text-[11px] text-slate-400">El historial completo de corridas está en la pestaña Backups.</p>
                      </Card>
                    </>
                  ) : (
                    <p className="text-sm text-slate-400">Este servidor todavía no reportó estado de backup.</p>
                  )}
                </div>
              )}

              {section === 'eventos' && (
                <div className="space-y-3">
                  <Card title={`Alertas activas (${activeAlerts.length})`} icon={AlertTriangle}>
                    {activeAlerts.length === 0 ? (
                      <p className="flex items-center gap-1.5 text-xs text-emerald-700">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        Sin alertas activas.
                      </p>
                    ) : (
                      <ul className="space-y-2">
                        {activeAlerts.map((a) => (
                          <li key={a.id} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
                            <div className="flex items-start justify-between gap-3">
                              <span className="text-slate-700">{a.description}</span>
                              <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${SEVERITY_STYLES[a.severity]}`}>{a.severity}</span>
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-slate-400">
                              <span className="flex items-center gap-1">
                                <Clock className="h-3 w-3" />
                                desde {new Date(a.createdAt).toLocaleString('es-ES')}
                              </span>
                              <AlertRepeatInfo alert={a} />
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Card>

                  <Card title="Visor de eventos de Windows" icon={AppWindow}>
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <p className="text-xs text-slate-500">
                        Analiza con IA los errores recientes (System/Application) que manda el agente, buscando patrones que merezcan atención.
                      </p>
                      <button
                        onClick={handleAnalyzeEvents}
                        disabled={analyzingEvents}
                        className="flex shrink-0 items-center gap-1.5 rounded-lg border border-sky-200 px-2.5 py-1.5 text-[11px] text-sky-700 transition-colors hover:bg-sky-50 disabled:opacity-50"
                      >
                        {analyzingEvents ? <RotateCw className="h-3 w-3 animate-spin" /> : <Bot className="h-3 w-3" />}
                        {analyzingEvents ? 'Analizando...' : 'Analizar con IA'}
                      </button>
                    </div>
                    {analyzeError && <p className="text-xs text-red-700">{analyzeError}</p>}
                    {eventLogAnalysis && (
                      <div className="rounded-lg bg-slate-50 p-3">
                        {eventLogErrorCount !== null && (
                          <p className="mb-2 text-[11px] text-slate-400">{eventLogErrorCount} error(es) recientes analizados</p>
                        )}
                        <p className="whitespace-pre-wrap text-xs text-slate-600">{eventLogAnalysis}</p>
                      </div>
                    )}
                  </Card>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}
