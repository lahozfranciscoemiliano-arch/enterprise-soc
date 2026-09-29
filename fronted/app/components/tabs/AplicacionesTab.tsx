'use client';

import Collapsible from '../Collapsible';
import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  Activity,
  AlertTriangle,
  AppWindow,
  BellOff,
  CheckCircle2,
  ChevronDown,
  Database,
  Lightbulb,
  Server,
  Zap,
} from 'lucide-react';
import StatCard from '../StatCard';
import { useLiveData } from '../inventory/useLiveData';
import { formatDuration, timeAgo } from '../../lib/health';
import type { AppInstanceRow, AppsOverview, MicrocutAnalysis, MicroOutageRow } from '../../types';

// Categorias de micro-corte: colores fijos por entidad (no por ranking).
const CAT = {
  APP: { label: 'Monark', color: '#2a78d6' },
} as const;

const STATUS = {
  ok: { label: 'Operativo', dot: 'bg-emerald-500', text: 'text-emerald-700', card: 'border-slate-200' },
  degraded: { label: 'Lento / saturado', dot: 'bg-amber-500', text: 'text-amber-700', card: 'border-amber-200 bg-amber-50/30' },
  down: { label: 'Con fallas', dot: 'bg-red-500 animate-pulse', text: 'text-red-700', card: 'border-red-200 bg-red-50/40' },
} as const;

const TOOLTIP_STYLE = { background: 'rgba(255,255,255,0.97)', border: '1px solid #e2e8f0', borderRadius: 10, fontSize: 12 };

function fmtMs(v: number | null | undefined) {
  return v === null || v === undefined ? '—' : `${Math.round(v)} ms`;
}
function fmtMb(v: number | null | undefined) {
  if (v === null || v === undefined) return '—';
  return v >= 1024 ? `${(v / 1024).toFixed(1)} GB` : `${Math.round(v)} MB`;
}
function hhmm(iso: string) {
  return new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
}

function Metric({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded-lg bg-white/70 px-2 py-1.5 ring-1 ring-slate-100">
      <p className="text-[10px] text-slate-400">{label}</p>
      <p className={`text-sm font-semibold tabular-nums ${warn ? 'text-amber-700' : 'text-slate-800'}`}>{value}</p>
    </div>
  );
}

