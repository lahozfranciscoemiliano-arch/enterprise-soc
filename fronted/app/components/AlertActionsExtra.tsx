'use client';

import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { BellOff, ChevronDown, Lightbulb } from 'lucide-react';
import { useToast } from './Toast';
import type { SecurityAlert } from '../types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

const SNOOZE_OPTIONS = [
  { minutes: 60, label: '1 hora' },
  { minutes: 480, label: '8 horas' },
  { minutes: 1440, label: '24 horas' },
  { minutes: 10080, label: '7 días' },
];

export function isSnoozed(alert: SecurityAlert) {
  return Boolean(alert.snoozedUntil && new Date(alert.snoozedUntil).getTime() > Date.now());
}

/** "Qué hacer": pasos recomendados y prevención para el tipo de alerta. */
export function AlertRecommendation({ alert, defaultOpen = false }: { alert: SecurityAlert; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const rec = alert.recommendation;
  if (!rec) return null;
  return (
    <div className="mt-1.5">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 text-[11px] font-medium text-amber-700 transition-colors hover:text-amber-800"
      >
        <Lightbulb className="h-3 w-3" />
        Qué hacer
        <motion.span animate={{ rotate: open ? 180 : 0 }} className="inline-flex">
          <ChevronDown className="h-3 w-3" />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="mt-1 rounded-lg border border-amber-100 bg-amber-50/60 p-2.5 text-[11px] text-slate-700">
              <ol className="list-decimal space-y-1 pl-4">
                {rec.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
              <p className="mt-1.5 text-slate-500">
                <b className="font-semibold text-slate-600">Prevención:</b> {rec.prevention}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Silenciar una alerta: no vuelve a notificar (aunque empeore) por un tiempo. */
export function SnoozeButton({ alert }: { alert: SecurityAlert }) {
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const snoozed = isSnoozed(alert);

  const snooze = async (minutes: number) => {
    setOpen(false);
    try {
      const res = await fetch(`${API_URL}/api/events/${alert.id}/snooze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ minutes }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'No se pudo silenciar');
      toast.success(minutes ? 'Alerta silenciada: no va a volver a notificar por ese tiempo' : 'Notificaciones reactivadas');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error desconocido');
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => (snoozed ? snooze(0) : setOpen((o) => !o))}
        title={snoozed ? `Silenciada hasta ${new Date(alert.snoozedUntil!).toLocaleString('es-ES')} (tocar para reactivar)` : 'Silenciar notificaciones de esta alerta'}
        className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] transition-colors ${
          snoozed ? 'border-slate-300 bg-slate-100 text-slate-600' : 'border-slate-200 text-slate-500 hover:bg-slate-50'
        }`}
      >
        <BellOff className="h-3 w-3" />
        {snoozed ? 'Silenciada' : 'Silenciar'}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="absolute right-0 z-20 mt-1 w-32 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
          >
            {SNOOZE_OPTIONS.map((o) => (
              <button key={o.minutes} onClick={() => snooze(o.minutes)} className="block w-full px-3 py-1.5 text-left text-[11px] text-slate-600 hover:bg-slate-50">
                {o.label}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
