'use client';

import { useEffect, useState } from 'react';
import { ArrowRightLeft, CheckCircle2, ChevronDown, Loader2, XCircle } from 'lucide-react';
import PinInput from './ops/PinInput';
import { useToast } from './Toast';
import { useLiveData, API_URL } from './inventory/useLiveData';
import { timeAgo } from '../lib/health';

type MoveAgent = {
  id: string;
  name: string;
  status: string;
  lastSeenAt: string | null;
  agentVersion: string | null;
  supported: boolean;
  hostMonitor: boolean;
  via: string | null;
  moveTo: string | null;
  state: 'unreachable' | 'not-soc' | 'unknown-agent' | 'ready' | 'error' | null;
  detail: string | null;
  reportedAt: string | null;
};

type MoveStatus = {
  move: { url: string; setAt: string; setBy: string; expiresAt: string; expired?: boolean } | null;
  minAgentVersion: string;
  agents: MoveAgent[];
};

type Tone = 'ok' | 'info' | 'warn' | 'bad' | 'muted';
const TONE: Record<Tone, string> = {
  ok: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  info: 'bg-sky-50 text-sky-700 ring-sky-200',
  warn: 'bg-amber-50 text-amber-700 ring-amber-200',
  bad: 'bg-red-50 text-red-700 ring-red-200',
  muted: 'bg-slate-100 text-slate-500 ring-slate-200',
};

function agentState(a: MoveAgent, move: MoveStatus['move'], minVersion: string): { label: string; tone: Tone } {
  if (a.hostMonitor) return { label: 'Monitor del propio VPS (usa 127.0.0.1)', tone: 'muted' };
  if (!a.supported) return { label: `Necesita agente ${minVersion}${a.agentVersion ? ` (tiene ${a.agentVersion})` : ''}`, tone: 'warn' };
  if (!move || move.expired) return { label: 'Compatible', tone: 'ok' };
  if (a.via && a.via === move.url) return { label: 'Ya usa la dirección nueva', tone: 'ok' };
  switch (a.state) {
    case 'ready':
      return { label: 'Listo: se cambia si la dirección actual deja de responder', tone: 'info' };
    case 'unknown-agent':
      return { label: 'La dirección nueva no reconoce a este agente', tone: 'bad' };
    case 'unreachable':
      return { label: 'No llega a la dirección nueva', tone: 'bad' };
    case 'not-soc':
      return { label: 'La dirección responde pero no es el NOC', tone: 'bad' };
    case 'error':
      return { label: 'Error al probar la dirección nueva', tone: 'bad' };
    default:
      if (a.moveTo === move.url) return { label: 'Recibió la dirección, probando…', tone: 'muted' };
      return { label: a.status === 'OFFLINE' ? 'Sin conexión: la recibe al volver' : 'Esperando al agente…', tone: 'muted' };
  }
}

