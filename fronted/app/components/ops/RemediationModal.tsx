'use client';

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { CheckCircle2, Loader2, ShieldAlert, Wrench, X, XCircle } from 'lucide-react';
import PinInput from './PinInput';
import { useToast } from '../Toast';
import type { RemediationAction, RemediationOption } from '../../types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

const RISK_STYLE: Record<string, string> = {
  bajo: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  medio: 'bg-amber-50 text-amber-700 border-amber-200',
  alto: 'bg-red-50 text-red-700 border-red-200',
};

const STATUS_LABEL: Record<RemediationAction['status'], string> = {
  PENDING: 'Esperando al agente...',
  SENT: 'Ejecutándose en el servidor...',
  SUCCESS: 'Ejecutada correctamente',
  FAILED: 'Falló',
  EXPIRED: 'El agente no la tomó (vencida)',
};

// Acciones con un clic: el NOC SUGIERE, la persona elige y aprueba con su
// PIN. Nunca se ejecuta nada automaticamente.
export default function RemediationModal({
  serverId,
  eventId,
  ticketId,
  onClose,
}: {
  serverId?: string | null;
  eventId?: string | null;
  ticketId?: string | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const [data, setData] = useState<{ server: { id: string; name: string; online: boolean } | null; options: RemediationOption[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [custom, setCustom] = useState('');
  const [pin, setPin] = useState('');
  const [sending, setSending] = useState(false);
  const [run, setRun] = useState<RemediationAction | null>(null);

  useEffect(() => {
    const q = eventId ? `eventId=${eventId}` : `serverId=${serverId}`;
    fetch(`${API_URL}/api/remediation/options?${q}`, { credentials: 'include' })
      .then(async (r) => (r.ok ? setData(await r.json()) : setError((await r.json().catch(() => ({}))).error ?? 'No se pudieron cargar las acciones')))
      .catch(() => setError('No se pudieron cargar las acciones'));
  }, [serverId, eventId]);

  // Seguimiento en vivo del resultado (WebSocket -> 'soc:remediation').
  useEffect(() => {
    if (!run) return undefined;
    const onUpdate = (e: Event) => {
      const a = (e as CustomEvent<RemediationAction>).detail;
      if (a?.id === run.id) setRun((prev) => (prev ? { ...prev, ...a } : a));
    };
    window.addEventListener('soc:remediation', onUpdate);
    return () => window.removeEventListener('soc:remediation', onUpdate);
  }, [run]);

  const option = selected !== null ? data?.options[selected] : null;
  const params = option?.custom ? { name: custom.trim() } : option?.params ?? {};
  const ready = option && pin.length === 6 && (!option.custom || custom.trim().length > 0);

  const submit = async () => {
    if (!option || !data?.server) return;
    if (option.risk === 'alto' && !window.confirm(`"${option.label}" en ${data.server.name}: ¿confirmás?`)) return;
    setSending(true);
    try {
      const res = await fetch(`${API_URL}/api/remediation`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: data.server.id, action: option.action, params, ...(eventId ? { eventId } : {}), ...(ticketId ? { ticketId } : {}), pin }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? 'No se pudo aprobar la acción');
        setPin('');
        return;
      }
      setRun(body);
      toast.success('Acción aprobada: el agente la ejecuta en menos de 30 s');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl"
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-1.5 text-base font-semibold text-slate-800">
              <Wrench className="h-4 w-4 text-brand-600" /> Remediación {data?.server ? `· ${data.server.name}` : ''}
            </h2>
            <p className="text-[11px] text-slate-500">Nada se ejecuta solo: elegí la acción y aprobala con tu PIN. Queda registrada en la auditoría.</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100">
            <X className="h-4 w-4" />
          </button>
        </div>

        {error && <p className="text-xs text-red-600">{error}</p>}
        {!data && !error && <p className="py-6 text-center text-sm text-slate-400">Cargando...</p>}

        {run ? (
          <div className="space-y-2 rounded-xl border border-slate-200 p-4 text-sm">
            <p className="flex items-center gap-2 font-medium">
              {run.status === 'SUCCESS' ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              ) : run.status === 'FAILED' || run.status === 'EXPIRED' ? (
                <XCircle className="h-4 w-4 text-red-600" />
              ) : (
                <Loader2 className="h-4 w-4 animate-spin text-brand-600" />
              )}
              {STATUS_LABEL[run.status]}
            </p>
            {run.output && <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-900 p-2 text-[11px] text-slate-100">{run.output}</pre>}
            <button onClick={onClose} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs hover:bg-slate-50">
              Cerrar
            </button>
          </div>
        ) : (
          data && (
            <>
              {data.server && !data.server.online && (
                <p className="mb-2 flex items-center gap-1 rounded-lg bg-red-50 p-2 text-xs text-red-700">
                  <ShieldAlert className="h-3.5 w-3.5" /> El servidor está offline: el agente no puede ejecutar acciones.
                </p>
              )}
              <div className="space-y-1.5">
                {data.options.map((o, i) => (
                  <button
                    key={`${o.action}-${JSON.stringify(o.params)}-${i}`}
                    onClick={() => setSelected(i)}
                    className={`w-full rounded-lg border p-2.5 text-left transition-colors ${selected === i ? 'border-brand-500 bg-brand-50' : 'border-slate-200 hover:bg-slate-50'} ${o.generic ? 'opacity-90' : ''}`}
                  >
                    <span className="flex flex-wrap items-center gap-2 text-xs">
                      <b className="font-semibold text-slate-800">
                        {o.label}
                        {o.params?.name ? `: ${o.params.name}` : o.params?.sam ? `: ${o.params.sam}` : ''}
                      </b>
                      <span className={`rounded border px-1.5 text-[10px] ${RISK_STYLE[o.risk]}`}>riesgo {o.risk}</span>
                      {!o.generic && <span className="rounded bg-brand-600 px-1.5 text-[10px] font-medium text-white">Recomendada</span>}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-slate-500">{o.why ?? o.help}</span>
                  </button>
                ))}
              </div>
              {option?.custom && (
                <input
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  placeholder="Nombre del servicio (ej. Spooler, MSSQL$MONARK)"
                  className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs outline-none focus:border-brand-500"
                />
              )}
              <div className="mt-4 flex flex-wrap items-end justify-between gap-3 border-t border-slate-100 pt-3">
                <PinInput value={pin} onChange={setPin} />
                <button
                  disabled={!ready || sending || !data.server?.online}
                  onClick={submit}
                  className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {sending ? 'Aprobando...' : 'Aprobar y ejecutar'}
                </button>
              </div>
            </>
          )
        )}
      </motion.div>
    </div>
  );
}
