'use client';

import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { motion } from 'framer-motion';
import { MapPin } from 'lucide-react';
import ServerDetailModal from '../ServerDetailModal';
import { HEALTH_STYLES } from '../../lib/health';
import type { SecurityAlert, ServerSummary } from '../../types';

// Leaflet toca `window` apenas se importa, asi que el mapa en si nunca debe
// intentar renderizarse en el servidor (Next.js SSR/build) -- solo en el
// navegador, despues de hidratar.
const MapaTabInner = dynamic(() => import('./MapaTabInner'), { ssr: false });

const HEALTH_ORDER: Record<string, number> = { CRITICAL: 0, WARNING: 1, UNKNOWN: 2, OK: 3 };

export default function MapaTab({ servers, alerts }: { servers: ServerSummary[]; alerts: SecurityAlert[] }) {
  const [focusServerId, setFocusServerId] = useState<string | null>(null);
  const [modalServerId, setModalServerId] = useState<string | null>(null);

  const located = useMemo(
    () =>
      servers
        .filter((s) => s.latitude !== null && s.longitude !== null)
        .sort((a, b) => HEALTH_ORDER[a.healthStatus] - HEALTH_ORDER[b.healthStatus] || a.name.localeCompare(b.name)),
    [servers]
  );

  const modalServer = servers.find((s) => s.id === modalServerId) ?? null;
  const modalAlerts = modalServer ? alerts.filter((a) => a.serverName === modalServer.name).slice(0, 20) : [];

  return (
    <div className="space-y-4 px-3 py-4 sm:px-6 sm:py-6">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_320px]">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
          <h2 className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-slate-800">
            <MapPin className="h-4 w-4 text-slate-400" />
            Mapa de sucursales
          </h2>
          <p className="mb-4 text-[11px] text-slate-400">
            {located.length} de {servers.length} servidor(es) con coordenadas cargadas. Se configuran en Admin →
            Servidores → Configurar → Info del sitio.
          </p>
          {located.length === 0 ? (
            <p className="py-12 text-center text-sm text-slate-400">
              Ningún servidor tiene coordenadas todavía. Cargalas desde Admin → Servidores → Configurar.
            </p>
          ) : (
            <MapaTabInner servers={servers} focusServerId={focusServerId} />
          )}
        </div>

        {located.length > 0 && (
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card xl:max-h-[664px] xl:overflow-y-auto">
            <h3 className="mb-3 text-sm font-semibold text-slate-700">Sucursales ({located.length})</h3>
            <div className="space-y-1.5">
              {located.map((s, i) => {
                const health = HEALTH_STYLES[s.healthStatus];
                const isFocused = focusServerId === s.id;
                return (
                  <motion.button
                    key={s.id}
                    initial={{ opacity: 0, x: 8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: Math.min(i * 0.02, 0.3) }}
                    onClick={() => {
                      setFocusServerId(s.id);
                      setModalServerId(s.id);
                    }}
                    className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
                      isFocused ? 'border-brand-300 bg-brand-50' : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className={`h-2 w-2 shrink-0 rounded-full ${health.dot}`} />
                      <span className="truncate font-medium text-slate-800">{s.name}</span>
                    </span>
                    <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] ${health.badge}`}>{health.label}</span>
                  </motion.button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {modalServer && (
        <ServerDetailModal server={modalServer} alerts={modalAlerts} onClose={() => setModalServerId(null)} />
      )}
    </div>
  );
}
