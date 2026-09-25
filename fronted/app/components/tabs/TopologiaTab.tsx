import dynamic from 'next/dynamic';
import type { ServerSummary } from '../../types';

const TopologiaGraph = dynamic(() => import('../TopologiaGraph'), {
  ssr: false,
  loading: () => (
    <div className="flex h-[500px] items-center justify-center text-sm text-slate-400">Cargando mapa de topología...</div>
  ),
});

export default function TopologiaTab({ servers }: { servers: ServerSummary[] }) {
  return (
    <div className="px-6 py-6">
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-800">Mapa de Topología de Red</h2>
          <div className="flex items-center gap-4 text-xs text-slate-500">
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-emerald-500" /> OK
            </span>
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-amber-500" /> Advertencia
            </span>
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-red-500" /> Crítico
            </span>
          </div>
        </div>

        {servers.length === 0 ? (
          <div className="flex h-[500px] items-center justify-center text-sm text-slate-400">
            Sin nodos registrados todavía
          </div>
        ) : (
          <TopologiaGraph servers={servers} />
        )}
      </div>
    </div>
  );
}
