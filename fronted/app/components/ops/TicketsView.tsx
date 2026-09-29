'use client';

import { useEffect, useMemo, useState } from 'react';
import { MessageSquare, Plus, Search, Ticket as TicketIcon, UserRound, Wrench } from 'lucide-react';
import { SEVERITY_STYLES, timeAgo } from '../../lib/health';
import { useLiveData, API_URL } from '../inventory/useLiveData';
import { useToast } from '../Toast';
import CreateTicketModal from './CreateTicketModal';
import RemediationModal from './RemediationModal';
import PinInput from './PinInput';
import type { Ticket, TicketDetail, TicketStatus } from '../../types';

export const TICKET_STATUS: Record<TicketStatus, { label: string; badge: string }> = {
  OPEN: { label: 'Abierto', badge: 'bg-sky-50 text-sky-700 border-sky-200' },
  IN_PROGRESS: { label: 'En curso', badge: 'bg-violet-50 text-violet-700 border-violet-200' },
  WAITING: { label: 'En espera', badge: 'bg-amber-50 text-amber-700 border-amber-200' },
  RESOLVED: { label: 'Resuelto', badge: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  CLOSED: { label: 'Cerrado', badge: 'bg-slate-100 text-slate-500 border-slate-200' },
};
const PRIORITY_LABEL = { LOW: 'Baja', MEDIUM: 'Media', HIGH: 'Alta', CRITICAL: 'Crítica' } as const;
type Filter = 'active' | 'mine' | 'RESOLVED' | 'CLOSED' | 'all';

type Metrics = {
  total: number;
  open: number;
  technicians: { technician: string; assigned: number; open: number; resolved: number; avgResolutionHours: number | null; avgFirstResponseHours: number | null }[];
};

function TicketDetailPanel({ id, canWrite, onChanged }: { id: string; canWrite: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [t, setT] = useState<TicketDetail | null>(null);
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [comment, setComment] = useState('');
  const [status, setStatus] = useState<TicketStatus | ''>('');
  const [assigneeId, setAssigneeId] = useState<string | null | undefined>(undefined);
  const [resolution, setResolution] = useState('');
  const [saveToKb, setSaveToKb] = useState(true);
  const [pin, setPin] = useState('');
  const [fixOpen, setFixOpen] = useState(false);

  const load = async () => {
    const res = await fetch(`${API_URL}/api/tickets/${id}`, { credentials: 'include' });
    if (res.ok) {
      const body: TicketDetail = await res.json();
      setT(body);
      setResolution((r) => r || body.resolution || '');
    }
  };

  useEffect(() => {
    setT(null);
    setStatus('');
    setAssigneeId(undefined);
    setResolution('');
    setPin('');
    load();
    fetch(`${API_URL}/api/users/assignable`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : []))
      .then(setUsers)
      .catch(() => null);
    const onUpdate = (e: Event) => {
      if ((e as CustomEvent<{ id: string }>).detail?.id === id) load();
    };
    window.addEventListener('soc:tickets', onUpdate);
    window.addEventListener('soc:remediation', load);
    return () => {
      window.removeEventListener('soc:tickets', onUpdate);
      window.removeEventListener('soc:remediation', load);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!t) return <p className="py-10 text-center text-sm text-slate-400">Cargando...</p>;

  const closing = status === 'RESOLVED' || status === 'CLOSED';
  const changed = (status && status !== t.status) || (assigneeId !== undefined && assigneeId !== t.assigneeId) || (resolution.trim() && resolution !== (t.resolution ?? ''));

  const save = async () => {
    const res = await fetch(`${API_URL}/api/tickets/${t.id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(status && status !== t.status ? { status } : {}),
        ...(assigneeId !== undefined && assigneeId !== t.assigneeId ? { assigneeId } : {}),
        ...(resolution.trim() && resolution !== (t.resolution ?? '') ? { resolution } : {}),
        ...(closing ? { saveToKb } : {}),
        pin,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(body.error ?? 'No se pudo guardar');
      setPin('');
      return;
    }
    toast.success(closing && saveToKb ? 'Ticket cerrado y solución guardada en la base de conocimiento' : 'Ticket actualizado');
    setPin('');
    setStatus('');
    setAssigneeId(undefined);
    load();
    onChanged();
  };

  const addComment = async () => {
    const res = await fetch(`${API_URL}/api/tickets/${t.id}/comments`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: comment }),
    });
    if (res.ok) {
      setComment('');
      load();
    } else toast.error('No se pudo comentar');
  };

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[11px] text-slate-400">
          #{t.number} · creado por {t.createdByName} {timeAgo(t.createdAt)}
          {t.serverName ? ` · ${t.serverName}` : ''}
        </p>
        <h3 className="text-base font-semibold text-slate-800">{t.title}</h3>
        <div className="mt-1 flex flex-wrap gap-1.5 text-[11px]">
          <span className={`rounded border px-1.5 ${TICKET_STATUS[t.status].badge}`}>{TICKET_STATUS[t.status].label}</span>
          <span className={`rounded border px-1.5 ${SEVERITY_STYLES[t.priority]}`}>{PRIORITY_LABEL[t.priority]}</span>
          <span className="flex items-center gap-1 text-slate-500">
            <UserRound className="h-3 w-3" /> {t.assigneeName ?? 'sin responsable'}
          </span>
        </div>
        {t.description && <p className="mt-2 whitespace-pre-wrap rounded-lg bg-slate-50 p-2.5 text-xs text-slate-600">{t.description}</p>}
        {t.resolution && (
          <p className="mt-2 whitespace-pre-wrap rounded-lg border border-emerald-100 bg-emerald-50 p-2.5 text-xs text-emerald-800">
            <b>Solución:</b> {t.resolution}
          </p>
        )}
      </div>

      {t.suggestions.length > 0 && !['RESOLVED', 'CLOSED'].includes(t.status) && (
        <div className="rounded-lg border border-violet-100 bg-violet-50/60 p-2.5 text-[11px]">
          <p className="mb-1 font-semibold text-violet-800">Soluciones de casos parecidos</p>
          {t.suggestions.map((a) => (
            <details key={a.id} className="mb-1">
              <summary className="cursor-pointer text-slate-700">{a.title}</summary>
              <p className="mt-1 whitespace-pre-wrap text-slate-600">{a.solution}</p>
            </details>
          ))}
        </div>
      )}

      {canWrite && (
        <div className="space-y-2 rounded-xl border border-slate-200 p-3 text-xs">
          <div className="grid gap-2 sm:grid-cols-2">
            <label>
              <span className="mb-1 block font-medium text-slate-600">Estado</span>
              <select value={status || t.status} onChange={(e) => setStatus(e.target.value as TicketStatus)} className="w-full rounded-lg border border-slate-300 px-2 py-1.5">
                {(Object.keys(TICKET_STATUS) as TicketStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {TICKET_STATUS[s].label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="mb-1 block font-medium text-slate-600">Responsable</span>
              <select
                value={(assigneeId === undefined ? t.assigneeId : assigneeId) ?? ''}
                onChange={(e) => setAssigneeId(e.target.value || null)}
                className="w-full rounded-lg border border-slate-300 px-2 py-1.5"
              >
                <option value="">Sin asignar</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {(closing || t.resolution) && (
            <label className="block">
              <span className="mb-1 block font-medium text-slate-600">Cómo se resolvió {closing && <span className="text-red-600">*</span>}</span>
              <textarea
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
                rows={3}
                placeholder="Qué se encontró y qué se hizo (queda en la base de conocimiento)"
                className="w-full rounded-lg border border-slate-300 px-2.5 py-2 outline-none focus:border-brand-500"
              />
            </label>
          )}
          {closing && (
            <label className="flex items-center gap-1.5 text-slate-600">
              <input type="checkbox" checked={saveToKb} onChange={(e) => setSaveToKb(e.target.checked)} /> Guardar la solución en la base de conocimiento
            </label>
          )}
          {changed && (
            <div className="flex flex-wrap items-end justify-between gap-2 border-t border-slate-100 pt-2">
              <PinInput value={pin} onChange={setPin} />
              <button onClick={save} disabled={pin.length !== 6} className="rounded-lg bg-brand-600 px-3 py-1.5 font-medium text-white hover:bg-brand-700 disabled:opacity-40">
                Guardar cambios
              </button>
            </div>
          )}
          {t.serverId && (
            <button onClick={() => setFixOpen(true)} className="flex items-center gap-1 rounded-lg border border-brand-200 px-2.5 py-1 text-brand-700 hover:bg-brand-50">
              <Wrench className="h-3.5 w-3.5" /> Acción de remediación
            </button>
          )}
        </div>
      )}

      {t.actions.length > 0 && (
        <div className="text-[11px]">
          <p className="mb-1 font-semibold text-slate-600">Acciones ejecutadas</p>
          {t.actions.map((a) => (
            <p key={a.id} className="text-slate-500">
              {new Date(a.createdAt).toLocaleString('es-AR')} · {a.action} en {a.serverName} · <b>{a.status}</b> · {a.requestedByName}
            </p>
          ))}
        </div>
      )}

      <div>
        <p className="mb-1.5 flex items-center gap-1 text-xs font-semibold text-slate-600">
          <MessageSquare className="h-3.5 w-3.5" /> Historial
        </p>
        <ul className="space-y-1.5">
          {t.comments.map((c) => (
            <li key={c.id} className={`rounded-lg p-2 text-[11px] ${c.kind === 'comment' ? 'bg-white ring-1 ring-slate-200' : 'bg-slate-50 text-slate-500'}`}>
              <span className="font-medium text-slate-700">{c.userName}</span> <span className="text-slate-400">· {new Date(c.createdAt).toLocaleString('es-AR')}</span>
              <p className="whitespace-pre-wrap">{c.body}</p>
            </li>
          ))}
        </ul>
        {canWrite && (
          <div className="mt-2 flex gap-2">
            <input
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && comment.trim() && addComment()}
              placeholder="Agregar comentario..."
              className="flex-1 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs outline-none focus:border-brand-500"
            />
            <button onClick={addComment} disabled={!comment.trim()} className="rounded-lg border border-slate-200 px-3 text-xs hover:bg-slate-50 disabled:opacity-40">
              Enviar
            </button>
          </div>
        )}
      </div>
      {fixOpen && <RemediationModal serverId={t.serverId} eventId={t.eventId} ticketId={t.id} onClose={() => setFixOpen(false)} />}
    </div>
  );
}

export default function TicketsView({ canWrite }: { canWrite: boolean }) {
  const [filter, setFilter] = useState<Filter>('active');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const query = filter === 'active' ? '?status=active' : filter === 'mine' ? '?status=active&mine=1' : filter === 'all' ? '' : `?status=${filter}`;
  const { data, reload } = useLiveData<Ticket[]>(`/api/tickets${query}`, { event: 'soc:tickets', intervalMs: 60_000 });
  const { data: metrics } = useLiveData<Metrics>('/api/tickets/metrics', { event: 'soc:tickets', intervalMs: 300_000 });

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data ?? []).filter((t) => !q || [t.title, t.serverName, t.assigneeName, `#${t.number}`].some((v) => v?.toLowerCase().includes(q)));
  }, [data, search]);

  return (
    <div className="space-y-4">
      {metrics && metrics.technicians.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-400">
              <tr>
                <th className="px-3 py-1.5 font-medium">Técnico (30 días)</th>
                <th className="px-3 py-1.5 font-medium">Asignados</th>
                <th className="px-3 py-1.5 font-medium">Abiertos</th>
                <th className="px-3 py-1.5 font-medium">Resueltos</th>
                <th className="px-3 py-1.5 font-medium">1ª respuesta prom.</th>
                <th className="px-3 py-1.5 font-medium">Resolución prom.</th>
              </tr>
            </thead>
            <tbody>
              {metrics.technicians.map((m) => (
                <tr key={m.technician} className="border-t border-slate-100">
                  <td className="px-3 py-1.5 font-medium text-slate-700">{m.technician}</td>
                  <td className="px-3 py-1.5">{m.assigned}</td>
                  <td className="px-3 py-1.5">{m.open}</td>
                  <td className="px-3 py-1.5">{m.resolved}</td>
                  <td className="px-3 py-1.5">{m.avgFirstResponseHours !== null ? `${m.avgFirstResponseHours} h` : '—'}</td>
                  <td className="px-3 py-1.5">{m.avgResolutionHours !== null ? `${m.avgResolutionHours} h` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          {(
            [
              ['active', 'Activos'],
              ['mine', 'Míos'],
              ['RESOLVED', 'Resueltos'],
              ['CLOSED', 'Cerrados'],
              ['all', 'Todos'],
            ] as [Filter, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setFilter(id)}
              className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${filter === id ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar ticket..." className="w-48 rounded-lg border border-slate-300 py-1.5 pl-8 pr-3 text-xs outline-none focus:border-brand-500" />
          </div>
          {canWrite && (
            <button onClick={() => setCreating(true)} className="flex items-center gap-1 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700">
              <Plus className="h-3.5 w-3.5" /> Nuevo
            </button>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <ul className="max-h-[70vh] space-y-1.5 overflow-y-auto pr-1">
          {data === null && <p className="py-6 text-center text-sm text-slate-400">Cargando...</p>}
          {data !== null && rows.length === 0 && (
            <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-xs text-slate-500">
              Sin tickets. Desde cualquier alerta se puede crear uno con el botón “Ticket”.
            </p>
          )}
          {rows.map((t) => (
            <li key={t.id}>
              <button
                onClick={() => setSelected(t.id)}
                className={`w-full rounded-lg border p-2.5 text-left transition-colors ${selected === t.id ? 'border-brand-500 bg-brand-50' : 'border-slate-200 bg-white hover:bg-slate-50'}`}
              >
                <span className="flex items-center gap-2 text-[11px]">
                  <span className="font-mono text-slate-400">#{t.number}</span>
                  <span className={`rounded border px-1.5 ${TICKET_STATUS[t.status].badge}`}>{TICKET_STATUS[t.status].label}</span>
                  <span className={`rounded border px-1.5 ${SEVERITY_STYLES[t.priority]}`}>{PRIORITY_LABEL[t.priority]}</span>
                  <span className="ml-auto text-slate-400">{timeAgo(t.updatedAt)}</span>
                </span>
                <span className="mt-1 block truncate text-xs font-semibold text-slate-800">{t.title}</span>
                <span className="block truncate text-[10px] text-slate-500">
                  {t.serverName ?? 'general'} · {t.assigneeName ?? 'sin responsable'}
                  {t._count?.comments ? ` · ${t._count.comments} nota(s)` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="min-h-[200px] rounded-xl border border-slate-200 bg-white p-4">
          {selected ? (
            <TicketDetailPanel id={selected} canWrite={canWrite} onChanged={reload} />
          ) : (
            <p className="flex h-full flex-col items-center justify-center gap-2 py-10 text-center text-xs text-slate-400">
              <TicketIcon className="h-8 w-8 text-slate-300" />
              Elegí un ticket para ver el detalle. Los cambios de estado, responsable y cierre se aprueban con tu PIN.
            </p>
          )}
        </div>
      </div>
      {creating && <CreateTicketModal onClose={() => setCreating(false)} onCreated={(id) => setSelected(id)} />}
    </div>
  );
}
