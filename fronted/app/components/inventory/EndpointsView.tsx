'use client';

import { Fragment, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, Laptop, Monitor, Search, Server, UserRound } from 'lucide-react';
import { timeAgo } from '../../lib/health';
import { API_URL, useLiveData } from './useLiveData';
import type { InventoryEndpoint, LogonRecord } from '../../types';

type Filter = 'all' | 'online' | 'offline' | 'stale' | 'servers';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'Todos' },
  { id: 'online', label: 'Encendidos' },
  { id: 'offline', label: 'Apagados' },
  { id: 'stale', label: 'Inactivos +60 días' },
  { id: 'servers', label: 'Servidores' },
];

const STALE_MS = 60 * 86400000;

function isServer(e: InventoryEndpoint) {
  return /server/i.test(e.os ?? '');
}

function isStale(e: InventoryEndpoint) {
  return !e.adLastLogonAt || Date.now() - new Date(e.adLastLogonAt).getTime() > STALE_MS;
}

function deviceIcon(e: InventoryEndpoint) {
  if (isServer(e)) return Server;
  if (/laptop|notebook|nb-|lt-/i.test(`${e.hostname} ${e.description ?? ''}`)) return Laptop;
  return Monitor;
}

export default function EndpointsView() {
  const { data, error } = useLiveData<InventoryEndpoint[]>('/api/inventory/endpoints');
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [history, setHistory] = useState<Record<string, LogonRecord[] | 'loading'>>({});

  const endpoints = data ?? [];
  const counts = useMemo(
    () => ({
      all: endpoints.length,
      online: endpoints.filter((e) => e.online).length,
      offline: endpoints.filter((e) => !e.online).length,
      stale: endpoints.filter((e) => e.enabled !== false && isStale(e)).length,
      servers: endpoints.filter(isServer).length,
    }),
    [endpoints]
  );

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return endpoints
      .filter((e) => {
        if (filter === 'online') return e.online;
        if (filter === 'offline') return !e.online;
        if (filter === 'stale') return e.enabled !== false && isStale(e);
        if (filter === 'servers') return isServer(e);
        return true;
      })
      .filter((e) => !q || [e.hostname, e.ipAddress, e.macAddress, e.lastUser, e.os, e.ou].some((v) => v?.toLowerCase().includes(q)))
      .sort((a, b) => Number(b.online) - Number(a.online) || a.hostname.localeCompare(b.hostname));
  }, [endpoints, filter, search]);

  const toggle = async (e: InventoryEndpoint) => {
    setOpenId((prev) => (prev === e.id ? null : e.id));
    if (history[e.id]) return;
    setHistory((h) => ({ ...h, [e.id]: 'loading' }));
    try {
      const res = await fetch(`${API_URL}/api/inventory/endpoints/${e.id}/logons`, { credentials: 'include' });
      const list: LogonRecord[] = res.ok ? await res.json() : [];
      setHistory((h) => ({ ...h, [e.id]: list }));
    } catch {
      setHistory((h) => ({ ...h, [e.id]: [] }));
    }
  };

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
              <span className={filter === f.id ? 'text-white/80' : 'text-slate-400'}>{counts[f.id]}</span>
            </button>
          ))}
        </div>
        <div className="relative w-full sm:w-auto">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar equipo, usuario, IP, MAC..."
            className="w-full rounded-lg border border-slate-300 bg-slate-50 py-1.5 pl-8 sm:w-64 pr-3 text-xs text-slate-800 outline-none transition-colors focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10"
          />
        </div>
      </div>

      {error && <p className="mb-2 text-xs text-red-600">{error}</p>}

      {/* Celular: tarjetas */}
      <div className="space-y-2 md:hidden">
        {rows.length === 0 && (
          <p className="py-8 text-center text-sm text-slate-400">{data === null ? 'Cargando...' : 'Sin equipos que coincidan'}</p>
        )}
        {rows.map((e) => {
          const Icon = deviceIcon(e);
          const open = openId === e.id;
          const hist = history[e.id];
          return (
            <div key={e.id} className="rounded-xl border border-slate-200 bg-white">
              <button onClick={() => toggle(e)} className="flex w-full items-start gap-3 p-3 text-left">
                <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${e.online ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}>
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-semibold text-slate-800">{e.hostname}</span>
                    <span className={`flex shrink-0 items-center gap-1 text-[11px] font-medium ${e.online ? 'text-emerald-700' : 'text-slate-400'}`}>
                      <span className={`h-2 w-2 rounded-full ${e.online ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                      {e.online ? 'Encendido' : 'Apagado'}
                    </span>
                  </span>
                  <span className="mt-1 flex items-center gap-1 text-xs text-slate-600">
                    <UserRound className="h-3 w-3 text-slate-400" />
                    {e.lastUser ? (
                      <>
                        <b className="font-medium">{e.lastUser}</b>
                        <span className="text-slate-400">· {timeAgo(e.lastUserAt)}</span>
                      </>
                    ) : (
                      <span className="text-slate-400">sin inicio de sesión registrado</span>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate font-mono text-[11px] text-slate-400">
                    {e.ipAddress ?? 'sin IP'} · {e.os ?? 'SO desconocido'}
                  </span>
                </span>
                <motion.span animate={{ rotate: open ? 180 : 0 }} className="mt-1 text-slate-400">
                  <ChevronDown className="h-4 w-4" />
                </motion.span>
              </button>
              <AnimatePresence initial={false}>
                {open && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                    <div className="space-y-1 border-t border-slate-100 px-3 py-2.5 text-[11px] text-slate-600">
                      <p>MAC: <span className="font-mono">{e.macAddress ?? '—'}</span></p>
                      <p>Último logon en AD: {e.adLastLogonAt ? timeAgo(e.adLastLogonAt) : 'nunca'}</p>
                      <p className="truncate">OU: {e.ou ?? '—'}</p>
                      <p className="pt-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Inicios de sesión</p>
                      {hist === 'loading' || hist === undefined ? (
                        <p className="text-slate-400">Cargando...</p>
                      ) : hist.length === 0 ? (
                        <p className="text-slate-400">Sin registros todavía.</p>
                      ) : (
                        hist.slice(0, 10).map((l) => (
                          <p key={l.id} className="flex justify-between gap-2">
                            <b className="font-medium">{l.username}</b>
                            <span className="text-slate-400">{new Date(l.at).toLocaleString('es-ES')}</span>
                          </p>
                        ))
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>

      {/* Tablet / PC: tabla */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-slate-200 text-slate-400">
              <th className="py-2 pr-3 font-medium">Equipo</th>
              <th className="py-2 pr-3 font-medium">Estado</th>
              <th className="py-2 pr-3 font-medium">Último usuario (AD)</th>
              <th className="py-2 pr-3 font-medium">IP / MAC</th>
              <th className="py-2 pr-3 font-medium">Sistema</th>
              <th className="py-2 pr-3 font-medium">Último logon en AD</th>
              <th className="w-6 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="py-8 text-center text-slate-400">
                  {data === null ? 'Cargando...' : 'Sin equipos que coincidan'}
                </td>
              </tr>
            )}
            {rows.map((e) => {
              const Icon = deviceIcon(e);
              const open = openId === e.id;
              const hist = history[e.id];
              const stale = isStale(e);
              return (
                <Fragment key={e.id}>
                  <tr onClick={() => toggle(e)} className="cursor-pointer border-b border-slate-100 transition-colors hover:bg-slate-50">
                    <td className="py-2 pr-3">
                      <span className="flex items-center gap-2">
                        <span className={`flex h-7 w-7 items-center justify-center rounded-lg ${e.online ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}>
                          <Icon className="h-3.5 w-3.5" />
                        </span>
                        <span>
                          <span className="block font-medium text-slate-800">{e.hostname}</span>
                          {e.description && <span className="block max-w-[14rem] truncate text-[10px] text-slate-400">{e.description}</span>}
                        </span>
                      </span>
                    </td>
                    <td className="py-2 pr-3">
                      <span className={`flex items-center gap-1.5 ${e.online ? 'text-emerald-700' : 'text-slate-500'}`}>
                        <span className={`h-2 w-2 rounded-full ${e.online ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                        {e.online ? 'Encendido' : 'Apagado'}
                      </span>
                      <span className="text-[10px] text-slate-400">
                        {e.online ? `desde ${timeAgo(e.statusChangedAt).replace('hace ', '')}` : e.lastSeenOnlineAt ? `visto ${timeAgo(e.lastSeenOnlineAt)}` : 'nunca visto'}
                      </span>
                    </td>
                    <td className="py-2 pr-3">
                      {e.lastUser ? (
                        <span className="flex items-center gap-1.5">
                          <UserRound className="h-3.5 w-3.5 text-slate-400" />
                          <span>
                            <span className="block font-medium text-slate-700">{e.lastUser}</span>
                            <span className="block text-[10px] text-slate-400">{timeAgo(e.lastUserAt)}</span>
                          </span>
                        </span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 font-mono text-[11px] text-slate-600">
                      {e.ipAddress ?? '—'}
                      <span className="block text-[10px] text-slate-400">{e.macAddress ?? ''}</span>
                    </td>
                    <td className="py-2 pr-3 text-slate-600">
                      {e.os ?? '—'}
                      <span className="block text-[10px] text-slate-400">{e.osVersion ?? ''}</span>
                    </td>
                    <td className="py-2 pr-3">
                      <span className={stale ? 'text-amber-700' : 'text-slate-600'}>{e.adLastLogonAt ? timeAgo(e.adLastLogonAt) : 'nunca'}</span>
                      {e.enabled === false && <span className="ml-1 rounded bg-slate-100 px-1 text-[10px] text-slate-500">deshabilitado</span>}
                    </td>
                    <td className="py-2 text-slate-400">
                      <motion.span animate={{ rotate: open ? 180 : 0 }} className="inline-block">
                        <ChevronDown className="h-3.5 w-3.5" />
                      </motion.span>
                    </td>
                  </tr>
                  <AnimatePresence initial={false}>
                    {open && (
                      <tr className="border-b border-slate-100 bg-slate-50">
                        <td colSpan={7} className="p-0">
                          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                            <div className="grid gap-4 px-4 py-3 md:grid-cols-2">
                              <div className="space-y-1 text-[11px] text-slate-600">
                                <p>
                                  <span className="text-slate-400">Nombre DNS:</span> {e.dnsName ?? '—'}
                                </p>
                                <p>
                                  <span className="text-slate-400">Unidad organizativa:</span> {e.ou ?? '—'}
                                </p>
                                <p>
                                  <span className="text-slate-400">En el AD:</span> {e.inAd ? 'sí' : 'no'} · <span className="text-slate-400">habilitado:</span>{' '}
                                  {e.enabled === false ? 'no' : 'sí'}
                                </p>
                                {stale && (
                                  <p className="text-amber-700">
                                    No inicia sesión en el dominio hace más de 60 días: revisar si sigue en uso o darlo de baja del AD.
                                  </p>
                                )}
                              </div>
                              <div>
                                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Historial de inicios de sesión</p>
                                {hist === 'loading' || hist === undefined ? (
                                  <p className="text-[11px] text-slate-400">Cargando...</p>
                                ) : hist.length === 0 ? (
                                  <p className="text-[11px] text-slate-400">Sin inicios de sesión registrados todavía.</p>
                                ) : (
                                  <ul className="max-h-40 space-y-0.5 overflow-y-auto text-[11px]">
                                    {hist.map((l) => (
                                      <li key={l.id} className="flex justify-between gap-3">
                                        <span className="font-medium text-slate-700">{l.username}</span>
                                        <span className="text-slate-400">
                                          {new Date(l.at).toLocaleString('es-ES')} · {l.ipAddress}
                                        </span>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            </div>
                          </motion.div>
                        </td>
                      </tr>
                    )}
                  </AnimatePresence>
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
