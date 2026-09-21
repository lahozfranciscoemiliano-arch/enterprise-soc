import dynamic from 'next/dynamic';
import type { ServerSummary } from '../../types';

const TopologiaGraph = dynamic(() => import('../TopologiaGraph'), {
  ssr: false,
  loading: () => (
    <div className="flex h-[500px] items-center justify-center text-sm text-gray-500">Cargando mapa de topología...</div>
  ),
});

export default function TopologiaTab({ servers }: { servers: ServerSummary[] }) {
  return (
    <div className="animate-fade-in px-6 py-6">
      <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-gray-200">Mapa de Topología de Red</h2>
          <div className="flex items-center gap-4 text-xs text-gray-400">
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
          <div className="flex h-[500px] items-center justify-center text-sm text-gray-500">
            Sin nodos registrados todavía
          </div>
        ) : (
          <TopologiaGraph servers={servers} />
        )}
      </div>
    </div>
  );
}
