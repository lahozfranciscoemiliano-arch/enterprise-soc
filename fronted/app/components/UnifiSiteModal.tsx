'use client';

import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, Cable, Globe, Router, Search, Signal, Users, Wifi, X, type LucideIcon } from 'lucide-react';
import { timeAgo } from '../lib/health';
import type { UnifiDevice, UnifiSiteRow } from '../types';

const ICON: Record<UnifiDevice['deviceType'], LucideIcon> = { ap: Wifi, switch: Router, gateway: Globe, other: Signal };
const LABEL: Record<UnifiDevice['deviceType'], string> = { ap: 'Access Point', switch: 'Switch', gateway: 'Gateway', other: 'Dispositivo' };
const STATUS_LABEL: Record<string, string> = {
  online: 'Online',
  offline: 'Offline',
  pending_adoption: 'Sin adoptar',
  updating: 'Actualizando',
  provisioning: 'Aprovisionando',
  adopting: 'Adoptando',
  adoption_failed: 'Falló adopción',
  isolated: 'Aislado',
};

function uptime(seconds: number | null): string {
  if (!seconds) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return d > 0 ? `${d} d ${h} h` : `${h} h ${Math.floor((seconds % 3600) / 60)} min`;
}

function pct(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : `${Math.round(v)}%`;
}

function Kpi({ label, value, tone = 'text-slate-800' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
      <p className="text-[10px] uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`text-sm font-semibold tabular-nums ${tone}`}>{value}</p>
    </div>
  );
}

