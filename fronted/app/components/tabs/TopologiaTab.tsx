'use client';

import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { Network, Search } from 'lucide-react';
import ServerDetailModal from '../ServerDetailModal';
import NetworkTopology from '../NetworkTopology';
import type { SecurityAlert, ServerSummary } from '../../types';

const TopologiaGraph = dynamic(() => import('../TopologiaGraph'), {
  ssr: false,
  loading: () => (
    <div className="flex h-[500px] items-center justify-center text-sm text-slate-400">Cargando mapa de topología...</div>
  ),
});

export default function TopologiaTab({ servers, alerts }: { servers: ServerSummary[]; alerts: SecurityAlert[] }) {
  const [search, setSearch] = useState('');
  const [focusServerId, setFocusServerId] = useState<string | null>(null);
  const [modalServerId, setModalServerId] = useState<string | null>(null);
  const [mode, setMode] = useState<'red' | 'servidores'>('red');

  const healthCounts = useMemo(() => {
    const counts = { OK: 0, WARNING: 0, CRITICAL: 0, UNKNOWN: 0 };
    for (const s of servers) counts[s.healthStatus]++;
    return counts;
  }, [servers]);

  const suggestions = useMemo(
    () => (search.trim() ? servers.filter((s) => s.name.toLowerCase().includes(search.toLowerCase())).slice(0, 6) : []),
    [servers, search]
  );

  const modalServer = servers.find((s) => s.id === modalServerId) ?? null;
  const modalAlerts = modalServer ? alerts.filter((a) => a.serverName === modalServer.name).slice(0, 20) : [];

  return (
    <div className="space-y-4 px-3 py-4 sm:px-6 sm:py-6">
      <div className="flex gap-1.5">
        {(
          [
            ['red', 'Red por sede (automática)'],
            ['servidores', 'Grafo de servidores'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setMode(id)}
            className={`rounded-full border px-3 py-1 text-xs font-medium ${mode === id ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === 'red' && <NetworkTopology onServer={setModalServerId} />}
      <div className={`rounded-xl border border-slate-200 bg-white p-4 shadow-card ${mode === 'red' ? 'hidden' : ''}`}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
            <Network className="h-4 w-4 text-slate-400" />
            Mapa de Topología de Red
            <span className="font-normal text-slate-400">(clic en un nodo para ver detalles)</span>
          </h2>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-3 text-xs text-slate-500">
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-emerald-500" /> OK <span className="text-slate-400">{healthCounts.OK}</span>
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-amber-500" /> Advertencia{' '}
                <span className="text-slate-400">{healthCounts.WARNING}</span>
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-red-500" /> Crítico <span className="text-slate-400">{healthCounts.CRITICAL}</span>
              </span>
            </div>

            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                placeholder="Buscar nodo..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-48 rounded-lg border border-slate-300 bg-slate-50 py-1.5 pl-8 pr-3 text-xs text-slate-800 outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10 transition-colors"
              />
              {suggestions.length > 0 && (
                <div className="absolute right-0 top-full z-10 mt-1 w-56 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
                  {suggestions.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => {
                        setFocusServerId(s.id);
                        setSearch('');
                      }}
                      className="flex w-full items-center px-3 py-2 text-left text-xs text-slate-700 hover:bg-slate-50"
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {mode !== 'servidores' ? null : servers.length === 0 ? (
          <div className="flex h-[500px] items-center justify-center text-sm text-slate-400">
            Sin nodos registrados todavía
          </div>
        ) : (
          <TopologiaGraph servers={servers} focusServerId={focusServerId} onSelectNode={setModalServerId} />
        )}
      </div>

      {modalServer && (
        <ServerDetailModal server={modalServer} alerts={modalAlerts} onClose={() => setModalServerId(null)} />
      )}
    </div>
  );
}
