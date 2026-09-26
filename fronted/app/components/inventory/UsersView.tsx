'use client';

import { useMemo, useState } from 'react';
import { KeyRound, Lock, Monitor, Search } from 'lucide-react';
import { timeAgo } from '../../lib/health';
import { useLiveData } from './useLiveData';
import type { DirectoryUserRow } from '../../types';

type Filter = 'all' | 'active' | 'locked' | 'expiring' | 'inactive' | 'disabled';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'Todos' },
  { id: 'active', label: 'Con sesión reciente' },
  { id: 'locked', label: 'Bloqueados' },
  { id: 'expiring', label: 'Contraseña vence ≤ 7 días' },
  { id: 'inactive', label: 'Inactivos +90 días' },
  { id: 'disabled', label: 'Deshabilitados' },
];

const DAY = 86400000;

function daysUntil(iso: string | null) {
  return iso ? Math.ceil((new Date(iso).getTime() - Date.now()) / DAY) : null;
}

function matches(u: DirectoryUserRow, f: Filter) {
  const expiresIn = daysUntil(u.passwordExpiresAt);
  switch (f) {
    case 'active':
      return Boolean(u.lastHostAt && Date.now() - new Date(u.lastHostAt).getTime() < DAY);
    case 'locked':
      return u.lockedOut;
    case 'expiring':
      return u.enabled && !u.neverExpires && expiresIn !== null && expiresIn <= 7;
    case 'inactive':
      return u.enabled && (!u.lastLogonAt || Date.now() - new Date(u.lastLogonAt).getTime() > 90 * DAY);
    case 'disabled':
      return !u.enabled;
    default:
      return true;
  }
}

export default function UsersView() {
  const { data, error } = useLiveData<DirectoryUserRow[]>('/api/inventory/users');
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const users = data ?? [];

  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, users.filter((u) => matches(u, f.id)).length])) as Record<Filter, number>, [users]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users
      .filter((u) => matches(u, filter))
      .filter((u) => !q || [u.sam, u.displayName, u.department, u.title, u.email, u.lastHost].some((v) => v?.toLowerCase().includes(q)))
      .sort((a, b) => Number(b.lockedOut) - Number(a.lockedOut) || (b.lastHostAt ?? '').localeCompare(a.lastHostAt ?? ''));
  }, [users, filter, search]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                filter === f.id ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'
              }`}
            >
              {f.label}
              <span className={filter === f.id ? 'text-white/80' : f.id === 'locked' && counts.locked > 0 ? 'text-red-600' : 'text-slate-400'}>{counts[f.id]}</span>
            </button>
          ))}
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar usuario, nombre, área, equipo..."
            className="w-64 rounded-lg border border-slate-300 bg-slate-50 py-1.5 pl-8 pr-3 text-xs text-slate-800 outline-none transition-colors focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10"
          />
        </div>
      </div>

      {error && <p className="mb-2 text-xs text-red-600">{error}</p>}

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-slate-200 text-slate-400">
              <th className="py-2 pr-3 font-medium">Usuario</th>
              <th className="py-2 pr-3 font-medium">Área / cargo</th>
              <th className="py-2 pr-3 font-medium">Último equipo</th>
              <th className="py-2 pr-3 font-medium">Contraseña</th>
              <th className="py-2 pr-3 font-medium">Último logon (AD)</th>
              <th className="py-2 pr-3 font-medium">Estado</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="py-8 text-center text-slate-400">
                  {data === null ? 'Cargando...' : 'Sin usuarios que coincidan'}
                </td>
              </tr>
            )}
            {rows.map((u) => {
              const expiresIn = daysUntil(u.passwordExpiresAt);
              return (
                <tr key={u.sam} className={`border-b border-slate-100 ${u.lockedOut ? 'bg-red-50/50' : ''}`}>
                  <td className="py-2 pr-3">
                    <span className="block font-medium text-slate-800">{u.displayName ?? u.sam}</span>
                    <span className="block font-mono text-[10px] text-slate-400">{u.sam}</span>
                  </td>
                  <td className="py-2 pr-3 text-slate-600">
                    {u.department ?? '—'}
                    {u.title && <span className="block text-[10px] text-slate-400">{u.title}</span>}
                  </td>
                  <td className="py-2 pr-3">
                    {u.lastHost ? (
                      <span className="flex items-center gap-1.5">
                        <Monitor className="h-3.5 w-3.5 text-slate-400" />
                        <span>
                          <span className="block font-medium text-slate-700">{u.lastHost}</span>
                          <span className="block text-[10px] text-slate-400">
                            {u.lastHostIp} · {timeAgo(u.lastHostAt)}
                          </span>
                        </span>
                      </span>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    {u.neverExpires ? (
                      <span className="text-slate-500">No vence</span>
                    ) : expiresIn === null ? (
                      <span className="text-slate-400">—</span>
                    ) : expiresIn < 0 ? (
                      <span className="flex items-center gap-1 font-medium text-red-700">
                        <KeyRound className="h-3 w-3" /> Vencida
                      </span>
                    ) : (
                      <span className={`flex items-center gap-1 ${expiresIn <= 7 ? 'font-medium text-amber-700' : 'text-slate-600'}`}>
                        <KeyRound className="h-3 w-3" /> vence en {expiresIn} día(s)
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-slate-600">{u.lastLogonAt ? timeAgo(u.lastLogonAt) : 'nunca'}</td>
                  <td className="py-2 pr-3">
                    {u.lockedOut ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700">
                        <Lock className="h-3 w-3" /> Bloqueado
                      </span>
                    ) : u.enabled ? (
                      <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">Activo</span>
                    ) : (
                      <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-500">Deshabilitado</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
