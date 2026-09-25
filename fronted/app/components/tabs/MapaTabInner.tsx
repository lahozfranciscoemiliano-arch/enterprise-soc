'use client';

import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { ServerSummary } from '../../types';

const STATUS_COLOR: Record<string, string> = {
  OK: '#10b981',
  WARNING: '#f59e0b',
  CRITICAL: '#ef4444',
  UNKNOWN: '#94a3b8',
};

const HEALTH_BADGE: Record<string, string> = {
  OK: 'background:#ecfdf5;color:#047857;border-color:#a7f3d0',
  WARNING: 'background:#fffbeb;color:#b45309;border-color:#fde68a',
  CRITICAL: 'background:#fef2f2;color:#b91c1c;border-color:#fecaca',
  UNKNOWN: 'background:#f1f5f9;color:#64748b;border-color:#e2e8f0',
};

const HEALTH_LABEL: Record<string, string> = { OK: 'OK', WARNING: 'ADVERTENCIA', CRITICAL: 'CRÍTICO', UNKNOWN: 'SIN DATOS' };

// Leaflet puro (no react-leaflet): react-leaflet@4 + React 18 Strict Mode
// (Next.js dev monta/desmonta cada componente dos veces a proposito para
// detectar bugs) dispara "Map container is already initialized" porque
// Leaflet guarda estado en el nodo del DOM que react-leaflet no limpia bien
// entre esos dos montajes. Manejando el mapa a mano con useRef + useEffect
// se controla el ciclo de vida completo (incluido el cleanup real con
// map.remove()), evitando la clase entera de bug.
function healthColor(healthStatus: string) {
  return STATUS_COLOR[healthStatus] ?? STATUS_COLOR.UNKNOWN;
}

function popupHtml(s: ServerSummary): string {
  const badgeStyle = HEALTH_BADGE[s.healthStatus] ?? HEALTH_BADGE.UNKNOWN;
  const label = HEALTH_LABEL[s.healthStatus] ?? 'SIN DATOS';
  return `
    <div style="font-family:var(--font-inter),system-ui,sans-serif;font-size:12px;min-width:200px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px">
        <p style="font-weight:600;color:#0f172a;margin:0">${s.name}</p>
        <span style="border:1px solid;border-radius:9999px;padding:1px 8px;font-size:10px;font-weight:600;${badgeStyle}">${label}</span>
      </div>
      <p style="color:#475569;margin:2px 0">Estado de conexión: <strong>${s.status}</strong></p>
      ${
        s.cpuUsage !== null
          ? `<p style="color:#475569;margin:2px 0">CPU ${s.cpuUsage.toFixed(0)}% · RAM ${s.memoryUsage?.toFixed(0)}% · Disco ${s.diskUsage?.toFixed(0)}%</p>`
          : '<p style="color:#94a3b8;margin:2px 0">Sin telemetría</p>'
      }
      ${s.ispPrimaryName ? `<p style="color:#475569;margin:2px 0">ISP primario: ${s.ispPrimaryName}</p>` : ''}
      ${s.ispSecondaryName ? `<p style="color:#475569;margin:2px 0">ISP secundario: ${s.ispSecondaryName}</p>` : ''}
      ${s.hasFortinet !== null ? `<p style="color:#475569;margin:2px 0">Fortinet propio: ${s.hasFortinet ? 'Sí' : 'No'}</p>` : ''}
      ${s.siteContactName ? `<p style="color:#475569;margin:2px 0">Contacto: ${s.siteContactName}${s.siteContactPhone ? ` (${s.siteContactPhone})` : ''}</p>` : ''}
    </div>`;
}

const DEFAULT_CENTER: [number, number] = [-34.55, -58.6];

export default function MapaTabInner({
  servers,
  focusServerId,
}: {
  servers: ServerSummary[];
  focusServerId?: string | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<Map<string, L.CircleMarker>>(new Map());

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, { center: DEFAULT_CENTER, zoom: 9 });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      markersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const located = servers.filter((s) => s.latitude !== null && s.longitude !== null);
    const seenIds = new Set<string>();

    for (const s of located) {
      seenIds.add(s.id);
      const lat = s.latitude as number;
      const lng = s.longitude as number;
      const color = healthColor(s.healthStatus);

      const existing = markersRef.current.get(s.id);
      if (existing) {
        existing.setLatLng([lat, lng]);
        existing.setStyle({ color, fillColor: color });
        existing.setPopupContent(popupHtml(s));
      } else {
        const marker = L.circleMarker([lat, lng], {
          radius: 9,
          color: '#ffffff',
          weight: 2,
          fillColor: color,
          fillOpacity: 1,
        })
          .addTo(map)
          .bindPopup(popupHtml(s));
        markersRef.current.set(s.id, marker);
      }
    }

    for (const [id, marker] of markersRef.current) {
      if (!seenIds.has(id)) {
        marker.remove();
        markersRef.current.delete(id);
      }
    }

    if (!focusServerId && located.length > 0) {
      const bounds = L.latLngBounds(located.map((s) => [s.latitude as number, s.longitude as number]));
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 13 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [servers]);

  // Centra el mapa y abre el popup del servidor elegido en la lista lateral
  // -- separado del efecto de arriba para no re-disparar el fitBounds
  // general cada vez que se selecciona uno.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focusServerId) return;
    const marker = markersRef.current.get(focusServerId);
    if (!marker) return;
    map.flyTo(marker.getLatLng(), Math.max(map.getZoom(), 13), { duration: 0.6 });
    marker.openPopup();
  }, [focusServerId]);

  return <div ref={containerRef} className="h-[600px] w-full overflow-hidden rounded-xl border border-slate-200" />;
}