/** Detalle completo de un sitio UniFi: salud + cada equipo leído del controlador local. */
export default function UnifiSiteModal({ site, devices, onClose }: { site: UnifiSiteRow; devices: UnifiDevice[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [type, setType] = useState<'all' | UnifiDevice['deviceType'] | 'offline'>('all');
  const health = site.health ?? {};
  const wan = health.wan ?? health.www;
  const www = health.www;

  const list = useMemo(() => {
    const s = q.toLowerCase();
    return devices
      .filter((d) => (type === 'all' ? true : type === 'offline' ? d.status !== 'online' : d.deviceType === type))
      .filter((d) => !s || [d.name, d.model, d.ipAddress, d.id, d.details?.uplink?.device].some((v) => v?.toLowerCase().includes(s)))
      .sort(
        (a, b) =>
          Number(a.status === 'online') - Number(b.status === 'online') ||
          ['gateway', 'switch', 'ap', 'other'].indexOf(a.deviceType) - ['gateway', 'switch', 'ap', 'other'].indexOf(b.deviceType) ||
          a.name.localeCompare(b.name)
      );
  }, [devices, q, type]);

  const label = site.siteName ? `${site.hostName} · ${site.siteName}` : site.hostName;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-0 backdrop-blur-sm sm:items-center sm:p-4"
        onClick={onClose}
      >
        <motion.div
          initial={{ y: 24, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 24, opacity: 0 }}
          onClick={(e) => e.stopPropagation()}
          className="flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-t-2xl bg-slate-50 shadow-2xl sm:rounded-2xl"
        >
          <div className="flex items-start justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3">
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold text-slate-900">{label}</h2>
              <p className="truncate text-[11px] text-slate-400">
                Network {site.version ?? '—'}
                {site.controllerUrl ? ` · ${site.controllerUrl}` : site.lanIps?.length ? ` · ${site.lanIps.join(', ')}` : ''}
                {site.localAt ? ` · leído por ${site.localSource} ${timeAgo(site.localAt)}` : ' · solo resumen de la nube'}
              </p>
            </div>
            <button onClick={onClose} className="rounded-lg border border-slate-200 p-2 text-slate-500 hover:bg-slate-100" aria-label="Cerrar">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-3 overflow-y-auto p-4">
            {site.localError && (
              <p className="flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                No se pudo leer el controlador local{site.localSource ? ` desde ${site.localSource}` : ''}: {site.localError}
              </p>
            )}

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
              <Kpi label="APs online" value={site.wifiDevices ? `${site.wifiDevices - site.offlineWifi}/${site.wifiDevices}` : '—'} tone={site.offlineWifi ? 'text-red-700' : undefined} />
              <Kpi label="Switches" value={site.wiredDevices ? `${site.wiredDevices - site.offlineWired}/${site.wiredDevices}` : '—'} tone={site.offlineWired ? 'text-red-700' : undefined} />
              <Kpi label="Gateways" value={site.gatewayDevices ? `${site.gatewayDevices - site.offlineGateways}/${site.gatewayDevices}` : '—'} tone={site.offlineGateways ? 'text-red-700' : undefined} />
              <Kpi label="Clientes WiFi" value={String(site.wifiClients)} />
              <Kpi label="Clientes cable" value={String(site.wiredClients)} />
              <Kpi label="Invitados" value={String(site.guestClients)} />
              <Kpi label="Firmware pendiente" value={String(site.pendingUpdates)} tone={site.pendingUpdates ? 'text-amber-700' : undefined} />
              <Kpi
                label="Internet"
                value={www?.latencyMs !== null && www?.latencyMs !== undefined ? `${www.latencyMs} ms` : wan?.status ? wan.status.toUpperCase() : '—'}
              />
            </div>

            {(wan?.isp || wan?.wanIp || www?.downMbps) && (
              <p className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500">
                {wan?.isp && <span>ISP: {wan.isp}</span>}
                {wan?.wanIp && <span className="font-mono">WAN {wan.wanIp}</span>}
                {www?.downMbps ? <span>Velocidad medida: ↓ {www.downMbps} / ↑ {www.upMbps ?? '—'} Mbps</span> : null}
                {www?.uptimeSeconds ? <span>Internet arriba {uptime(www.uptimeSeconds)}</span> : null}
              </p>
            )}

            {devices.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-center text-xs text-slate-500">
                Todavía no hay detalle de equipos de este sitio. Lo trae el agente de la sucursal cuando puede entrar al controlador local
                (Admin → Configuración → Ubiquiti UniFi → cuenta de solo lectura).
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {(
                      [
                        ['all', `Todos ${devices.length}`],
                        ['ap', `APs ${devices.filter((d) => d.deviceType === 'ap').length}`],
                        ['switch', `Switches ${devices.filter((d) => d.deviceType === 'switch').length}`],
                        ['gateway', `Gateways ${devices.filter((d) => d.deviceType === 'gateway').length}`],
                        ['offline', `Con problemas ${devices.filter((d) => d.status !== 'online').length}`],
                      ] as const
                    ).map(([id, text]) => (
                      <button
                        key={id}
                        onClick={() => setType(id)}
                        className={`rounded-full border px-2.5 py-0.5 text-[11px] ${type === id ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}
                      >
                        {text}
                      </button>
                    ))}
                  </div>
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                    <input
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      placeholder="Buscar equipo, IP, MAC..."
                      className="rounded-lg border border-slate-300 bg-slate-50 py-1 pl-7 pr-2 text-xs outline-none focus:border-brand-500"
                    />
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1000px] text-[11px]">
                    <thead>
                      <tr className="border-b border-slate-100 text-left text-slate-400">
                        <th className="px-3 py-2 font-medium">Equipo</th>
                        <th className="px-3 py-2 font-medium">Estado</th>
                        <th className="px-3 py-2 font-medium">IP / MAC</th>
                        <th className="px-3 py-2 font-medium">Clientes</th>
                        <th className="px-3 py-2 font-medium">Radios / Puertos</th>
                        <th className="px-3 py-2 font-medium">Experiencia</th>
                        <th className="px-3 py-2 font-medium">CPU / RAM</th>
                        <th className="px-3 py-2 font-medium">Uplink</th>
                        <th className="px-3 py-2 font-medium">Firmware</th>
                        <th className="px-3 py-2 font-medium">Encendido</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((d) => {
                        const Icon = ICON[d.deviceType];
                        const x = d.details ?? {};
                        const online = d.status === 'online';
                        return (
                          <tr key={d.id} className={`border-b border-slate-100 last:border-0 ${online ? '' : 'bg-red-50/50'}`}>
                            <td className="px-3 py-2">
                              <div className="flex items-center gap-2">
                                <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${online ? 'bg-sky-50 text-sky-600' : 'bg-red-50 text-red-600'}`}>
                                  <Icon className="h-3.5 w-3.5" />
                                </span>
                                <div className="min-w-0">
                                  <p className="truncate font-semibold text-slate-800">{d.name}</p>
                                  <p className="truncate text-[10px] text-slate-400">
                                    {LABEL[d.deviceType]} · {d.model ?? '—'}
                                  </p>
                                </div>
                              </div>
                            </td>
                            <td className="px-3 py-2">
                              <span className={`font-medium ${online ? 'text-emerald-600' : 'text-red-600'}`}>{STATUS_LABEL[d.status] ?? d.status}</span>
                              {!online && <p className="text-[10px] text-red-500">desde {timeAgo(d.statusChangedAt)}</p>}
                            </td>
                            <td className="px-3 py-2 font-mono text-[10px] text-slate-500">
                              <p>{d.ipAddress ?? '—'}</p>
                              <p className="text-slate-400">{x.mac ?? d.id}</p>
                            </td>
                            <td className="px-3 py-2">
                              {d.clients !== null ? (
                                <span className="flex items-center gap-1 text-slate-700">
                                  <Users className="h-3 w-3 text-slate-400" />
                                  {d.clients}
                                  {x.guestClients ? <span className="text-slate-400">({x.guestClients} inv.)</span> : null}
                                </span>
                              ) : (
                                '—'
                              )}
                            </td>
                            <td className="px-3 py-2 text-slate-600">
                              {x.radios && x.radios.length > 0
                                ? x.radios.map((r) => (
                                    <p key={r.band} className="whitespace-nowrap">
                                      {r.band} · canal {r.channel ?? '—'} · {r.clients ?? 0} cli.
                                      {r.utilization !== null ? <span className={r.utilization >= 70 ? 'text-amber-600' : 'text-slate-400'}> · uso {r.utilization}%</span> : null}
                                    </p>
                                  ))
                                : x.ports
                                  ? (
                                    <span className="flex items-center gap-1">
                                      <Cable className="h-3 w-3 text-slate-400" />
                                      {x.ports.up}/{x.ports.total} puertos
                                      {x.ports.poeWatts ? ` · PoE ${Math.round(x.ports.poeWatts)} W` : ''}
                                    </span>
                                  )
                                  : '—'}
                            </td>
                            <td className={`px-3 py-2 ${(x.satisfaction ?? 100) < 70 ? 'text-amber-600' : 'text-slate-600'}`}>{pct(x.satisfaction)}</td>
                            <td className="px-3 py-2 text-slate-600">
                              {pct(x.cpu)} / {pct(x.mem)}
                              {x.tempC ? <span className="text-slate-400"> · {x.tempC}°C</span> : null}
                            </td>
                            <td className="px-3 py-2 text-slate-600">
                              {x.uplink ? (
                                <>
                                  <p className="truncate">{x.uplink.type === 'wireless' ? 'Mesh (inalámbrico)' : x.uplink.device ?? 'Cable'}</p>
                                  <p className="text-[10px] text-slate-400">
                                    {x.uplink.port ? `puerto ${x.uplink.port}` : ''}
                                    {x.uplink.speed ? ` · ${x.uplink.speed >= 1000 ? `${x.uplink.speed / 1000} Gbps` : `${x.uplink.speed} Mbps`}` : ''}
                                    {x.uplink.speed && x.uplink.speed < 1000 && x.uplink.type !== 'wireless' ? <span className="text-amber-600"> (lento)</span> : null}
                                  </p>
                                </>
                              ) : (
                                '—'
                              )}
                            </td>
                            <td className="px-3 py-2 text-slate-600">
                              <p>{d.firmwareVersion ?? '—'}</p>
                              {d.firmwareStatus === 'updateAvailable' && <p className="text-[10px] text-amber-600">→ {x.upgradeTo ?? 'actualización disponible'}</p>}
                            </td>
                            <td className="px-3 py-2 text-slate-600">{online ? uptime(d.uptimeSeconds) : x.lastSeenAt ? `visto ${timeAgo(x.lastSeenAt)}` : '—'}</td>
                          </tr>
                        );
                      })}
                      {list.length === 0 && (
                        <tr>
                          <td colSpan={10} className="px-3 py-6 text-center text-slate-400">
                            Sin equipos que coincidan
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