function AppCard({ inst }: { inst: AppInstanceRow }) {
  const [open, setOpen] = useState(false);
  const st = STATUS[inst.status] ?? STATUS.ok;
  const m = inst.metrics;
  const sqlInst = inst.sql?.instances ?? [];
  const sqlMs = sqlInst.length ? Math.max(...sqlInst.map((i) => i.queryMs ?? 0)) : null;
  const dbs = sqlInst.flatMap((i) => i.databases ?? []);
  const blocked = dbs.reduce((a, d) => a + d.blocked, 0);
  const stale = Date.now() - new Date(inst.lastSeenAt).getTime() > 5 * 60 * 1000;

  return (
    <motion.div layout className={`rounded-xl border p-3 ${st.card}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate text-sm font-semibold text-slate-800">
            <Server className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            {inst.serverName}
          </p>
          <p className="truncate text-[10px] text-slate-400">
            {inst.detected.installed[0] ? `${inst.detected.installed[0].name}${inst.detected.installed[0].version ? ` ${inst.detected.installed[0].version}` : ''}` : inst.label}
            {' · '}medido {timeAgo(inst.lastSeenAt)}
          </p>
        </div>
        <span className={`flex shrink-0 items-center gap-1 text-[11px] font-medium ${stale ? 'text-slate-400' : st.text}`}>
          <span className={`h-2 w-2 rounded-full ${stale ? 'bg-slate-300' : st.dot}`} />
          {stale ? 'Sin datos recientes' : st.label}
        </span>
      </div>

      {inst.statusInfo && !stale && (
        <p className={`mt-2 rounded-lg px-2 py-1.5 text-[11px] ${inst.status === 'down' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-800'}`}>{inst.statusInfo}</p>
      )}

      <div className="mt-2.5 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        <Metric label="Servicios" value={m && m.servicesTotal ? `${m.servicesRunning}/${m.servicesTotal}` : '—'} warn={Boolean(m?.servicesDown?.length)} />
        <Metric label="CPU app" value={m?.cpuAvg !== null && m?.cpuAvg !== undefined ? `${Math.round(m.cpuAvg)}%` : '—'} warn={(m?.cpuAvg ?? 0) >= 85} />
        <Metric label="RAM app" value={fmtMb(m?.memMb)} />
        <Metric label="Respuesta" value={fmtMs(m?.latencyAvg)} warn={(m?.latencyAvg ?? 0) >= 500} />
        {inst.appKey === 'MONARK' && (
          <>
            <Metric label="SQL (consulta)" value={fmtMs(sqlMs)} warn={(sqlMs ?? 0) >= 1000} />
            <Metric label="Sesiones" value={dbs.length ? String(dbs.reduce((a, d) => a + d.sessions, 0)) : '—'} />
            <Metric label="Bloqueos" value={dbs.length ? String(blocked) : '—'} warn={blocked > 0} />
            <Metric label="Tamaño base" value={dbs.length ? fmtMb(dbs.reduce((a, d) => a + d.sizeMb, 0)) : '—'} />
          </>
        )}
      </div>

      {inst.trend.length > 1 && (
        <div className="mt-2.5">
          <p className="mb-1 text-[10px] text-slate-400">Últimas 24 h — tiempo de respuesta (ms){inst.appKey === 'MONARK' ? ' y SQL' : ''}</p>
          <div className="h-16">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={inst.trend} margin={{ top: 2, right: 2, left: 2, bottom: 0 }}>
                <XAxis dataKey="t" hide />
                <YAxis hide domain={[0, 'auto']} />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  labelFormatter={(v) => hhmm(String(v))}
                  formatter={(v, name) => [v === null ? '—' : `${v}${name === 'CPU' ? '%' : ' ms'}`, name]}
                />
                <Line type="monotone" dataKey="lat" name="Respuesta" stroke="#2a78d6" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
                {inst.appKey === 'MONARK' && <Line type="monotone" dataKey="sql" name="SQL" stroke="#eb6834" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />}
                <Line type="monotone" dataKey="cpu" name="CPU" stroke="#1baf7a" strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <button onClick={() => setOpen((o) => !o)} className="mt-2 flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-800">
        <motion.span animate={{ rotate: open ? 180 : 0 }} className="inline-flex">
          <ChevronDown className="h-3 w-3" />
        </motion.span>
        Qué se detectó en el servidor
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="mt-2 space-y-1.5 text-[11px] text-slate-600">
              {inst.detected.services.length > 0 && (
                <div>
                  <p className="font-medium text-slate-700">Servicios</p>
                  {inst.detected.services.map((s) => (
                    <p key={s.name} className="flex items-center gap-1.5">
                      <span className={`h-1.5 w-1.5 rounded-full ${s.status === 'running' ? 'bg-emerald-500' : 'bg-red-500'}`} />
                      {s.displayName || s.name} <span className="text-slate-400">({s.name} · {s.startType === 'automatic' ? 'automático' : s.startType ?? '—'} · {s.status === 'running' ? 'en ejecución' : s.status ?? '—'})</span>
                    </p>
                  ))}
                </div>
              )}
              {inst.detected.processNames.length > 0 && <p><span className="font-medium text-slate-700">Procesos:</span> {inst.detected.processNames.join(', ')}</p>}
              {inst.detected.databases.length > 0 && (
                <div>
                  <p className="font-medium text-slate-700">Bases SQL</p>
                  {dbs.length
                    ? dbs.map((d) => (
                        <p key={d.name}>
                          {d.name}: {fmtMb(d.sizeMb)} · {d.sessions} sesión(es) · {d.blocked} bloqueada(s)
                          {d.longestMs >= 60000 ? ` · consulta más larga ${Math.round(d.longestMs / 1000)} s` : ''}
                        </p>
                      ))
                    : inst.detected.databases.map((d) => <p key={d.name}>{d.instance} / {d.name}</p>)}
                  {sqlInst.filter((i) => i.error).map((i) => <p key={i.instance} className="text-red-600">{i.instance}: {i.error}</p>)}
                </div>
              )}
              {inst.detected.shares.length > 0 && <p><span className="font-medium text-slate-700">Carpetas compartidas:</span> {inst.detected.shares.join(', ')}</p>}
              {inst.detected.installed.length > 0 && <p><span className="font-medium text-slate-700">Programas:</span> {inst.detected.installed.map((p) => `${p.name}${p.version ? ` ${p.version}` : ''}`).join(', ')}</p>}
              {inst.detected.ports.length > 0 && <p><span className="font-medium text-slate-700">Puertos medidos:</span> {inst.detected.ports.join(', ')}</p>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function AppSection({ appKey, title, icon, instances, empty }: { appKey: 'MONARK'; title: string; icon: React.ReactNode; instances: AppInstanceRow[]; empty: string }) {
  const list = instances.filter((i) => i.appKey === appKey);
  const rank = { down: 0, degraded: 1, ok: 2 } as const;
  const sorted = [...list].sort((a, b) => rank[a.status] - rank[b.status] || a.serverName.localeCompare(b.serverName));
  const problems = list.filter((i) => i.status !== 'ok').length;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
      <h2 className="mb-3 flex flex-wrap items-center gap-1.5 text-sm font-semibold text-slate-800">
        {icon}
        {title}
        <span className="font-normal text-slate-400">
          ({list.length} servidor(es){problems ? ` · ${problems} con problemas` : ''})
        </span>
      </h2>
      {sorted.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-center text-xs text-slate-500">{empty}</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {sorted.map((i) => (
            <AppCard key={i.id} inst={i} />
          ))}
        </div>
      )}
    </div>
  );
}

