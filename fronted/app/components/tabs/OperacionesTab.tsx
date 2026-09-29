'use client';

import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlarmClock, BookOpen, CheckCircle2, Gauge, ShieldAlert, Ticket as TicketIcon, UserX, Wrench, type LucideIcon } from 'lucide-react';
import StatCard from '../StatCard';
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

type Kpis = {
  openTickets: number;
  criticalOpen: number;
  overdue: number;
  unassigned: number;
  mine: number;
  avgResolutionHours: number | null;
  slaCompliancePct: number | null;
  actions7: number;
  actionsSuccessPct: number | null;
  kbArticles: number;
};

function RemediationHistory({ servers, canWrite }: { servers: ServerSummary[]; canWrite: boolean }) {
  const { data: raw } = useLiveData<RemediationAction[]>('/api/remediation?limit=300', { event: 'soc:remediation', intervalMs: 120_000 });
  const [serverId, setServerId] = useState('');
  const [open, setOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [serverFilter, setServerFilter] = useState('');
  const data = raw?.filter((a) => (!statusFilter || a.status === statusFilter) && (!serverFilter || a.serverName === serverFilter)) ?? null;
  const serverNames = [...new Set((raw ?? []).map((a) => a.serverName))].sort();
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
      <div className="flex flex-wrap gap-2 text-xs">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1.5">
          <option value="">Todo resultado</option>
          <option value="SUCCESS">Exitosas</option>
          <option value="FAILED">Fallidas</option>
          <option value="EXPIRED">Vencidas</option>
          <option value="PENDING">Pendientes</option>
          <option value="SENT">En ejecución</option>
        </select>
        <select value={serverFilter} onChange={(e) => setServerFilter(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1.5">
          <option value="">Todos los servidores</option>
          {serverNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      {!data ? (
        <p className="py-6 text-center text-sm text-slate-400">Cargando...</p>
      ) : data.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-xs text-slate-500">Sin acciones que coincidan.</p>
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
  const { data: k } = useLiveData<Kpis>('/api/ops/kpis', { event: 'soc:tickets', intervalMs: 120_000 });
  return (
    <div className="space-y-4 px-3 py-4 sm:px-6 sm:py-6">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Tickets abiertos" value={k ? `${k.openTickets}` : '—'} color="blue" icon={<TicketIcon className="h-5 w-5" />} />
        <StatCard label="Altos / críticos" value={k ? `${k.criticalOpen}` : '—'} color={k && k.criticalOpen > 0 ? 'red' : 'emerald'} icon={<ShieldAlert className="h-5 w-5" />} />
        <StatCard label="Vencidos (SLA)" value={k ? `${k.overdue}` : '—'} color={k && k.overdue > 0 ? 'red' : 'emerald'} icon={<AlarmClock className="h-5 w-5" />} />
        <StatCard label="Sin responsable" value={k ? `${k.unassigned}` : '—'} color={k && k.unassigned > 0 ? 'amber' : 'emerald'} icon={<UserX className="h-5 w-5" />} />
        <StatCard
          label="SLA cumplido (30 d)"
          value={k?.slaCompliancePct != null ? `${k.slaCompliancePct}%` : '—'}
          color={k?.slaCompliancePct != null && k.slaCompliancePct < 80 ? 'amber' : 'emerald'}
          icon={<Gauge className="h-5 w-5" />}
        />
        <StatCard
          label="Remediaciones OK (7 d)"
          value={k ? (k.actionsSuccessPct != null ? `${k.actionsSuccessPct}% de ${k.actions7}` : `${k.actions7}`) : '—'}
          color="emerald"
          icon={<CheckCircle2 className="h-5 w-5" />}
        />
      </div>
      {k && (
        <p className="text-[11px] text-slate-400">
          Plazos por prioridad: crítica 4 h · alta 8 h · media 24 h · baja 72 h. Resolución promedio (30 d): {k.avgResolutionHours ?? '—'} h · {k.mine} ticket(s) asignados a vos ·{' '}
          {k.kbArticles} artículo(s) en la base de conocimiento.
        </p>
      )}
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
              {section === 'tickets' && <TicketsView canWrite={canWrite} servers={servers.map((s) => ({ id: s.id, name: s.name }))} />}
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
