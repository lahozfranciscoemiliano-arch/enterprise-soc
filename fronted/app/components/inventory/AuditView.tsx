'use client';

import { motion } from 'framer-motion';
import { KeyRound, LogIn, type LucideIcon, ShieldAlert, Unlock, UserMinus, UserPlus, Users, Lock } from 'lucide-react';
import { useMemo } from 'react';
import { useLiveData } from './useLiveData';
import { NetworkGroup, networkOf, sortNetKeys, useNetworks } from './networks';
import type { DirectoryEventRow, LogonRecord } from '../../types';

const PRIVILEGED = /admin|operator|opers\.|schema|esquema|dnsadmins|policy creator/i;

const KIND: Record<string, { label: string; icon: LucideIcon; tone: string }> = {
  lockout: { label: 'Cuenta bloqueada', icon: Lock, tone: 'bg-amber-50 text-amber-700' },
  unlock: { label: 'Cuenta desbloqueada', icon: Unlock, tone: 'bg-emerald-50 text-emerald-700' },
  user_created: { label: 'Usuario creado', icon: UserPlus, tone: 'bg-sky-50 text-sky-700' },
  user_deleted: { label: 'Usuario eliminado', icon: UserMinus, tone: 'bg-slate-100 text-slate-700' },
  password_reset: { label: 'Contraseña restablecida', icon: KeyRound, tone: 'bg-violet-50 text-violet-700' },
  group_member_added: { label: 'Agregado a grupo', icon: Users, tone: 'bg-sky-50 text-sky-700' },
  group_member_removed: { label: 'Quitado de grupo', icon: Users, tone: 'bg-slate-100 text-slate-700' },
};

function describe(e: DirectoryEventRow) {
  const actor = e.actor && !e.actor.endsWith('$') ? ` por ${e.actor}` : '';
  switch (e.kind) {
    case 'lockout':
      return `${e.target}${e.callerHost ? ` (intentos desde ${e.callerHost})` : ''}`;
    case 'group_member_added':
      return `${e.target} → ${e.group}${actor}`;
    case 'group_member_removed':
      return `${e.target} ✕ ${e.group}${actor}`;
    default:
      return `${e.target ?? '—'}${actor}`;
  }
}

export default function AuditView() {
  const events = useLiveData<DirectoryEventRow[]>('/api/inventory/directory-events?limit=200');
  const logons = useLiveData<LogonRecord[]>('/api/inventory/logons?limit=600');
  const nets = useNetworks();
  // Sesiones agrupadas por la red (gateway) desde la que se conectaron.
  const logonGroups = useMemo(() => {
    const map = new Map<string, { key: string; label: string; gateway: string | null; servers: string[]; rows: LogonRecord[] }>();
    for (const l of logons.data ?? []) {
      const n = networkOf(l.ipAddress, nets);
      const g = map.get(n.key) ?? { ...n, rows: [] };
      g.rows.push(l);
      map.set(n.key, g);
    }
    return [...map.values()].sort((a, b) => sortNetKeys(a.key, b.key));
  }, [logons.data, nets]);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <p className="mb-3 flex items-center gap-1.5 text-xs font-semibold text-slate-800">
          <ShieldAlert className="h-4 w-4 text-slate-400" />
          Cambios en el Active Directory
        </p>
        {events.data === null ? (
          <p className="text-xs text-slate-400">Cargando...</p>
        ) : events.data.length === 0 ? (
          <p className="text-xs text-slate-400">Sin cambios registrados todavía (requiere la auditoría de administración de cuentas activa en el DC — viene activada por defecto).</p>
        ) : (
          <ul className="max-h-[520px] space-y-1.5 overflow-y-auto pr-1">
            {events.data.map((e, i) => {
              const k = KIND[e.kind] ?? { label: e.kind, icon: Users, tone: 'bg-slate-100 text-slate-700' };
              const Icon = k.icon;
              const critical = e.kind === 'group_member_added' && PRIVILEGED.test(e.group ?? '');
              return (
                <motion.li
                  key={e.id}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: Math.min(i * 0.01, 0.2) }}
                  className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 text-xs ${critical ? 'border-red-200 bg-red-50' : 'border-slate-100'}`}
                >
                  <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${critical ? 'bg-red-100 text-red-700' : k.tone}`}>
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-slate-800">
                      {k.label}
                      {critical && <span className="ml-1.5 rounded bg-red-600 px-1 text-[9px] font-bold uppercase text-white">grupo privilegiado</span>}
                    </span>
                    <span className="block truncate text-slate-600">{describe(e)}</span>
                  </span>
                  <span className="shrink-0 text-[10px] text-slate-400">{new Date(e.at).toLocaleString('es-ES')}</span>
                </motion.li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <p className="mb-3 flex items-center gap-1.5 text-xs font-semibold text-slate-800">
          <LogIn className="h-4 w-4 text-slate-400" />
          Inicios de sesión en tiempo real (por red / gateway)
        </p>
        {logons.data === null ? (
          <p className="text-xs text-slate-400">Cargando...</p>
        ) : logons.data.length === 0 ? (
          <p className="text-xs text-slate-400">Sin inicios de sesión registrados todavía.</p>
        ) : (
          <div className="max-h-[620px] space-y-2 overflow-y-auto pr-1">
            {logonGroups.map((g) => (
              <NetworkGroup key={g.key} label={g.label} gateway={g.gateway} servers={g.servers} count={g.rows.length} defaultOpen={logonGroups.length <= 2}>
                <table className="w-full min-w-[420px] text-left text-xs sm:min-w-0">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-400">
                      <th className="py-1.5 pr-2 font-medium">Usuario</th>
                      <th className="py-1.5 pr-2 font-medium">Equipo</th>
                      <th className="py-1.5 pr-2 font-medium">IP</th>
                      <th className="py-1.5 font-medium">Cuándo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.rows.map((l) => (
                      <tr key={l.id} className="border-b border-slate-50">
                        <td className="py-1.5 pr-2 font-medium text-slate-700">
                          {l.username}
                          {l.kind === 'activity' && <span className="ml-1 text-[10px] font-normal text-slate-400">(actividad)</span>}
                        </td>
                        <td className="py-1.5 pr-2 text-slate-600">{l.hostname ?? '—'}</td>
                        <td className="py-1.5 pr-2 font-mono text-[11px] text-slate-500">{l.ipAddress}</td>
                        <td className="py-1.5 text-[11px] text-slate-400">{new Date(l.at).toLocaleString('es-ES')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </NetworkGroup>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