function MicrocutsPanel() {
  const [days, setDays] = useState<1 | 7 | 30>(7);
  const { data, loading, error } = useLiveData<MicrocutAnalysis>(`/api/apps/microcuts?days=${days}`, {
    event: 'soc:apps',
    intervalMs: 120_000,
  });
  const cats = ['APP'] as const;
  // El detalle corte por corte arranca contraido: es largo.
  const [detailOpen, setDetailOpen] = useState(false);

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
          <Zap className="h-4 w-4 text-slate-400" />
          Cortes y lentitud de Monark
          {data && (
            <span className="font-normal text-slate-400">
              ({data.total} en {days === 1 ? '24 h' : `${days} días`} · {formatDuration(data.totalSeconds)} sin acceso{data.ongoing ? ` · ${data.ongoing} en curso` : ''})
            </span>
          )}
        </h2>
        <div className="flex flex-wrap gap-1.5">
          {([1, 7, 30] as const).map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`rounded-full border px-2.5 py-0.5 text-[11px] ${days === d ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}
            >
              {d === 1 ? '24 h' : `${d} días`}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="mb-2 text-xs text-red-600">{error}</p>}
      {loading && !data && <p className="text-xs text-slate-400">Cargando…</p>}

      {data && data.total === 0 && (
        <p className="flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
          <CheckCircle2 className="h-3.5 w-3.5" /> Sin micro-cortes en el período.
        </p>
      )}

      {data && data.total > 0 && (
        <>
          {data.insights.length > 0 && (
            <div className="mb-3 space-y-1 rounded-lg border border-sky-100 bg-sky-50/60 p-3">
              {data.insights.map((t) => (
                <p key={t} className="flex items-start gap-1.5 text-[12px] text-slate-700">
                  <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-600" />
                  {t}
                </p>
              ))}
            </div>
          )}

          <div className="mb-2 flex flex-wrap gap-3 text-[11px] text-slate-500">
            {cats.map((c) => (
              <span key={c} className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: CAT[c].color }} />
                {CAT[c].label}
              </span>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <div>
              <p className="mb-1 text-[11px] font-medium text-slate-600">¿A qué hora ocurren? (hora del día)</p>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.byHour} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke="#e1e0d9" />
                    <XAxis dataKey="hour" tick={{ fontSize: 10, fill: '#898781' }} tickFormatter={(h) => `${h}h`} interval={1} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: '#898781' }} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} labelFormatter={(h) => `${h}:00 a ${Number(h) + 1}:00`} cursor={{ fill: 'rgba(15,23,42,0.04)' }} />
                    {cats.map((c, i) => (
                      <Bar key={c} dataKey={c} name={CAT[c].label} stackId="a" fill={CAT[c].color} radius={i === cats.length - 1 ? [3, 3, 0, 0] : 0} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div>
              <p className="mb-1 text-[11px] font-medium text-slate-600">Por día</p>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.byDay} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke="#e1e0d9" />
                    <XAxis dataKey="day" tick={{ fontSize: 10, fill: '#898781' }} tickFormatter={(d) => String(d).slice(5).split('-').reverse().join('/')} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: '#898781' }} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'rgba(15,23,42,0.04)' }} />
                    {cats.map((c, i) => (
                      <Bar key={c} dataKey={c} name={CAT[c].label} stackId="a" fill={CAT[c].color} radius={i === cats.length - 1 ? [3, 3, 0, 0] : 0} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          <button
            onClick={() => setDetailOpen((o) => !o)}
            aria-expanded={detailOpen}
            className="mt-4 flex w-full items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-left text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100"
          >
            <span>
              Detalle de los {data.total} corte(s): inicio, duración, componente, servidor y causa
              {data.ongoing ? <span className="ml-1 text-red-700">· {data.ongoing} en curso</span> : null}
            </span>
            <ChevronDown className={`h-4 w-4 transition-transform ${detailOpen ? 'rotate-180' : ''}`} />
          </button>
          {detailOpen && (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[680px] text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-400">
                  <th className="py-2 pr-3 font-medium">Inicio</th>
                  <th className="py-2 pr-3 font-medium">Duración</th>
                  <th className="py-2 pr-3 font-medium">Componente</th>
                  <th className="py-2 pr-3 font-medium">Servidor</th>
                  <th className="py-2 pr-3 font-medium">Causa</th>
                </tr>
              </thead>
              <tbody>
                {data.events.slice(0, 150).map((e: MicroOutageRow) => (
                  <tr key={e.id} className={`border-b border-slate-100 ${e.endedAt ? '' : 'bg-red-50/60'}`}>
                    <td className="py-1.5 pr-3 tabular-nums text-slate-600">{new Date(e.startedAt).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'medium' })}</td>
                    <td className="py-1.5 pr-3 tabular-nums font-medium text-slate-800">{e.endedAt ? formatDuration(e.durationSeconds) : <span className="text-red-700">en curso</span>}</td>
                    <td className="py-1.5 pr-3">
                      <span className="flex items-center gap-1.5">
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: CAT.APP.color }} />
                        <span className="truncate font-mono text-[11px] text-slate-700">{e.label}</span>
                      </span>
                    </td>
                    <td className="py-1.5 pr-3 text-slate-600">{e.serverName}</td>
                    <td className="py-1.5 pr-3 text-slate-500">{e.cause}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.events.length > 150 && <p className="mt-2 text-[11px] text-slate-400">Mostrando los 150 más recientes de {data.total}.</p>}
          </div>
          )}
        </>
      )}
    </div>
  );
}

export default function AplicacionesTab() {
  const { data, error } = useLiveData<AppsOverview>('/api/apps/overview', { event: 'soc:apps', intervalMs: 60_000 });
  const instances = useMemo(() => data?.instances ?? [], [data]);
  const monark = instances.filter((i) => i.appKey === 'MONARK');
  const bad = monark.filter((i) => i.status !== 'ok').length;
  const slowest = monark.reduce<number | null>((a, i) => {
    const v = i.metrics?.latencyAvg ?? null;
    return v === null ? a : a === null ? v : Math.max(a, v);
  }, null);

  return (
    <div className="space-y-4 px-3 py-4 sm:px-6 sm:py-6">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard label="Servidores con Monark" value={`${monark.length - bad}/${monark.length}`} color={bad ? 'amber' : 'emerald'} icon={<Database className="h-5 w-5" />} />
        <StatCard label="Respuesta más lenta" value={slowest === null ? '—' : `${Math.round(slowest)} ms`} color={(slowest ?? 0) >= 500 ? 'amber' : 'blue'} icon={<Activity className="h-5 w-5" />} />
        <StatCard label="Cortes de Monark (24 h)" value={String(data?.microcuts24h ?? 0)} color={data?.microcuts24h ? 'amber' : 'emerald'} icon={<Zap className="h-5 w-5" />} />
        <StatCard label="Cortes en curso" value={String(data?.ongoing.length ?? 0)} color={data?.ongoing.length ? 'red' : 'emerald'} icon={<AlertTriangle className="h-5 w-5" />} />
      </div>

      <p className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[11px] text-slate-500">
        <BellOff className="h-3.5 w-3.5 shrink-0 text-slate-400" />
        Las alertas de Monark son <strong className="font-medium text-slate-700">silenciosas</strong>: aparecen en el NOC y en el listado de alertas, pero no
        envían email, Telegram ni notificación al celular.
      </p>

      {error && (
        <p className="flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <AlertTriangle className="h-3.5 w-3.5" /> {error}
        </p>
      )}

      {data && data.ongoing.length > 0 && (
        <div className="rounded-xl border border-red-200 bg-red-50/50 p-3">
          <p className="mb-1 text-xs font-semibold text-red-800">Cortes en curso</p>
          {data.ongoing.map((o) => (
            <p key={o.id} className="text-[11px] text-red-700">
              {o.label} — en {o.serverName}, {timeAgo(o.startedAt)} ({o.cause})
            </p>
          ))}
        </div>
      )}

      <AppSection
        appKey="MONARK"
        title="Monark"
        icon={<Database className="h-4 w-4 text-slate-400" />}
        instances={instances}
        empty="No se detectó Monark en ningún servidor todavía. El agente (1.12 o superior) lo busca cada 15 minutos en servicios, procesos, programas instalados y bases de SQL Server."
      />
      <Collapsible id="apps-microcuts">
        <MicrocutsPanel />
      </Collapsible>
      {!data && !error && (
        <p className="flex items-center gap-1.5 text-xs text-slate-400">
          <AppWindow className="h-3.5 w-3.5" /> Cargando…
        </p>
      )}
    </div>
  );
}
