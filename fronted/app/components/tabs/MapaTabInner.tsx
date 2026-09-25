'use client';

import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { ServerSummary } from '../../types';

const STATUS_COLOR: Record<string, string> = {
  OK: '#10b981',
  WARNING: '#f59e0b',
  CRITICAL: '#ef4444',
  UNKNOWN: '#475569',
};

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

const DEFAULT_CENTER: [number, number] = [-34.55, -58.6];

export default function MapaTabInner({ servers }: { servers: ServerSummary[] }) {
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

      const popupHtml = `
        <div style="font-size:12px;min-width:180px">
          <p style="font-weight:600;margin-bottom:4px">${s.name}</p>
          <p>Salud: <strong>${s.healthStatus}</strong> · Estado: <strong>${s.status}</strong></p>
          ${s.cpuUsage !== null ? `<p>CPU ${s.cpuUsage.toFixed(0)}% · RAM ${s.memoryUsage?.toFixed(0)}% · Disco ${s.diskUsage?.toFixed(0)}%</p>` : ''}
          ${s.ispPrimaryName ? `<p>ISP primario: ${s.ispPrimaryName}</p>` : ''}
          ${s.ispSecondaryName ? `<p>ISP secundario: ${s.ispSecondaryName}</p>` : ''}
          ${s.hasFortinet !== null ? `<p>Fortinet propio: ${s.hasFortinet ? 'Sí' : 'No'}</p>` : ''}
          ${s.siteContactName ? `<p>Contacto: ${s.siteContactName}${s.siteContactPhone ? ` (${s.siteContactPhone})` : ''}</p>` : ''}
        </div>`;

      const existing = markersRef.current.get(s.id);
      if (existing) {
        existing.setLatLng([lat, lng]);
        existing.setStyle({ color, fillColor: color });
        existing.setPopupContent(popupHtml);
      } else {
        const marker = L.circleMarker([lat, lng], {
          radius: 9,
          color: '#ffffff',
          weight: 2,
          fillColor: color,
          fillOpacity: 1,
        })
          .addTo(map)
          .bindPopup(popupHtml);
        markersRef.current.set(s.id, marker);
      }
    }

    for (const [id, marker] of markersRef.current) {
      if (!seenIds.has(id)) {
        marker.remove();
        markersRef.current.delete(id);
      }
    }

    if (located.length > 0) {
      const bounds = L.latLngBounds(located.map((s) => [s.latitude as number, s.longitude as number]));
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 13 });
    }
  }, [servers]);

  return <div ref={containerRef} className="h-[600px] w-full overflow-hidden rounded-xl border border-gray-800" />;
}
