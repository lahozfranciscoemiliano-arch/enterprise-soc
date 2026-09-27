'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  Clock,
  Globe,
  type LucideIcon,
  RefreshCw,
  Router,
  Search,
  Server,
  Signal,
  Users,
  Wifi,
  WifiOff,
} from 'lucide-react';
import StatCard from '../StatCard';
import AlertRepeatInfo from '../AlertRepeatInfo';
import ServiceMonitorsPanel from '../ServiceMonitorsPanel';
import { formatUptime, internetLevel, ISP_LABEL, RESOURCE_LEVEL_COLOR, SEVERITY_STYLES, timeAgo } from '../../lib/health';
import type { NetworkOverview, ServerSummary, UnifiDevice, UnifiSiteRow } from '../../types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

type DeviceFilter = 'all' | 'ap' | 'switch' | 'gateway' | 'offline';

const DEVICE_FILTERS: { id: DeviceFilter; label: string }[] = [
  { id: 'all', label: 'Todos' },
  { id: 'ap', label: 'Access Points' },
  { id: 'switch', label: 'Switches' },
  { id: 'gateway', label: 'Gateways' },
  { id: 'offline', label: 'Caídos' },
];

const DEVICE_ICON: Record<UnifiDevice['deviceType'], LucideIcon> = { ap: Wifi, switch: Router, gateway: Globe, other: Signal };
const DEVICE_LABEL: Record<UnifiDevice['deviceType'], string> = { ap: 'Access Point', switch: 'Switch', gateway: 'Gateway', other: 'Dispositivo' };

function statusStyle(status: string) {
  if (status === 'online') return { dot: 'bg-emerald-500', text: 'text-emerald-700', label: 'Online', card: 'border-slate-200' };
  if (status === 'offline') return { dot: 'bg-red-500 animate-pulse', text: 'text-red-700', label: 'Caído', card: 'border-red-200 bg-red-50/40' };
  return { dot: 'bg-amber-500', text: 'text-amber-700', label: status.replace(/_/g, ' '), card: 'border-amber-200' };
}

const LEVEL_ORDER = { critical: 0, warning: 1, none: 2, ok: 3 } as const;

