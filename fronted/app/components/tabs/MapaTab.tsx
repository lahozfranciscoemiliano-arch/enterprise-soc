'use client';

import dynamic from 'next/dynamic';
import type { ServerSummary } from '../../types';

// Leaflet toca `window` apenas se importa, asi que el mapa en si nunca debe
// intentar renderizarse en el servidor (Next.js SSR/build) -- solo en el
// navegador, despues de hidratar.
const MapaTabInner = dynamic(() => import('./MapaTabInner'), { ssr: false });

export default function MapaTab({ servers }: { servers: ServerSummary[] }) {
  const located = servers.filter((s) => s.latitude !== null && s.longitude !== null);

  return (
    <div className="animate-fade-in space-y-4 px-6 py-6">
      <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">
        <h2 className="mb-1 text-sm font-semibold text-gray-200">🗺️ Mapa de sucursales</h2>
        <p className="mb-4 text-[11px] text-gray-500">
          {located.length} de {servers.length} servidor(es) con coordenadas cargadas. Se configuran en Admin →
          Servidores → Configurar → Info del sitio.
        </p>
        {located.length === 0 ? (
          <p className="py-12 text-center text-sm text-gray-500">
            Ningún servidor tiene coordenadas todavía. Cargalas desde Admin → Servidores → Configurar.
          </p>
        ) : (
          <MapaTabInner servers={servers} />
        )}
      </div>
    </div>
  );
}