export default function AgentMovePanel() {
  const toast = useToast();
  const { data, reload } = useLiveData<MoveStatus>('/api/admin/agent-move', { event: 'soc:agent-move', intervalMs: 20_000 });
  const [url, setUrl] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  // Lo normal es pasar los agentes a la direccion con la que se abrio el panel (el dominio con HTTPS).
  useEffect(() => {
    if (window.location.protocol === 'https:') setUrl(window.location.origin);
  }, []);

  const move = data?.move && !data.move.expired ? data.move : null;
  const agents = (data?.agents ?? []).filter((a) => !a.hostMonitor);
  const rows = (data?.agents ?? []).map((a) => ({ a, s: agentState(a, move, data?.minAgentVersion ?? '1.19.0') }));
  const supported = agents.filter((a) => a.supported).length;
  const count = (tone: Tone) => rows.filter((r) => !r.a.hostMonitor && r.s.tone === tone).length;

  const schedule = async () => {
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/api/admin/agent-move`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), pin }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'No se pudo programar el cambio');
      toast.success(`Cambio de dirección programado: ${body.url}`);
      setPin('');
      setOpen(true);
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo programar el cambio');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!window.confirm('¿Cancelar el cambio? Los agentes que todavía no se cambiaron siguen con la dirección actual.')) return;
    const res = await fetch(`${API_URL}/api/admin/agent-move`, { method: 'DELETE', credentials: 'include' });
    if (res.ok) {
      toast.success('Cambio cancelado');
      reload();
    } else toast.error('No se pudo cancelar el cambio');
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
            <ArrowRightLeft className="h-4 w-4 text-slate-400" />
            Dirección del NOC en los agentes
          </h2>
          <p className="mt-1 max-w-3xl text-xs text-slate-500">
            Cambia la dirección que usan los agentes para hablar con el NOC (por ejemplo, de http://IP al dominio con HTTPS) sin entrar a cada servidor. Cada
            agente prueba la dirección nueva desde su red y se cambia solo si llega a este mismo NOC. Si no llega (DNS, firewall, inspección SSL del FortiGate),
            sigue con la actual y lo muestra acá.
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ${supported === agents.length ? TONE.ok : TONE.warn}`}>
          Agentes compatibles: {supported}/{agents.length}
        </span>
      </div>

      {move ? (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-brand-200 bg-brand-50/60 px-4 py-3">
            <div className="min-w-0 text-sm">
              <p className="font-medium text-slate-800">
                Cambio programado a <span className="font-mono">{move.url}</span>
              </p>
              <p className="text-xs text-slate-500">
                Por {move.setBy} {timeAgo(move.setAt)} · vence el {new Date(move.expiresAt).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })}
              </p>
            </div>
            <button onClick={cancel} className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100">
              <XCircle className="h-3.5 w-3.5" /> Cancelar cambio
            </button>
          </div>
          <div className="flex flex-wrap gap-2 text-[11px]">
            <span className={`rounded-full px-2.5 py-1 font-medium ring-1 ${TONE.ok}`}>Ya usan la dirección nueva: {count('ok')}</span>
            <span className={`rounded-full px-2.5 py-1 font-medium ring-1 ${TONE.info}`}>Listos: {count('info')}</span>
            <span className={`rounded-full px-2.5 py-1 font-medium ring-1 ${TONE.bad}`}>Con problemas: {count('bad')}</span>
            <span className={`rounded-full px-2.5 py-1 font-medium ring-1 ${TONE.warn}`}>Agente viejo: {count('warn')}</span>
            <span className={`rounded-full px-2.5 py-1 font-medium ring-1 ${TONE.muted}`}>Esperando: {count('muted')}</span>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <label className="flex min-w-[260px] flex-1 flex-col gap-1 text-[11px] font-medium text-slate-600">
            Dirección nueva del NOC
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://bistro.enterprisesoc.lat"
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-800 placeholder:font-sans placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
            />
          </label>
          <PinInput value={pin} onChange={setPin} />
          <button
            onClick={schedule}
            disabled={busy || !url.trim() || pin.length !== 6}
            className="mb-5 flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRightLeft className="h-4 w-4" />} Cambiar dirección
          </button>
        </div>
      )}

      <button onClick={() => setOpen((v) => !v)} className="mt-3 flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-800">
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
        {open ? 'Ocultar' : 'Ver'} el estado de cada agente
      </button>
      {open && (
        <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full min-w-[720px] text-xs">
            <thead className="bg-slate-50 text-left text-[10px] uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-3 py-2 font-medium">Servidor</th>
                <th className="px-3 py-2 font-medium">Agente</th>
                <th className="px-3 py-2 font-medium">Estado</th>
                <th className="px-3 py-2 font-medium">Conectado por</th>
                <th className="px-3 py-2 font-medium">Último reporte</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(({ a, s }) => (
                <tr key={a.id}>
                  <td className="px-3 py-2 font-medium text-slate-800">{a.name}</td>
                  <td className="px-3 py-2 font-mono text-slate-500">{a.agentVersion ?? '—'}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ring-1 ${TONE[s.tone]}`}>
                      {s.tone === 'ok' && <CheckCircle2 className="h-3 w-3" />}
                      {s.label}
                    </span>
                    {a.detail && ['unreachable', 'not-soc', 'error'].includes(a.state ?? '') && s.tone === 'bad' && <p className="mt-1 max-w-md text-[11px] text-slate-500">{a.detail}</p>}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-slate-500">{a.via ?? '—'}</td>
                  <td className="px-3 py-2 text-slate-500">{a.reportedAt ? timeAgo(a.reportedAt) : timeAgo(a.lastSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
