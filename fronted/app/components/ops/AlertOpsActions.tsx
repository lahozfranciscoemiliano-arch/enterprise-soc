'use client';

import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { BookOpen, Ticket as TicketIcon, Wrench } from 'lucide-react';
import CreateTicketModal from './CreateTicketModal';
import RemediationModal from './RemediationModal';
import type { KnowledgeArticle, SecurityAlert } from '../../types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

/** Botones de operacion de una alerta: ticket, remediar y soluciones anteriores. */
export default function AlertOpsActions({ alert, canWrite = true }: { alert: SecurityAlert; canWrite?: boolean }) {
  const [ticketOpen, setTicketOpen] = useState(false);
  const [fixOpen, setFixOpen] = useState(false);
  const [kb, setKb] = useState<KnowledgeArticle[] | null>(null);
  const [kbOpen, setKbOpen] = useState(false);

  const toggleKb = async () => {
    setKbOpen((o) => !o);
    if (kb) return;
    try {
      const res = await fetch(`${API_URL}/api/kb/suggest?eventId=${alert.id}`, { credentials: 'include' });
      setKb(res.ok ? await res.json() : []);
    } catch {
      setKb([]);
    }
  };

  const used = (id: string) => fetch(`${API_URL}/api/kb/${id}/used`, { method: 'POST', credentials: 'include' }).catch(() => null);

  return (
    <div className="mt-1.5">
      <div className="flex flex-wrap gap-1.5">
        {canWrite && (
          <>
            <button onClick={() => setTicketOpen(true)} className="flex items-center gap-1 rounded-md border border-slate-200 px-2 py-0.5 text-[11px] text-slate-600 transition-colors hover:bg-slate-50">
              <TicketIcon className="h-3 w-3" /> Ticket
            </button>
            {alert.serverId && (
              <button onClick={() => setFixOpen(true)} className="flex items-center gap-1 rounded-md border border-brand-200 px-2 py-0.5 text-[11px] text-brand-700 transition-colors hover:bg-brand-50">
                <Wrench className="h-3 w-3" /> Remediar
              </button>
            )}
          </>
        )}
        <button onClick={toggleKb} className="flex items-center gap-1 rounded-md border border-slate-200 px-2 py-0.5 text-[11px] text-slate-600 transition-colors hover:bg-slate-50">
          <BookOpen className="h-3 w-3" /> Cómo se resolvió antes
        </button>
      </div>
      <AnimatePresence initial={false}>
        {kbOpen && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="mt-1.5 rounded-lg border border-violet-100 bg-violet-50/60 p-2.5 text-[11px] text-slate-700">
              {kb === null ? (
                <p className="text-slate-400">Buscando...</p>
              ) : kb.length === 0 ? (
                <p className="text-slate-500">Todavía no hay una solución registrada para algo parecido. Al cerrar el ticket de esta alerta, la solución queda guardada.</p>
              ) : (
                <ul className="space-y-2">
                  {kb.map((a) => (
                    <li key={a.id}>
                      <details onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && used(a.id)}>
                        <summary className="cursor-pointer font-semibold text-violet-800">
                          {a.title} <span className="font-normal text-slate-400">· usada {a.uses} vez/veces</span>
                        </summary>
                        <p className="mt-1 whitespace-pre-wrap">{a.solution}</p>
                        <p className="mt-0.5 text-[10px] text-slate-400">por {a.createdByName}</p>
                      </details>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {ticketOpen && (
        <CreateTicketModal
          eventId={alert.id}
          defaultTitle={`${alert.serverName ? `${alert.serverName}: ` : ''}${alert.description.split(/[.:]/)[0]}`.slice(0, 120)}
          defaultPriority={alert.severity}
          onClose={() => setTicketOpen(false)}
        />
      )}
      {fixOpen && <RemediationModal eventId={alert.id} onClose={() => setFixOpen(false)} />}
    </div>
  );
}
