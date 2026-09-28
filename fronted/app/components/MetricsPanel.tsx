'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { animate, AnimatePresence, motion } from 'framer-motion';
import {
  Area,
  AreaChart,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Activity, ArrowDownToLine, ArrowUpFromLine, Cpu, Globe, HardDrive, MemoryStick, Network } from 'lucide-react';
import { formatRate, internetLevel, RESOURCE_LEVEL_COLOR, RESOURCE_THRESHOLDS, resourceLevel } from '../lib/health';
import { onTelemetry } from '../lib/liveBus';
import type { MetricPoint, MetricRange, PerfDetail, ServerSummary } from '../types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

const RANGES: { id: MetricRange; label: string }[] = [
  { id: '1h', label: '1 h' },
  { id: '6h', label: '6 h' },
  { id: '24h', label: '24 h' },
  { id: '7d', label: '7 d' },
  { id: '30d', label: '30 d' },
];
const LIVE_MAX_POINTS = 90;

const COLORS = { cpu: '#c2632d', mem: '#3b82f6', disk: '#64748b', netIn: '#0ea5e9', netOut: '#8b5cf6', latency: '#0d9488', loss: '#ef4444' };

const TOOLTIP_STYLE = {
  background: 'rgba(255,255,255,0.97)',
  border: '1px solid #e2e8f0',
  borderRadius: 10,
  fontSize: 12,
  boxShadow: '0 8px 24px -6px rgb(15 23 42 / 0.15)',
};

function formatTick(iso: string, range: MetricRange) {
  const d = new Date(iso);
  if (range === '7d' || range === '30d') {
    return d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('es-ES', { hour: '2-digit' }) + 'h';
  }
  return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}

