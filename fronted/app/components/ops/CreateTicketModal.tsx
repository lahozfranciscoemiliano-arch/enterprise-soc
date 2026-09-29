'use client';

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Ticket as TicketIcon, X } from 'lucide-react';
import PinInput from './PinInput';
import { useToast } from '../Toast';
import type { Severity } from '../../types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
const PRIORITY_LABEL: Record<Severity, string> = { LOW: 'Baja', MEDIUM: 'Media', HIGH: 'Alta', CRITICAL: 'Crítica' };

export default function CreateTicketModal({
  eventId,
  serverId,
  defaultTitle = '',
  defaultPriority = 'MEDIUM',
  servers = [],
  onClose,
  onCreated,
}: {
  eventId?: string;
  serverId?: string;
  defaultTitle?: string;
  defaultPriority?: Severity;
  servers?: { id: string; name: string }[];
  onClose: () => void;
  onCreated?: (id: string) => void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState(defaultTitle.slice(0, 200));
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Severity>(defaultPriority);
  const [assigneeId, setAssigneeId] = useState('');
  const [pickedServer, setPickedServer] = useState('');
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [pin, setPin] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    fetch(`${API_URL}/api/users/assignable`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : []))
      .then(setUsers)
      .catch(() => setUsers([]));
  }, []);

  const submit = async () => {
    setSending(true);
    try {
      const res = await fetch(`${API_URL}/api/tickets`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          priority,
          ...(description.trim() ? { description } : {}),
          ...(eventId ? { eventId } : {}),
          ...(!eventId && (serverId || pickedServer) ? { serverId: serverId || pickedServer } : {}),
          ...(assigneeId ? { assigneeId } : {}),
          pin,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? 'No se pudo crear el ticket');
        if (res.status === 401) setPin('');
        return;
      }
      toast.success(`Ticket #${body.number} creado`);
      onCreated?.(body.id);
      onClose();
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-1.5 text-base font-semibold text-slate-800">
            <TicketIcon className="h-4 w-4 text-brand-600" /> {eventId ? 'Convertir alerta en ticket' : 'Nuevo ticket'}
          </h2>
          <button onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3 text-xs">
          <label className="block">
            <span className="mb-1 block font-medium text-slate-600">Título</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-brand-500" />
          </label>
          <label className="block">
            <span className="mb-1 block font-medium text-slate-600">Descripción {eventId && <span className="font-normal text-slate-400">(vacío = el texto de la alerta)</span>}</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className="w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-brand-500" />
          </label>
          {!eventId && !serverId && servers.length > 0 && (
            <label className="block">
              <span className="mb-1 block font-medium text-slate-600">Servidor (opcional)</span>
              <select value={pickedServer} onChange={(e) => setPickedServer(e.target.value)} className="w-full rounded-lg border border-slate-300 px-2 py-2">
                <option value="">General / sin servidor</option>
                {servers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block font-medium text-slate-600">Prioridad</span>
              <select value={priority} onChange={(e) => setPriority(e.target.value as Severity)} className="w-full rounded-lg border border-slate-300 px-2 py-2">
                {(Object.keys(PRIORITY_LABEL) as Severity[]).map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABEL[p]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block font-medium text-slate-600">Responsable</span>
              <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} className="w-full rounded-lg border border-slate-300 px-2 py-2">
                <option value="">Sin asignar</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap items-end justify-between gap-3 border-t border-slate-100 pt-3">
            <PinInput value={pin} onChange={setPin} />
            <button
              onClick={submit}
              disabled={sending || title.trim().length < 3 || pin.length !== 6}
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-40"
            >
              {sending ? 'Creando...' : 'Crear ticket'}
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
