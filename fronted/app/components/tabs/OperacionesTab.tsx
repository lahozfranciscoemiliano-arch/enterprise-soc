'use client';

import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { BookOpen, ShieldAlert, Ticket as TicketIcon, Wrench, type LucideIcon } from 'lucide-react';
import TicketsView from '../ops/TicketsView';
import KnowledgeView from '../ops/KnowledgeView';
import PatchesView from '../ops/PatchesView';
import RemediationModal from '../ops/RemediationModal';
import { useLiveData } from '../inventory/useLiveData';
import { timeAgo } from '../../lib/health';
import type { RemediationAction, ServerSummary } from '../../types';

type Section = 'tickets' | 'kb' | 'acciones' | 'parches';
const SECTIONS: { id: Section; label: string; icon: LucideIcon }[] = [
  { id: 'tickets', label: 'Tickets', icon: TicketIcon },
  { id: 'kb', label: 'Base de conocimiento', icon: BookOpen },
  { id: 'acciones', label: 'Remediaciones', icon: Wrench },
  { id: 'parches', label: 'Parches (KB)', icon: ShieldAlert },
];

const STATUS_STYLE: Record<RemediationAction['status'], string> = {
  PENDING: 'bg-slate-100 text-slate-600',
  SENT: 'bg-sky-50 text-sky-700',
  SUCCESS: 'bg-emerald-50 text-emerald-700',
  FAILED: 'bg-red-50 text-red-700',
  EXPIRED: 'bg-amber-50 text-amber-700',
};

function RemediationHistory({ servers, canWrite }: { servers: ServerSummary[]; canWrite: boolean }) {
  const { data } = useLiveData<RemediationAction[]>('/api/remediation?limit=200', { event: 'soc:remediation', intervalMs: 120_000 });
  const [serverId, setServerId] = useState('');
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-3">
      {canWrite && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs">
          <span className="text-slate-600">Ejecutar una acción en</span>
          <select value={serverId} onChange={(e) => setServerId(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1.5">
            <option value="">Elegir servidor...</option>
            {servers
              .filter((s) => s.status !== 'OFFLINE')
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
          <button disabled={!serverId} onClick={() => setOpen(true)} className="rounded-lg bg-brand-600 px-3 py-1.5 font-medium text-white hover:bg-brand-700 disabled:opacity-40">
            Ver acciones
          </button>
          <span className="text-[11px] text-slate-400">Siempre con tu PIN; nunca se ejecuta nada automáticamente.</span>
        </div>
      )}
      {!data ? (
        <p className="py-6 text-center text-sm text-slate-400">Cargando...</p>
      ) : data.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-xs text-slate-500">Todavía no se ejecutó ninguna acción.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-400">
                <th className="py-1.5 pr-3 font-medium">Cuándo</th>
                <th className="py-1.5 pr-3 font-medium">Servidor</th>
                <th className="py-1.5 pr-3 font-medium">Acción</th>
                <th className="py-1.5 pr-3 font-medium">Aprobó</th>
                <th className="py-1.5 pr-3 font-medium">Resultado</th>
              </tr>
            </thead>
            <tbody>
              {data.map((a) => (
                <tr key={a.id} className="border-b border-slate-100 align-top">
                  <td className="py-1.5 pr-3 text-slate-500">{timeAgo(a.createdAt)}</td>
                  <td className="py-1.5 pr-3 font-medium text-slate-700">{a.serverName}</td>
                  <td className="py-1.5 pr-3 font-mono text-[11px]">
                    {a.action}
                    {a.params && Object.values(a.params).length ? ` (${Object.values(a.params).join(', ')})` : ''}
                  </td>
                  <td className="py-1.5 pr-3">{a.requestedByName}</td>
                  <td className="py-1.5 pr-3">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_STYLE[a.status]}`}>{a.status}</span>
                    {a.output && <span className="mt-0.5 block max-w-md truncate text-[10px] text-slate-400" title={a.output}>{a.output}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && serverId && <RemediationModal serverId={serverId} onClose={() => setOpen(false)} />}
    </div>
  );
}

export default function OperacionesTab({ servers, isAdmin, canWrite }: { servers: ServerSummary[]; isAdmin: boolean; canWrite: boolean }) {
  const [section, setSection] = useState<Section>('tickets');
  return (
    <div className="px-3 py-4 sm:px-6 sm:py-6">
      <div className="rounded-xl border border-slate-200 bg-white shadow-card">
        <div className="flex gap-1 overflow-x-auto border-b border-slate-200 px-3">
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            const active = section === s.id;
            return (
              <button
                key={s.id}
                onClick={() => setSection(s.id)}
                className={`relative flex shrink-0 items-center gap-1.5 px-3 py-3 text-xs font-medium transition-colors ${active ? 'text-brand-700' : 'text-slate-500 hover:text-slate-800'}`}
              >
                <Icon className="h-3.5 w-3.5" />
                {s.label}
                {active && <motion.span layoutId="ops-tab" className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-brand-600" />}
              </button>
            );
          })}
        </div>
        <div className="p-4">
          <AnimatePresence mode="wait">
            <motion.div key={section} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
              {section === 'tickets' && <TicketsView canWrite={canWrite} />}
              {section === 'kb' && <KnowledgeView canWrite={canWrite} isAdmin={isAdmin} />}
              {section === 'acciones' && <RemediationHistory servers={servers} canWrite={canWrite} />}
              {section === 'parches' && <PatchesView />}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