function AnimatedNumber({ value, decimals = 0, suffix = '' }: { value: number | null; decimals?: number; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef<number | null>(value);

  useEffect(() => {
    if (value === null || !ref.current) return;
    const from = prev.current ?? value;
    prev.current = value;
    const controls = animate(from, value, {
      duration: 0.7,
      ease: 'easeOut',
      onUpdate: (v) => {
        if (ref.current) ref.current.textContent = `${v.toFixed(decimals)}${suffix}`;
      },
    });
    return () => controls.stop();
  }, [value, decimals, suffix]);

  return <span ref={ref}>{value === null ? '—' : `${value.toFixed(decimals)}${suffix}`}</span>;
}

function stats(points: MetricPoint[], key: keyof MetricPoint) {
  const values = points.map((p) => p[key]).filter((v): v is number => typeof v === 'number');
  if (values.length === 0) return null;
  return { avg: values.reduce((a, b) => a + b, 0) / values.length, max: Math.max(...values) };
}

function KpiTile({
  icon,
  label,
  level,
  children,
  percent,
  sub,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  level: 'ok' | 'warning' | 'critical' | 'none';
  children: React.ReactNode;
  percent?: number | null;
  sub?: React.ReactNode;
  hint?: string;
}) {
  const color = level === 'none' ? null : RESOURCE_LEVEL_COLOR[level];
  return (
    <motion.div layout title={hint} className="relative overflow-hidden rounded-xl border border-slate-200 bg-white p-3">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400">
          {icon}
          {label}
        </span>
        {color && <span className={`h-2 w-2 rounded-full ${color.bar} ${level === 'critical' ? 'animate-pulse' : ''}`} />}
      </div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${color ? color.text : 'text-slate-400'}`}>{children}</div>
      {percent !== undefined && percent !== null && (
        <div className={`mt-2 h-1.5 overflow-hidden rounded-full ${color?.track ?? 'bg-slate-100'}`}>
          <motion.div
            className={`h-full rounded-full ${color?.bar ?? 'bg-slate-300'}`}
            initial={false}
            animate={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
            transition={{ duration: 0.7, ease: 'easeOut' }}
          />
        </div>
      )}
      {sub && <p className="mt-1.5 truncate text-[10px] text-slate-400">{sub}</p>}
    </motion.div>
  );
}

function ChartCard({ title, icon, children, right }: { title: string; icon: React.ReactNode; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
          {icon}
          {title}
        </p>
        {right}
      </div>
      {children}
    </div>
  );
}

export default function MetricsPanel({ server, chartHeight = 220 }: { server: ServerSummary; chartHeight?: number }) {
  const [range, setRange] = useState<MetricRange>('1h');
  const [points, setPoints] = useState<MetricPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<MetricPoint | null>(null);
  const [livePerf, setLivePerf] = useState<PerfDetail | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const res = await fetch(`${API_URL}/api/servers/${server.id}/metrics?range=${range}`, { credentials: 'include' });
        if (!res.ok) throw new Error('No se pudieron cargar las métricas');
        const body: { points: MetricPoint[] } = await res.json();
        setPoints(body.points);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error desconocido');
      } finally {
        setLoading(false);
      }
    },
    [server.id, range]
  );

  useEffect(() => {
    setLive(null);
    load();
    // Rangos largos: los buckets se recalculan en el servidor cada minuto.
    const interval = range === '1h' ? null : setInterval(() => load(true), 60_000);
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [load, range]);

  // Tiempo real: cada telemetria que llega por WebSocket se agrega al grafico
  // (rango 1 h, un punto por minuto) y actualiza los indicadores.
  useEffect(
    () =>
      onTelemetry((d) => {
        if (d.serverId !== server.id) return;
        const point: MetricPoint = {
          t: d.recordedAt,
          cpu: d.cpuUsage,
          cpuMax: d.perf?.cpuMax ?? d.cpuUsage,
          mem: d.memoryUsage,
          memMax: d.memoryUsage,
          disk: d.diskUsage,
          netIn: d.networkIn ?? null,
          netOut: d.networkOut ?? null,
          processes: d.processCount ?? null,
          latency: d.latencyMs ?? null,
          loss: d.lossPct ?? null,
        };
        setLive(point);
        if (d.perf) setLivePerf(d.perf);
        if (range === '1h') setPoints((prev) => [...prev, point].slice(-LIVE_MAX_POINTS));
      }),
    [server.id, range]
  );

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const last = live ?? points[points.length - 1] ?? null;
  const lastAt = live?.t ?? server.recordedAt ?? points[points.length - 1]?.t ?? null;
  const secondsAgo = lastAt ? Math.max(0, Math.round((now - new Date(lastAt).getTime()) / 1000)) : null;
  const isLive = server.status === 'ONLINE' && secondsAgo !== null && secondsAgo < 150;

  const perf = livePerf ?? server.perf ?? null;
  const cpu = last?.cpu ?? server.cpuUsage;
  const mem = last?.mem ?? server.memoryUsage;
  const disk = last?.disk ?? server.diskUsage;

  const s = useMemo(
    () => ({ cpu: stats(points, 'cpu'), mem: stats(points, 'mem'), netIn: stats(points, 'netIn'), latency: stats(points, 'latency') }),
    [points]
  );
  const hasNetwork = points.some((p) => p.netIn !== null || p.netOut !== null);
  const hasLatency = points.some((p) => p.latency !== null);

  const cpuHigh = server.thresholds.cpuThresholdHigh ?? RESOURCE_THRESHOLDS.cpuUsage.high;
  const cpuMedium = server.thresholds.cpuThresholdMedium ?? RESOURCE_THRESHOLDS.cpuUsage.medium;
  const net = server.network;
  const netLevel = internetLevel(
    net ? { internetUp: net.internetUp, latencyMs: last?.latency ?? net.latencyMs, lossPct: last?.loss ?? net.lossPct } : null
  );

  const tick = (v: string) => formatTick(v, range);
  const tooltipLabel = (v: string) => new Date(v).toLocaleString('es-ES');

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[11px]">
          <AnimatePresence mode="wait">
            {isLive ? (
              <motion.span
                key="live"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 font-semibold text-emerald-700"
              >
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                </span>
                EN VIVO
              </motion.span>
            ) : (
              <motion.span
                key="stale"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 font-semibold text-slate-500"
              >
                SIN DATOS RECIENTES
              </motion.span>
            )}
          </AnimatePresence>
          <span className="text-slate-400">
            {secondsAgo === null ? 'Sin telemetría' : secondsAgo < 60 ? `Última muestra hace ${secondsAgo} s` : `Última muestra hace ${Math.round(secondsAgo / 60)} min`}
          </span>
        </div>

        <div className="flex rounded-lg border border-slate-200 bg-slate-50 p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.id}
              onClick={() => setRange(r.id)}
              className="relative rounded-md px-2.5 py-1 text-[11px] font-medium text-slate-500 transition-colors hover:text-slate-800"
            >
              {range === r.id && (
                <motion.span
                  layoutId={`range-pill-${server.id}`}
                  className="absolute inset-0 rounded-md bg-white shadow-sm ring-1 ring-slate-200"
                  transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                />
              )}
              <span className={`relative ${range === r.id ? 'text-brand-700' : ''}`}>{r.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
        <KpiTile
          icon={<Cpu className="h-3.5 w-3.5" />}
          label="CPU"
          level={cpu === null ? 'none' : resourceLevel(cpu, 'cpuUsage')}
          percent={cpu}
          sub={
            perf?.cpuSteal !== undefined && perf?.cpuSteal !== null
              ? `Espera de disco ${perf.cpuIowait?.toFixed(0) ?? 0}% · steal ${perf.cpuSteal.toFixed(0)}% · carga ${perf.load1 ?? '—'} (${perf.cores ?? '?'} vCPU)`
              : perf?.cpuMax !== undefined && perf?.cpuMax !== null
              ? `Pico del último minuto ${perf.cpuMax.toFixed(0)}%${perf.agentCpu ? ` · agente ${perf.agentCpu.toFixed(1)}%` : ''}`
              : s.cpu
                ? `Prom. ${s.cpu.avg.toFixed(0)}% · máx. ${s.cpu.max.toFixed(0)}%`
                : undefined
          }
          hint={
            perf?.cpuSource === 'utility'
              ? 'Promedio del último minuto con el mismo contador que el Administrador de tareas (% Utilidad del procesador), medido cada segundo.'
              : 'Promedio del último minuto, medido cada segundo.'
          }
        >
          <AnimatedNumber value={cpu} decimals={1} suffix="%" />
        </KpiTile>
        <KpiTile
          icon={<MemoryStick className="h-3.5 w-3.5" />}
          label="RAM"
          level={mem === null ? 'none' : resourceLevel(mem, 'memoryUsage')}
          percent={mem}
          sub={
            perf?.memAvailableMb && perf?.memTotalMb
              ? `${(perf.memAvailableMb / 1024).toFixed(1)} GB libres de ${(perf.memTotalMb / 1024).toFixed(1)} GB`
              : s.mem
                ? `Prom. ${s.mem.avg.toFixed(0)}% · máx. ${s.mem.max.toFixed(0)}%`
                : undefined
          }
        >
          <AnimatedNumber value={mem} decimals={1} suffix="%" />
        </KpiTile>
        <KpiTile
          icon={<HardDrive className="h-3.5 w-3.5" />}
          label="Disco C: (espacio)"
          level={disk === null ? 'none' : resourceLevel(disk, 'diskUsage')}
          percent={disk}
          sub={
            perf?.diskBusyAvg !== undefined && perf?.diskBusyAvg !== null
              ? `Actividad ${perf.diskBusyAvg.toFixed(0)}% (pico ${(perf.diskBusyMax ?? 0).toFixed(0)}%)${perf.diskFreeGb !== null && perf.diskFreeGb !== undefined ? ` · ${perf.diskFreeGb} GB libres` : ''}`
              : 'Espacio usado de la unidad del sistema'
          }
        >
          <AnimatedNumber value={disk} decimals={1} suffix="%" />
        </KpiTile>
        <KpiTile
          icon={<Network className="h-3.5 w-3.5" />}
          label="Tráfico"
          level={last?.netIn === null || last?.netIn === undefined ? 'none' : 'ok'}
          sub={
            perf?.netUtilPct !== undefined && perf?.netUtilPct !== null
              ? `Uso del enlace ${perf.netUtilPct.toFixed(1)}% de ${perf.nicSpeedMbps! >= 1000 ? `${perf.nicSpeedMbps! / 1000} Gbps` : `${perf.nicSpeedMbps} Mbps`}`
              : s.netIn
                ? `Pico de entrada ${formatRate(s.netIn.max)}`
                : undefined
          }
        >
          <span className="flex flex-col text-sm leading-tight">
            <span className="flex items-center gap-1">
              <ArrowDownToLine className="h-3 w-3 text-sky-500" />
              {formatRate(last?.netIn)}
            </span>
            <span className="flex items-center gap-1">
              <ArrowUpFromLine className="h-3 w-3 text-violet-500" />
              {formatRate(last?.netOut)}
            </span>
          </span>
        </KpiTile>
        <KpiTile
          icon={<Globe className="h-3.5 w-3.5" />}
          label="Internet"
          level={netLevel}
          sub={
            net
              ? net.internetUp === false
                ? 'Sin salida a internet'
                : `Pérdida ${(last?.loss ?? net.lossPct ?? 0).toFixed(0)}%${net.dnsOk === null ? '' : ` · DNS ${net.dnsOk ? 'OK' : 'falla'}`}`
              : 'Requiere agente 1.3.0'
          }
        >
          {net?.internetUp === false ? 'CAÍDO' : <AnimatedNumber value={last?.latency ?? net?.latencyMs ?? null} decimals={0} suffix=" ms" />}
        </KpiTile>
      </div>

      {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}

      <ChartCard
        title="CPU, memoria y disco"
        icon={<Activity className="h-3.5 w-3.5 text-slate-400" />}
        right={
          <span className="flex items-center gap-3 text-[10px] text-slate-400">
            <span className="flex items-center gap-1">
              <span className="h-0.5 w-3 bg-amber-400" /> Umbral {cpuMedium}%
            </span>
            <span className="flex items-center gap-1">
              <span className="h-0.5 w-3 bg-red-400" /> Crítico {cpuHigh}%
            </span>
          </span>
        }
      >
        <div style={{ height: chartHeight }}>
          {loading && points.length === 0 ? (
            <div className="h-full animate-pulse rounded-lg bg-slate-100" />
          ) : points.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-slate-400">Sin telemetría en este rango</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={points} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
                <defs>
                  <linearGradient id={`g-cpu-${server.id}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={COLORS.cpu} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={COLORS.cpu} stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id={`g-mem-${server.id}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={COLORS.mem} stopOpacity={0.3} />
                    <stop offset="100%" stopColor={COLORS.mem} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
                <XAxis dataKey="t" tickFormatter={tick} stroke="#94a3b8" fontSize={10} minTickGap={40} tickLine={false} axisLine={false} />
                <YAxis domain={[0, 100]} unit="%" stroke="#94a3b8" fontSize={10} tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  labelFormatter={tooltipLabel}
                  formatter={(v: number, name: string) => [`${Number(v).toFixed(1)}%`, name]}
                />
                <ReferenceLine y={cpuMedium} stroke="#fbbf24" strokeDasharray="4 4" />
                <ReferenceLine y={cpuHigh} stroke="#f87171" strokeDasharray="4 4" />
                <Area type="monotone" dataKey="cpu" name="CPU" stroke={COLORS.cpu} strokeWidth={2} fill={`url(#g-cpu-${server.id})`} dot={false} animationDuration={600} />
                <Area type="monotone" dataKey="mem" name="RAM" stroke={COLORS.mem} strokeWidth={2} fill={`url(#g-mem-${server.id})`} dot={false} animationDuration={600} />
                <Area type="monotone" dataKey="disk" name="Disco" stroke={COLORS.disk} strokeWidth={1.5} strokeDasharray="5 3" fill="none" dot={false} animationDuration={600} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </ChartCard>

      {(hasNetwork || hasLatency) && (
        <div className={`grid gap-3 ${hasNetwork && hasLatency ? 'lg:grid-cols-2' : ''}`}>
          {hasNetwork && (
            <ChartCard title="Tráfico de red" icon={<Network className="h-3.5 w-3.5 text-slate-400" />}>
              <div style={{ height: Math.round(chartHeight * 0.75) }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={points} margin={{ top: 6, right: 8, left: 4, bottom: 0 }}>
                    <defs>
                      <linearGradient id={`g-in-${server.id}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={COLORS.netIn} stopOpacity={0.3} />
                        <stop offset="100%" stopColor={COLORS.netIn} stopOpacity={0.02} />
                      </linearGradient>
                      <linearGradient id={`g-out-${server.id}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={COLORS.netOut} stopOpacity={0.25} />
                        <stop offset="100%" stopColor={COLORS.netOut} stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
                    <XAxis dataKey="t" tickFormatter={tick} stroke="#94a3b8" fontSize={10} minTickGap={40} tickLine={false} axisLine={false} />
                    <YAxis tickFormatter={(v: number) => formatRate(v)} stroke="#94a3b8" fontSize={10} width={62} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} labelFormatter={tooltipLabel} formatter={(v: number, name: string) => [formatRate(v), name]} />
                    <Area type="monotone" dataKey="netIn" name="Entrada" stroke={COLORS.netIn} strokeWidth={2} fill={`url(#g-in-${server.id})`} dot={false} />
                    <Area type="monotone" dataKey="netOut" name="Salida" stroke={COLORS.netOut} strokeWidth={2} fill={`url(#g-out-${server.id})`} dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </ChartCard>
          )}
          {hasLatency && (
            <ChartCard title="Calidad de internet del sitio" icon={<Globe className="h-3.5 w-3.5 text-slate-400" />}>
              <div style={{ height: Math.round(chartHeight * 0.75) }}>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={points} margin={{ top: 6, right: 0, left: -12, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
                    <XAxis dataKey="t" tickFormatter={tick} stroke="#94a3b8" fontSize={10} minTickGap={40} tickLine={false} axisLine={false} />
                    <YAxis yAxisId="ms" tickFormatter={(v: number) => `${v} ms`} stroke="#94a3b8" fontSize={10} tickLine={false} axisLine={false} width={60} />
                    <YAxis yAxisId="pct" orientation="right" domain={[0, 100]} unit="%" stroke="#fca5a5" fontSize={10} tickLine={false} axisLine={false} />
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      labelFormatter={tooltipLabel}
                      formatter={(v: number, name: string) => [name === 'Pérdida' ? `${Number(v).toFixed(0)}%` : `${Number(v).toFixed(0)} ms`, name]}
                    />
                    <Bar yAxisId="pct" dataKey="loss" name="Pérdida" fill={COLORS.loss} fillOpacity={0.35} radius={[3, 3, 0, 0]} />
                    <Line yAxisId="ms" type="monotone" dataKey="latency" name="Latencia" stroke={COLORS.latency} strokeWidth={2} dot={false} connectNulls />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </ChartCard>
          )}
        </div>
      )}
    </div>
  );
}
