'use client';

import { motion } from 'framer-motion';
import { AlertTriangle, CheckCircle2, FileStack, Printer } from 'lucide-react';
import { timeAgo } from '../../lib/health';
import { useLiveData } from './useLiveData';
import type { PrinterRow } from '../../types';

const ERROR_LABEL: Record<string, string> = {
  lowPaper: 'Poco papel',
  noPaper: 'Sin papel',
  lowToner: 'Tóner bajo',
  noToner: 'Sin tóner',
  doorOpen: 'Tapa abierta',
  jammed: 'Papel atascado',
  offline: 'Fuera de línea',
  serviceRequested: 'Requiere servicio',
  inputTrayMissing: 'Falta bandeja de entrada',
  outputTrayMissing: 'Falta bandeja de salida',
  markerSupplyMissing: 'Falta cartucho',
  outputNearFull: 'Salida casi llena',
  outputFull: 'Salida llena',
  inputTrayEmpty: 'Bandeja vacía',
  overduePreventMaint: 'Mantenimiento vencido',
};
const WARNING_ONLY = ['lowPaper', 'lowToner', 'outputNearFull', 'overduePreventMaint'];

const STATUS_LABEL: Record<string, string> = {
  idle: 'Lista',
  printing: 'Imprimiendo',
  warmup: 'Calentando',
  other: 'Otro estado',
  unknown: 'En línea',
  offline: 'Sin respuesta',
};

// Color de la barra segun el nombre del consumible (Black/Cyan/Magenta/Yellow).
function supplyColor(name: string) {
  const n = name.toLowerCase();
  if (/cyan|cian/.test(n)) return 'bg-cyan-500';
  if (/magenta/.test(n)) return 'bg-fuchsia-500';
  if (/yellow|amarill/.test(n)) return 'bg-yellow-400';
  if (/black|negro|toner|tóner|drum|tambor|imaging/.test(n)) return 'bg-slate-700';
  return 'bg-slate-500';
}

export default function PrintersView() {
  const { data, error } = useLiveData<PrinterRow[]>('/api/inventory/printers');
  const printers = [...(data ?? [])].sort((a, b) => {
    const score = (p: PrinterRow) => (!p.online ? 0 : p.errors.some((e) => !WARNING_ONLY.includes(e)) ? 1 : p.errors.length ? 2 : 3);
    return score(a) - score(b) || (a.name ?? a.id).localeCompare(b.name ?? b.id);
  });

  if (error) return <p className="text-xs text-red-600">{error}</p>;
  if (data === null) return <p className="py-6 text-center text-sm text-slate-400">Cargando...</p>;
  if (printers.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-xs text-slate-500">
        Todavía no se detectaron impresoras. El agente de BSFS2 las busca por SNMP (comunidad &quot;public&quot; por defecto) en todas las IPs activas
        y en las colas del servidor de impresión.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      {printers.map((p, i) => {
        const blocking = p.errors.filter((e) => !WARNING_ONLY.includes(e));
        const warnings = p.errors.filter((e) => WARNING_ONLY.includes(e));
        const tone = !p.online ? 'red' : blocking.length ? 'red' : warnings.length ? 'amber' : 'emerald';
        const border = { red: 'border-red-200 bg-red-50/30', amber: 'border-amber-200 bg-amber-50/30', emerald: 'border-slate-200' }[tone];
        const supplies = Array.isArray(p.supplies) ? p.supplies : [];
        return (
          <motion.div
            key={p.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(i * 0.03, 0.3) }}
            className={`rounded-xl border p-4 ${border}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2.5">
                <div
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                    tone === 'emerald' ? 'bg-emerald-50 text-emerald-600' : tone === 'amber' ? 'bg-amber-50 text-amber-600' : 'bg-red-50 text-red-600'
                  }`}
                >
                  <Printer className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-slate-800">{p.name ?? p.model ?? 'Impresora'}</p>
                  <p className="truncate text-[11px] text-slate-400">{p.model ?? 'Modelo desconocido'}</p>
                </div>
              </div>
              <span
                className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                  !p.online ? 'border-red-200 bg-red-50 text-red-700' : 'border-emerald-200 bg-emerald-50 text-emerald-700'
                }`}
              >
                {p.online ? STATUS_LABEL[p.status ?? 'unknown'] ?? p.status : 'Sin respuesta'}
              </span>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-slate-500">
              <span>
                IP: <span className="font-mono text-slate-700">{p.id}</span>
              </span>
              <span>Serie: {p.serial ?? '—'}</span>
              <span className="flex items-center gap-1">
                <FileStack className="h-3 w-3" />
                {p.pageCount !== null ? `${p.pageCount.toLocaleString('es')} páginas` : 'Contador —'}
              </span>
              <span className="truncate">Ubicación: {p.location || '—'}</span>
            </div>

            {(p.errors.length > 0 || !p.online) && (
              <div className="mt-3 flex flex-wrap gap-1">
                {!p.online && (
                  <span className="flex items-center gap-1 rounded-md bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700">
                    <AlertTriangle className="h-3 w-3" /> No responde {timeAgo(p.statusChangedAt)}
                  </span>
                )}
                {p.errors.map((e) => (
                  <span
                    key={e}
                    className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${WARNING_ONLY.includes(e) ? 'bg-amber-100 text-amber-800' : 'bg-red-100 text-red-700'}`}
                  >
                    {ERROR_LABEL[e] ?? e}
                  </span>
                ))}
              </div>
            )}
            {p.online && p.errors.length === 0 && (
              <p className="mt-3 flex items-center gap-1 text-[11px] text-emerald-700">
                <CheckCircle2 className="h-3.5 w-3.5" /> Sin errores
              </p>
            )}

            {supplies.length > 0 && (
              <div className="mt-3 space-y-1.5">
                {supplies.map((s) => (
                  <div key={s.name}>
                    <div className="mb-0.5 flex justify-between text-[10px]">
                      <span className="truncate text-slate-600">{s.name}</span>
                      <span className={`font-semibold tabular-nums ${s.percent !== null && s.percent <= 10 ? 'text-red-700' : s.percent !== null && s.percent <= 20 ? 'text-amber-700' : 'text-slate-600'}`}>
                        {s.percent !== null ? `${s.percent}%` : 'n/d'}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                      <motion.div
                        className={`h-full rounded-full ${supplyColor(s.name)}`}
                        initial={{ width: 0 }}
                        animate={{ width: `${s.percent ?? 0}%` }}
                        transition={{ duration: 0.8, ease: 'easeOut' }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}

            {p.queues && p.queues.length > 0 && (
              <p className="mt-3 border-t border-slate-100 pt-2 text-[10px] text-slate-400">
                Cola{p.queues.length > 1 ? 's' : ''} en el servidor: {p.queues.map((q) => `${q.name}${q.jobs ? ` (${q.jobs} trabajo/s en espera)` : ''}`).join(', ')}
              </p>
            )}
          </motion.div>
        );
      })}
    </div>
  );
}
