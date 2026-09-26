'use client';

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Activity, Lock, Plus, Trash2, X } from 'lucide-react';
import { useToast } from './Toast';
import { timeAgo } from '../lib/health';
import { API_URL, useLiveData } from './inventory/useLiveData';
import type { ServiceCheckRow } from '../types';

const EMPTY_FORM = { name: '', type: 'http' as 'http' | 'tcp', target: '', intervalSeconds: '60', keyword: '' };

function uptimeColor(v: number | null) {
  if (v === null) return 'text-slate-400';
  if (v >= 99.5) return 'text-emerald-700';
  if (v >= 97) return 'text-amber-700';
  return 'text-red-700';
}

export default function ServiceMonitorsPanel({ isAdmin }: { isAdmin: boolean }) {
  const { data, reload } = useLiveData<ServiceCheckRow[]>('/api/service-checks', { event: 'soc:service-check-reload', intervalMs: 60_000 });
  const [checks, setChecks] = useState<ServiceCheckRow[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (data) setChecks(data);
  }, [data]);

  // Cada resultado llega en vivo por WebSocket.
  useEffect(() => {
    const onCheck = (e: Event) => {
      const c = (e as CustomEvent).detail as Partial<ServiceCheckRow> & { id: string };
      setChecks((prev) =>
        prev.map((p) =>
          p.id === c.id
            ? {
                ...p,
                ...c,
                recent: [...p.recent, { at: String(c.lastCheckedAt), up: c.status === 'up', latencyMs: c.lastLatencyMs ?? null }].slice(-60),
              }
            : p
        )
      );
    };
    window.addEventListener('soc:service-check', onCheck);
    return () => window.removeEventListener('soc:service-check', onCheck);
  }, []);

  const create = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/api/admin/service-checks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          name: form.name,
          type: form.type,
          target: form.target.trim(),
          intervalSeconds: Number(form.intervalSeconds) || 60,
          keyword: form.keyword.trim() || null,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'No se pudo crear el monitor');
      toast.success(`Monitor "${form.name}" creado: el primer chequeo corre en unos segundos`);
      setForm(EMPTY_FORM);
      setShowForm(false);
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (c: ServiceCheckRow) => {
    if (!window.confirm(`¿Eliminar el monitor "${c.name}" y su historial?`)) return;
    await fetch(`${API_URL}/api/admin/service-checks/${c.id}`, { method: 'DELETE', credentials: 'include' });
    reload();
  };

  const up = checks.filter((c) => c.status === 'up').length;
  const down = checks.filter((c) => c.status === 'down').length;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
          <Activity className="h-4 w-4 text-slate-400" />
          Monitores de servicios
          <span className="font-normal text-slate-400">
            (sitios web, sistemas en la nube, VPN — chequeados desde la VPS)
            {checks.length > 0 && ` · ${up} arriba${down ? ` · ${down} caído(s)` : ''}`}
          </span>
        </h2>
        {isAdmin && (
          <button
            onClick={() => setShowForm((v) => !v)}
            className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-brand-700"
          >
            {showForm ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
            {showForm ? 'Cancelar' : 'Agregar monitor'}
          </button>
        )}
      </div>

      <AnimatePresence>
        {showForm && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="mb-4 grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-[1fr_110px_2fr_100px_1fr_auto]">
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Nombre (ej. Sistema POS)"
                className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-brand-500"
              />
              <select
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value as 'http' | 'tcp' })}
                className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs outline-none focus:border-brand-500"
              >
                <option value="http">HTTP(S)</option>
                <option value="tcp">Puerto TCP</option>
              </select>
              <input
                value={form.target}
                onChange={(e) => setForm({ ...form, target: e.target.value })}
                placeholder={form.type === 'http' ? 'https://sistema.ejemplo.com/login' : 'host.ejemplo.com:443'}
                className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs outline-none focus:border-brand-500"
              />
              <select
                value={form.intervalSeconds}
                onChange={(e) => setForm({ ...form, intervalSeconds: e.target.value })}
                className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs outline-none focus:border-brand-500"
              >
                <option value="30">cada 30 s</option>
                <option value="60">cada 1 min</option>
                <option value="300">cada 5 min</option>
                <option value="900">cada 15 min</option>
              </select>
              <input
                value={form.keyword}
                onChange={(e) => setForm({ ...form, keyword: e.target.value })}
                disabled={form.type !== 'http'}
                placeholder="Texto esperado (opcional)"
                className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-brand-500 disabled:opacity-50"
              />
              <button
                onClick={create}
                disabled={saving || !form.name || !form.target}
                className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              >
                {saving ? 'Guardando...' : 'Crear'}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {checks.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-5 text-center text-xs text-slate-500">
          Sin monitores. Sumá los sistemas críticos del negocio (punto de venta en la nube, facturación electrónica, página web, correo,
          VPN) para saber al instante si se caen y cuánto tiempo estuvieron arriba. En HTTPS también se avisa antes de que venza el certificado SSL.
        </p>
      ) : (
        <div className="space-y-2">
          {checks.map((c) => {
            const certDays = c.certExpiresAt ? Math.floor((new Date(c.certExpiresAt).getTime() - Date.now()) / 86400000) : null;
            return (
              <div
                key={c.id}
                className={`grid items-center gap-3 rounded-lg border px-3 py-2.5 text-xs md:grid-cols-[minmax(0,1.3fr)_minmax(0,2fr)_auto] ${
                  c.status === 'down' ? 'border-red-200 bg-red-50/40' : 'border-slate-200'
                }`}
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 font-semibold text-slate-800">
                    <span
                      className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                        c.status === 'up' ? 'bg-emerald-500' : c.status === 'down' ? 'animate-pulse bg-red-500' : 'bg-slate-300'
                      }`}
                    />
                    <span className="truncate">{c.name}</span>
                    {c.status === 'down' && <span className="rounded bg-red-600 px-1 text-[9px] font-bold text-white">CAÍDO</span>}
                  </p>
                  <p className="truncate font-mono text-[10px] text-slate-400">{c.target}</p>
                  {c.status === 'down' && c.lastError && <p className="truncate text-[10px] text-red-700">{c.lastError}</p>}
                </div>

                <div>
                  <div className="flex h-6 items-end gap-px" title="Últimos chequeos (verde = arriba, rojo = caído)">
                    {Array.from({ length: 60 - c.recent.length }).map((_, i) => (
                      <span key={`e${i}`} className="h-full flex-1 rounded-sm bg-slate-100" />
                    ))}
                    {c.recent.map((r, i) => (
                      <span
                        key={`${r.at}-${i}`}
                        title={`${new Date(r.at).toLocaleString('es-ES')} — ${r.up ? `${r.latencyMs ?? '?'} ms` : 'caído'}`}
                        className={`h-full flex-1 rounded-sm ${r.up ? 'bg-emerald-400' : 'bg-red-500'}`}
                      />
                    ))}
                  </div>
                  <p className="mt-1 text-[10px] text-slate-400">
                    {c.lastCheckedAt ? `Último chequeo ${timeAgo(c.lastCheckedAt)}` : 'Esperando el primer chequeo'}
                    {c.lastLatencyMs !== null && ` · ${c.lastLatencyMs} ms`}
                    {c.avgLatency24h !== null && ` · prom. 24 h ${c.avgLatency24h} ms`}
                    {certDays !== null && (
                      <span className={certDays <= 14 ? 'font-medium text-red-700' : ''}>
                        {' '}
                        · <Lock className="inline h-2.5 w-2.5" /> SSL vence en {certDays} d
                      </span>
                    )}
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  {[
                    ['24 h', c.uptime24h],
                    ['7 d', c.uptime7d],
                    ['30 d', c.uptime30d],
                  ].map(([label, v]) => (
                    <div key={label as string} className="text-center">
                      <p className={`font-semibold tabular-nums ${uptimeColor(v as number | null)}`}>{v === null ? '—' : `${(v as number).toFixed(2)}%`}</p>
                      <p className="text-[9px] uppercase text-slate-400">{label as string}</p>
                    </div>
                  ))}
                  {isAdmin && (
                    <button onClick={() => remove(c)} className="rounded-md p-1 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600" title="Eliminar monitor">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
