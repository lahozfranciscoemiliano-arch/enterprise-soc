import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { X } from 'lucide-react';
import type { RemoteSessionInfo, RemoteSessionStatus, ServerSummary } from '../types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
const WS_BASE = (process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:3000/ws').replace(/\/ws$/, '');

export default function RemoteAccessModal({ server, onClose }: { server: ServerSummary; onClose: () => void }) {
  const [targetPort, setTargetPort] = useState<3389 | 5900>(3389);
  const [session, setSession] = useState<RemoteSessionInfo | null>(null);
  const [status, setStatus] = useState<RemoteSessionStatus['status'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  };

  useEffect(() => stopPolling, []);

  const createSession = async () => {
    setCreating(true);
    setError(null);
    setSession(null);
    stopPolling();

    try {
      const res = await fetch(`${API_URL}/api/admin/servers/${server.id}/remote-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ targetPort }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'No se pudo crear la sesión');

      setSession(body);
      setStatus('PENDING');

      pollRef.current = setInterval(async () => {
        const r = await fetch(`${API_URL}/api/admin/remote-session/${body.sessionId}`, { credentials: 'include' });
        if (!r.ok) return;
        const s: RemoteSessionStatus = await r.json();
        setStatus(s.status);
        if (s.status !== 'PENDING') stopPolling();
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setCreating(false);
    }
  };

  const closeSession = async () => {
    if (!session) return;
    await fetch(`${API_URL}/api/admin/remote-session/${session.sessionId}/close`, {
      method: 'POST',
      credentials: 'include',
    });
    stopPolling();
    setStatus('CLOSED');
  };

  const relayCommand = session
    ? `node remote-relay.js --backend ${WS_BASE} --session ${session.sessionId} --token ${session.token}`
    : '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.15 }}
        className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-6 shadow-2xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">Conectar por RDP/VNC — {server.name}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="h-4 w-4" />
          </button>
        </div>

        {!session && (
          <>
            <p className="mb-3 text-xs text-slate-500">
              Abre un túnel inverso: el agente de este servidor se conecta hacia el backend, no hace falta abrir
              ningún puerto entrante ni tocar el servidor a mano. Requiere que el agente esté corriendo (canal de
              control conectado).
            </p>
            <label className="mb-1 block text-xs text-slate-500">Servicio</label>
            <select
              value={targetPort}
              onChange={(e) => setTargetPort(Number(e.target.value) as 3389 | 5900)}
              className="mb-4 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-800"
            >
              <option value={3389}>RDP (Escritorio remoto, puerto 3389)</option>
              <option value={5900}>VNC (puerto 5900)</option>
            </select>
            {error && <p className="mb-3 text-xs text-red-700">{error}</p>}
            <button
              onClick={createSession}
              disabled={creating}
              className="w-full rounded-lg bg-brand-600 py-2 text-xs font-medium text-white transition-colors hover:bg-brand-700 disabled:opacity-50"
            >
              {creating ? 'Creando sesión...' : 'Crear sesión de acceso remoto'}
            </button>
          </>
        )}

        {session && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-slate-500">Estado:</span>
              <span
                className={`rounded-full border px-2 py-0.5 ${
                  status === 'ACTIVE'
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : status === 'PENDING'
                      ? 'border-amber-200 bg-amber-50 text-amber-700'
                      : 'border-slate-300 bg-slate-50 text-slate-500'
                }`}
              >
                {status}
              </span>
              {status === 'PENDING' && <span className="text-slate-400">esperando que conectes el relay...</span>}
            </div>

            <div>
              <p className="mb-1 text-[11px] uppercase tracking-wide text-slate-400">
                1. En tu máquina (una sola vez): <code>cd tools && npm install</code>
              </p>
              <p className="mb-1 text-[11px] uppercase tracking-wide text-slate-400">2. Corré el relay local:</p>
              <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 text-[11px] text-slate-100">{relayCommand}</pre>
              <p className="mt-2 mb-1 text-[11px] uppercase tracking-wide text-slate-400">
                3. Conectá tu cliente {targetPort === 3389 ? 'RDP' : 'VNC'}:
              </p>
              <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 text-[11px] text-slate-100">
                {targetPort === 3389 ? 'mstsc /v:localhost:13389' : 'vncviewer localhost:13389'}
              </pre>
            </div>

            <p className="text-[11px] text-slate-500">
              El token es de un solo uso y expira en 2 minutos si no se usa. Una vez conectado, la sesión se corta
              sola a los 30 minutos como máximo.
            </p>

            <button
              onClick={closeSession}
              disabled={status === 'CLOSED' || status === 'EXPIRED'}
              className="w-full rounded-lg border border-red-200 py-2 text-xs text-red-700 transition-colors hover:bg-red-50 disabled:opacity-40"
            >
              Cerrar túnel ahora
            </button>
          </div>
        )}
      </motion.div>
    </div>
  );
}