export default function RedTab({ servers, isAdmin }: { servers: ServerSummary[]; isAdmin: boolean }) {
  const [overview, setOverview] = useState<NetworkOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [deviceFilter, setDeviceFilter] = useState<DeviceFilter>('all');
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/network/overview`, { credentials: 'include' });
      if (!res.ok) throw new Error('No se pudo cargar el estado de red');
      setOverview(await res.json());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => !document.hidden && load(), 60_000);
    // El backend avisa por WebSocket cada vez que termina un sondeo UniFi.
    const onUnifi = () => load();
    window.addEventListener('soc:unifi', onUnifi);
    return () => {
      clearInterval(t);
      window.removeEventListener('soc:unifi', onUnifi);
    };
  }, [load]);

  // El estado de internet de cada sitio llega en vivo por WebSocket
  // (servers[].network); el overview aporta los datos de CMDB.
  const sites = useMemo(() => {
    const byId = new Map(servers.map((s) => [s.id, s]));
    const base: NetworkOverview['sites'] =
      overview?.sites ??
      servers.map((s) => ({
        serverId: s.id,
        serverName: s.name,
        status: s.status,
        lastSeenAt: s.lastSeenAt,
        ispPrimaryName: s.ispPrimaryName,
        ispSecondaryName: s.ispSecondaryName,
        ispPrimaryPublicIp: s.ispPrimaryPublicIp ?? null,
        ispSecondaryPublicIp: s.ispSecondaryPublicIp ?? null,
        network: s.network ?? null,
      }));
    return base
      .map((site) => {
        const live = byId.get(site.serverId);
        const network = live?.network ?? site.network;
        return { ...site, status: live?.status ?? site.status, network, level: internetLevel(network) };
      })
      .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.serverName.localeCompare(b.serverName));
  }, [overview, servers]);

  const siteStats = useMemo(() => {
    const measured = sites.filter((s) => s.network);
    return {
      measured: measured.length,
      ok: measured.filter((s) => s.level === 'ok').length,
      degraded: measured.filter((s) => s.level === 'warning').length,
      down: measured.filter((s) => s.level === 'critical').length,
      backupLink: measured.filter((s) => s.network?.activeIsp === 'secondary').length,
    };
  }, [sites]);

  const devices = overview?.unifi.devices ?? [];
  const unifiSites = overview?.unifi.sites ?? [];
  const lastRun = overview?.unifi.lastRun ?? null;
  // Con controladores autoalojados no hay lista de equipos: los totales
  // salen de los contadores de cada sitio.
  const bySites = devices.length === 0 && unifiSites.length > 0;
  const deviceStats = useMemo(
    () =>
      bySites
        ? {
            aps: unifiSites.reduce((a, s) => a + s.wifiDevices, 0),
            apsOnline: unifiSites.reduce((a, s) => a + s.wifiDevices - s.offlineWifi, 0),
            offline: unifiSites.reduce((a, s) => a + s.offlineDevices, 0),
            clients: unifiSites.reduce((a, s) => a + s.wifiClients, 0),
          }
        : {
            aps: devices.filter((d) => d.deviceType === 'ap').length,
            apsOnline: devices.filter((d) => d.deviceType === 'ap' && d.status === 'online').length,
            offline: devices.filter((d) => d.status === 'offline').length,
            clients: devices.reduce((sum, d) => sum + (d.clients ?? 0), 0),
          },
    [devices, unifiSites, bySites]
  );
  const sortedSites = useMemo(() => {
    const q = search.toLowerCase();
    const rank = (s: UnifiSiteRow) => (s.hostOnline === false ? 0 : s.offlineDevices > 0 ? 1 : 2);
    return unifiSites
      .filter((s) => !q || [s.hostName, s.siteName, s.ispName].some((v) => v?.toLowerCase().includes(q)))
      .filter((s) => deviceFilter !== 'offline' || s.hostOnline === false || s.offlineDevices > 0)
      .sort((a, b) => rank(a) - rank(b) || a.hostName.localeCompare(b.hostName));
  }, [unifiSites, search, deviceFilter]);

  const filteredDevices = useMemo(() => {
    const q = search.toLowerCase();
    return devices
      .filter((d) => (deviceFilter === 'all' ? true : deviceFilter === 'offline' ? d.status === 'offline' : d.deviceType === deviceFilter))
      .filter((d) => !q || [d.name, d.model, d.siteName, d.ipAddress, d.id].some((v) => v?.toLowerCase().includes(q)))
      .sort((a, b) => Number(a.status === 'online') - Number(b.status === 'online') || (a.siteName ?? '').localeCompare(b.siteName ?? '') || a.name.localeCompare(b.name));
  }, [devices, deviceFilter, search]);

  return (
    <div className="space-y-4 px-3 py-4 sm:px-6 sm:py-6">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
        <StatCard label="Sitios con internet OK" value={`${siteStats.ok}/${siteStats.measured}`} color="emerald" icon={<Globe className="h-5 w-5" />} />
        <StatCard label="Internet degradado" value={siteStats.degraded.toString()} color={siteStats.degraded > 0 ? 'amber' : 'emerald'} icon={<Signal className="h-5 w-5" />} />
        <StatCard label="Sin internet" value={siteStats.down.toString()} color={siteStats.down > 0 ? 'red' : 'emerald'} icon={<WifiOff className="h-5 w-5" />} />
        <StatCard
          label="En enlace de respaldo"
          value={siteStats.backupLink.toString()}
          color={siteStats.backupLink > 0 ? 'amber' : 'emerald'}
          icon={<ArrowRightLeft className="h-5 w-5" />}
        />
        <StatCard
          label="Access Points online"
          value={deviceStats.aps > 0 ? `${deviceStats.apsOnline}/${deviceStats.aps}` : '—'}
          color={deviceStats.offline > 0 ? 'red' : 'blue'}
          icon={<Wifi className="h-5 w-5" />}
        />
      </div>

      {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
            <Globe className="h-4 w-4 text-slate-400" />
            Internet por sitio
            <span className="font-normal text-slate-400">(medido por el agente desde adentro de cada sucursal, cada minuto)</span>
          </h2>
          <button
            onClick={load}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1 text-xs text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Actualizar
          </button>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {sites.map((site, i) => {
            const n = site.network;
            const color = site.level === 'none' ? null : RESOURCE_LEVEL_COLOR[site.level];
            const isp = n ? ISP_LABEL[n.activeIsp] : null;
            return (
              <motion.div
                key={site.serverId}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(i * 0.02, 0.3) }}
                className={`rounded-xl border p-3 ${site.level === 'critical' ? 'border-red-200 bg-red-50/40' : site.level === 'warning' ? 'border-amber-200 bg-amber-50/30' : 'border-slate-200'}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-slate-800">
                    <Server className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                    <span className="truncate">{site.serverName}</span>
                  </span>
                  <span className={`flex items-center gap-1 text-xs font-semibold ${color?.text ?? 'text-slate-400'}`}>
                    <span className={`h-2 w-2 rounded-full ${color?.bar ?? 'bg-slate-300'} ${site.level === 'critical' ? 'animate-pulse' : ''}`} />
                    {!n ? 'Sin datos' : n.internetUp === false ? 'SIN INTERNET' : site.level === 'warning' ? 'Degradado' : 'OK'}
                  </span>
                </div>

                {n ? (
                  <>
                    <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                      <div className="rounded-lg bg-slate-50 py-1.5">
                        <p className="text-sm font-semibold tabular-nums text-slate-800">{n.latencyMs !== null ? `${n.latencyMs.toFixed(0)}` : '—'}</p>
                        <p className="text-[10px] text-slate-400">ms latencia</p>
                      </div>
                      <div className="rounded-lg bg-slate-50 py-1.5">
                        <p className={`text-sm font-semibold tabular-nums ${(n.lossPct ?? 0) >= 10 ? 'text-red-700' : 'text-slate-800'}`}>
                          {n.lossPct !== null ? `${n.lossPct.toFixed(0)}%` : '—'}
                        </p>
                        <p className="text-[10px] text-slate-400">pérdida</p>
                      </div>
                      <div className="rounded-lg bg-slate-50 py-1.5">
                        <p className={`text-sm font-semibold ${n.dnsOk === false ? 'text-red-700' : 'text-slate-800'}`}>
                          {n.dnsOk === null ? '—' : n.dnsOk ? 'OK' : 'Falla'}
                        </p>
                        <p className="text-[10px] text-slate-400">DNS</p>
                      </div>
                    </div>
                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                      {isp && <span className={`rounded-full border px-2 py-0.5 font-medium ${isp.badge}`}>{isp.label}</span>}
                      <span className="text-slate-500">
                        {n.activeIsp === 'primary'
                          ? site.ispPrimaryName ?? ''
                          : n.activeIsp === 'secondary'
                            ? site.ispSecondaryName ?? ''
                            : ''}
                      </span>
                      {n.publicIp && <span className="font-mono text-slate-400">{n.publicIp}</span>}
                    </div>
                    <p className="mt-1.5 flex items-center gap-1 text-[10px] text-slate-400">
                      <Clock className="h-3 w-3" />
                      Medido {timeAgo(n.at)}
                      {site.status !== 'ONLINE' && <span className="ml-1 text-red-600">· agente sin reportar</span>}
                    </p>
                  </>
                ) : (
                  <p className="mt-2 text-[11px] text-slate-400">
                    {site.status === 'ONLINE' ? 'El agente todavía no es 1.3.0 (se actualiza solo).' : 'El agente no está reportando.'}
                  </p>
                )}
              </motion.div>
            );
          })}
        </div>
      </div>

      <ServiceMonitorsPanel isAdmin={isAdmin} />

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
            <Wifi className="h-4 w-4 text-slate-400" />
            Ubiquiti UniFi
            {lastRun && lastRun.mode !== 'off' && (
              <span className="font-normal text-slate-400">
                ({lastRun.mode === 'cloud' ? 'Site Manager' : 'consola local'} · sondeado {timeAgo(lastRun.at)}
                {deviceStats.clients > 0 ? ` · ${deviceStats.clients} clientes conectados` : ''})
              </span>
            )}
          </h2>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Buscar AP, sitio, IP, MAC..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="rounded-lg border border-slate-300 bg-slate-50 py-1.5 pl-8 pr-3 text-xs text-slate-800 outline-none transition-colors focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10"
            />
          </div>
        </div>

        {lastRun?.error && (
          <p className="mb-3 flex items-start gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Último sondeo con error: {lastRun.error}
          </p>
        )}

        {bySites ? (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              {[
                { id: 'all' as DeviceFilter, label: 'Todos los sitios', count: unifiSites.length },
                { id: 'offline' as DeviceFilter, label: 'Con problemas', count: unifiSites.filter((s) => s.hostOnline === false || s.offlineDevices > 0).length },
              ].map((f) => (
                <button
                  key={f.id}
                  onClick={() => setDeviceFilter(f.id)}
                  className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    deviceFilter === f.id ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'
                  }`}
                >
                  {f.label}
                  <span className={deviceFilter === f.id ? 'text-white/80' : f.id === 'offline' && f.count > 0 ? 'text-red-600' : 'text-slate-400'}>{f.count}</span>
                </button>
              ))}
              <span className="ml-1 text-[10px] text-slate-400">
                Controladores UniFi autoalojados: la nube informa el resumen de cada sitio (no el detalle de cada AP).
              </span>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {sortedSites.map((s, i) => {
                const hostDown = s.hostOnline === false;
                const tone = hostDown ? 'border-red-200 bg-red-50/40' : s.offlineDevices > 0 ? 'border-amber-200 bg-amber-50/30' : 'border-slate-200';
                const apsOnline = s.wifiDevices - s.offlineWifi;
                return (
                  <motion.div
                    key={s.id}
                    layout
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(i * 0.02, 0.3) }}
                    className={`rounded-xl border p-3 ${tone}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-800">{s.hostName}</p>
                        <p className="truncate text-[10px] text-slate-400">
                          {s.siteName ? `${s.siteName} · ` : ''}Network {s.version ?? '—'}
                          {s.updateAvailable ? ' · actualización disponible' : ''}
                        </p>
                      </div>
                      <span className={`flex shrink-0 items-center gap-1 text-[11px] font-medium ${hostDown ? 'text-red-700' : s.offlineDevices ? 'text-amber-700' : 'text-emerald-700'}`}>
                        <span className={`h-2 w-2 rounded-full ${hostDown ? 'animate-pulse bg-red-500' : s.offlineDevices ? 'bg-amber-500' : 'bg-emerald-500'}`} />
                        {hostDown ? 'Controlador offline' : s.offlineDevices ? `${s.offlineDevices} caído(s)` : s.hostOnline === null ? 'Sin estado' : 'OK'}
                      </span>
                    </div>

                    <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                      <div className="rounded-lg bg-white/70 py-1.5 ring-1 ring-slate-100">
                        <p className={`text-sm font-semibold tabular-nums ${s.offlineWifi ? 'text-red-700' : 'text-slate-800'}`}>
                          {s.wifiDevices ? `${apsOnline}/${s.wifiDevices}` : '—'}
                        </p>
                        <p className="text-[10px] text-slate-400">APs online</p>
                      </div>
                      <div className="rounded-lg bg-white/70 py-1.5 ring-1 ring-slate-100">
                        <p className={`text-sm font-semibold tabular-nums ${s.offlineWired ? 'text-red-700' : 'text-slate-800'}`}>
                          {s.wiredDevices ? `${s.wiredDevices - s.offlineWired}/${s.wiredDevices}` : '—'}
                        </p>
                        <p className="text-[10px] text-slate-400">switches</p>
                      </div>
                      <div className="rounded-lg bg-white/70 py-1.5 ring-1 ring-slate-100">
                        <p className="text-sm font-semibold tabular-nums text-slate-800">{s.wifiClients}</p>
                        <p className="text-[10px] text-slate-400">clientes WiFi</p>
                      </div>
                    </div>

                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-slate-500">
                      {s.ispName && <span>ISP: {s.ispName}</span>}
                      {s.wanUptime !== null && <span>WAN arriba {Number(s.wanUptime).toFixed(1)}%</span>}
                      {s.pendingUpdates > 0 && <span className="text-amber-700">{s.pendingUpdates} equipo(s) con firmware pendiente</span>}
                      {hostDown && s.hostOfflineSince && <span className="text-red-700">desconectado {timeAgo(s.hostOfflineSince)}</span>}
                      {!hostDown && s.devicesDownSince && <span className="text-amber-700">caídos {timeAgo(s.devicesDownSince)}</span>}
                    </div>
                  </motion.div>
                );
              })}
              {sortedSites.length === 0 && (
                <p className="col-span-full flex items-center justify-center gap-1.5 py-6 text-sm text-emerald-700">
                  <CheckCircle2 className="h-4 w-4" /> Ningún sitio con problemas
                </p>
              )}
            </div>
          </>
        ) : (!lastRun || lastRun.mode === 'off') && devices.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-xs text-slate-500">
            <Wifi className="mx-auto mb-2 h-6 w-6 text-slate-300" />
            La integración con UniFi no está configurada.
            {isAdmin
              ? ' Cargá la API key en Admin → Configuración → Ubiquiti UniFi (se crea en unifi.ui.com → API) y los Access Points aparecen acá en 2 minutos.'
              : ' Pedile a un administrador que la active.'}
          </div>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap gap-1.5">
              {DEVICE_FILTERS.map((f) => {
                const count =
                  f.id === 'all' ? devices.length : f.id === 'offline' ? deviceStats.offline : devices.filter((d) => d.deviceType === f.id).length;
                return (
                  <button
                    key={f.id}
                    onClick={() => setDeviceFilter(f.id)}
                    className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                      deviceFilter === f.id ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'
                    }`}
                  >
                    {f.label}
                    <span className={deviceFilter === f.id ? 'text-white/80' : f.id === 'offline' && count > 0 ? 'text-red-600' : 'text-slate-400'}>{count}</span>
                  </button>
                );
              })}
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
              <AnimatePresence initial={false}>
                {filteredDevices.map((d) => {
                  const st = statusStyle(d.status);
                  const Icon = DEVICE_ICON[d.deviceType];
                  return (
                    <motion.div
                      key={d.id}
                      layout
                      initial={{ opacity: 0, scale: 0.97 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.97 }}
                      transition={{ duration: 0.15 }}
                      className={`rounded-xl border p-3 ${st.card}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${d.status === 'online' ? 'bg-sky-50 text-sky-600' : 'bg-red-50 text-red-600'}`}>
                            <Icon className="h-4 w-4" />
                          </div>
                          <div className="min-w-0">
                            <p className="truncate text-xs font-semibold text-slate-800">{d.name}</p>
                            <p className="truncate text-[10px] text-slate-400">
                              {DEVICE_LABEL[d.deviceType]} · {d.model ?? '—'}
                            </p>
                          </div>
                        </div>
                        <span className={`flex shrink-0 items-center gap-1 text-[11px] font-medium capitalize ${st.text}`}>
                          <span className={`h-2 w-2 rounded-full ${st.dot}`} />
                          {st.label}
                        </span>
                      </div>
                      <div className="mt-2 space-y-0.5 text-[11px] text-slate-500">
                        {d.siteName && <p className="truncate">Sitio: {d.siteName}</p>}
                        <p className="font-mono text-[10px] text-slate-400">
                          {d.ipAddress ?? 'sin IP'} · {d.id}
                        </p>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pt-1">
                          {d.clients !== null && (
                            <span className="flex items-center gap-1">
                              <Users className="h-3 w-3" />
                              {d.clients} clientes
                            </span>
                          )}
                          {d.status === 'online' && d.uptimeSeconds !== null && <span>Encendido {formatUptime(d.uptimeSeconds)}</span>}
                          {d.status !== 'online' && <span className="text-red-600">Caído {timeAgo(d.statusChangedAt)}</span>}
                          {d.firmwareStatus === 'updateAvailable' && <span className="text-amber-600">Firmware desactualizado</span>}
                        </div>
                      </div>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
              {filteredDevices.length === 0 && (
                <p className="col-span-full py-6 text-center text-sm text-slate-400">
                  {deviceFilter === 'offline' ? (
                    <span className="flex items-center justify-center gap-1.5 text-emerald-700">
                      <CheckCircle2 className="h-4 w-4" /> Ningún dispositivo caído
                    </span>
                  ) : (
                    'Sin dispositivos que coincidan'
                  )}
                </p>
              )}
            </div>
          </>
        )}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
        <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-slate-800">
          <AlertTriangle className="h-4 w-4 text-slate-400" />
          Incidentes de red (últimos 7 días)
        </h2>
        {(overview?.recentEvents ?? []).length === 0 ? (
          <p className="flex items-center gap-1.5 text-xs text-emerald-700">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Sin cortes, failovers ni degradaciones registradas.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {(overview?.recentEvents ?? []).map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs">
                <span className="min-w-0 flex-1 text-slate-700">{e.description}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <AlertRepeatInfo alert={e} />
                  <span className={`rounded-full border px-2 py-0.5 text-[10px] ${SEVERITY_STYLES[e.severity]}`}>{e.severity}</span>
                  <span className="text-[10px] text-slate-400">{new Date(e.createdAt).toLocaleString('es-ES')}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
