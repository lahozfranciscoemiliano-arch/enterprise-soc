'use client';

import { useState } from 'react';
import { CheckCircle2, Crosshair, Radar, Router, ShieldAlert, ShieldCheck, Smartphone } from 'lucide-react';
import { timeAgo } from '../../lib/health';
import { useToast } from '../Toast';
import { API_URL, useLiveData } from './useLiveData';
import { NetworkGroup, networkOf, sortNetKeys, useNetworks } from './networks';
import type { NetGuardOverview, NetLocation } from '../../types';

type NetDeviceRow = NetGuardOverview['newDevices'][number] & { online: boolean; isNew: boolean; user: string | null };

function ipNum(ip: string | null | undefined) {
  const p = String(ip ?? '').split('.').map(Number);
  return p.length === 4 && p.every((n) => !Number.isNaN(n)) ? ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3] : Number.MAX_SAFE_INTEGER;
}


function Location({ loc }: { loc: NetLocation }) {
  const where = loc.switchName
    ? `Switch "${loc.switchName}"${loc.switchPort ? ` · puerto ${loc.switchPort}` : ''}`
    : loc.apName
      ? `WiFi · AP "${loc.apName}"${loc.essid ? ` (${loc.essid})` : ''}`
      : 'Sin datos de UniFi para ubicarlo';
  return (
    <div className="mt-2 rounded-lg border border-sky-100 bg-sky-50 p-3 text-xs text-slate-700">
      <p className="font-mono font-semibold">{loc.mac}</p>
      <p>
        {loc.vendor ?? 'Fabricante desconocido'}
        {loc.hostname ? ` · ${loc.hostname}` : ''}
        {loc.ip ? ` · ${loc.ip}` : ''}
        {loc.kind ? ` · ${loc.kind}` : ''}
      </p>
      <p className="mt-1 font-medium text-sky-800">
        {where}
        {loc.site ? ` · ${loc.site}` : ''}
      </p>
    </div>
  );
}

export default function NetGuardView({ isAdmin = false, canWrite = false }: { isAdmin?: boolean; canWrite?: boolean }) {
  const toast = useToast();
  const { data, error, reload } = useLiveData<NetGuardOverview>('/api/netguard/overview', { event: 'soc:netguard', intervalMs: 60_000 });
  const [macQuery, setMacQuery] = useState('');
  const [located, setLocated] = useState<Record<string, NetLocation | 'loading'>>({});
  const [showRandom, setShowRandom] = useState(false);
  const [onlyNew, setOnlyNew] = useState(false);
  const [devQuery, setDevQuery] = useState('');
  const { data: allDevices } = useLiveData<NetDeviceRow[]>('/api/netguard/devices', { intervalMs: 120_000 });
  const nets = useNetworks();

  const post = async (path: string, okMsg: string) => {
    const res = await fetch(`${API_URL}${path}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (res.ok) {
      toast.success(okMsg);
      reload();
    } else toast.error((await res.json().catch(() => ({}))).error ?? 'No se pudo completar');
  };

  const locate = async (mac: string) => {
    setLocated((l) => ({ ...l, [mac]: 'loading' }));
    const res = await fetch(`${API_URL}/api/netguard/locate/${encodeURIComponent(mac)}`, { credentials: 'include' });
    const body: NetLocation | null = res.ok ? await res.json() : null;
    setLocated((l) => {
      const next = { ...l };
      if (body) next[mac] = body;
      else delete next[mac];
      return next;
    });
    if (!body) toast.error('MAC inválida');
  };

  if (error) return <p className="text-xs text-red-600">{error}</p>;
  if (!data) return <p className="py-6 text-center text-sm text-slate-400">Cargando...</p>;

  const rogue = data.dhcpServers.filter((d) => !d.authorized);
  const badGw = data.gateways.filter((g) => !g.ok);
  const dq = devQuery.trim().toLowerCase();
  const devices = (allDevices ?? [])
    .filter((d) => showRandom || !d.randomized)
    .filter((d) => !onlyNew || d.isNew)
    .filter((d) => !dq || [d.mac, d.ip, d.hostname, d.vendor, d.user].some((v) => v?.toLowerCase().includes(dq)))
    .sort((a, b) => ipNum(a.ip) - ipNum(b.ip));
  const allOk = rogue.length === 0 && badGw.length === 0;
  const queryLoc = located[macQuery.trim().toLowerCase()];

  // Todo agrupado por la red (gateway) de cada sede.
  type Group = {
    key: string;
    label: string;
    gateway: string | null;
    servers: string[];
    gateways: NetGuardOverview['gateways'];
    dhcp: NetGuardOverview['dhcpServers'];
    devices: NetDeviceRow[];
  };
  const byKey = new Map<string, Group>();
  const groupFor = (ip: string | null | undefined): Group => {
    const n = networkOf(ip, nets);
    const g = byKey.get(n.key) ?? { key: n.key, label: n.label, gateway: n.gateway, servers: [...n.servers], gateways: [], dhcp: [], devices: [] };
    byKey.set(n.key, g);
    return g;
  };
  const serverNet = new Map<string, Group>();
  for (const x of data.gateways) {
    const g = groupFor(x.gatewayIp);
    g.gateway = g.gateway ?? x.gatewayIp;
    if (!g.servers.includes(x.serverName)) g.servers.push(x.serverName);
    g.gateways.push(x);
    serverNet.set(x.serverId, g);
  }
  for (const d of data.dhcpServers) (serverNet.get(d.serverId) ?? groupFor(d.dhcpServer)).dhcp.push(d);
  for (const d of devices) groupFor(d.ip).devices.push(d);
  const groups = [...byKey.values()].sort((a, b) => sortNetKeys(a.key, b.key));

  return (
    <div className="space-y-4">
      <div className={`flex flex-wrap items-center gap-3 rounded-xl border p-4 ${allOk ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50'}`}>
        {allOk ? <ShieldCheck className="h-6 w-6 text-emerald-600" /> : <ShieldAlert className="h-6 w-6 text-red-600" />}
        <div className="min-w-0 flex-1 text-xs">
          <p className={`text-sm font-semibold ${allOk ? 'text-emerald-800' : 'text-red-800'}`}>
            {allOk ? 'Red sin DHCP falsos ni gateways duplicados' : `${rogue.length} DHCP no autorizado(s) · ${badGw.length} gateway(s) con MAC distinta`}
          </p>
          <p className="text-slate-600">
            Cada agente prueba el DHCP cada 5 min y la MAC de su gateway cada minuto. {data.knownDevices} equipos conocidos en la red; {data.newDevices.length} nuevos
            en 14 días.
          </p>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (macQuery.trim()) locate(macQuery.trim().toLowerCase());
          }}
          className="flex items-center gap-1.5"
        >
          <input
            value={macQuery}
            onChange={(e) => setMacQuery(e.target.value)}
            placeholder="Ubicar MAC (aa:bb:cc:...)"
            className="w-48 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs outline-none focus:border-brand-500"
          />
          <button className="flex items-center gap-1 rounded-lg bg-brand-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-brand-700">
            <Crosshair className="h-3.5 w-3.5" /> Ubicar
          </button>
        </form>
      </div>
      {queryLoc && queryLoc !== 'loading' && <Location loc={queryLoc} />}

      {groups.length === 0 && <p className="py-6 text-center text-xs text-slate-400">Todavía ningún agente informó datos de red (agente 1.14.0 o superior).</p>}
      <div className="flex items-center justify-between text-[11px] text-slate-500">
        <span>Agrupado por gateway / red de cada sede. Se listan todos los equipos vistos en los últimos 7 días.</span>
        <span className="flex flex-wrap items-center gap-3">
        <input
          value={devQuery}
          onChange={(e) => setDevQuery(e.target.value)}
          placeholder="Buscar equipo, IP, MAC, usuario..."
          className="w-56 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-[11px] outline-none focus:border-brand-500"
        />
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} /> Solo nuevos sin revisar
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={showRandom} onChange={(e) => setShowRandom(e.target.checked)} />
          <Smartphone className="h-3 w-3" /> Mostrar celulares (MAC aleatoria)
        </label>
        </span>
      </div>
      {groups.map((g) => {
        const problems = g.dhcp.filter((d) => !d.authorized).length + g.gateways.filter((x) => !x.ok).length;
        return (
          <NetworkGroup
            key={g.key}
            label={g.label}
            gateway={g.gateway}
            servers={g.servers}
            count={g.devices.length}
            defaultOpen={problems > 0 || groups.length <= 3}
            badge={
              problems > 0 ? (
                <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-700">{problems} problema(s)</span>
              ) : (
                <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700">OK</span>
              )
            }
          >
            <div className="grid gap-4 xl:grid-cols-2">
              <div>
                <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-slate-700">
                  <Radar className="h-3.5 w-3.5 text-slate-400" /> Servidores DHCP que respondieron (24 h)
                </h4>
                {g.dhcp.length === 0 ? (
                  <p className="text-[11px] text-slate-400">Sin pruebas de DHCP en esta red.</p>
                ) : (
                  <ul className="divide-y divide-slate-100 text-xs">
                    {g.dhcp.map((d) => (
                      <li key={d.id} className="py-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${d.authorized ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                            {d.authorized ? 'Autorizado' : 'NO AUTORIZADO'}
                          </span>
                          <span className="font-mono font-semibold text-slate-800">{d.dhcpServer}</span>
                          {d.mac && <span className="font-mono text-slate-500">{d.mac}</span>}
                          {d.vendor && <span className="text-slate-500">{d.vendor}</span>}
                          <span className="ml-auto text-[10px] text-slate-400">
                            visto por {d.serverName} · {timeAgo(d.lastSeenAt)}
                          </span>
                        </div>
                        <p className="mt-0.5 text-[11px] text-slate-500">
                          Ofrece {d.offeredIp ?? '—'} · gateway {d.router ?? '—'}
                          {d.dns.length ? ` · DNS ${d.dns.join(', ')}` : ''}
                        </p>
                        {!d.authorized && (
                          <div className="mt-1 flex flex-wrap gap-1.5">
                            {d.mac && (
                              <button onClick={() => locate(d.mac!)} className="rounded border border-sky-200 px-2 py-0.5 text-[10px] text-sky-700 hover:bg-sky-50">
                                Ubicar equipo
                              </button>
                            )}
                            {isAdmin && (
                              <button
                                onClick={() => window.confirm(`¿Aprobar ${d.dhcpServer} como DHCP legítimo?`) && post(`/api/netguard/dhcp/${d.dhcpServer}/authorize`, 'DHCP aprobado')}
                                className="rounded border border-slate-200 px-2 py-0.5 text-[10px] text-slate-600 hover:bg-slate-50"
                              >
                                Es legítimo: aprobar
                              </button>
                            )}
                          </div>
                        )}
                        {d.mac && located[d.mac] && located[d.mac] !== 'loading' && <Location loc={located[d.mac] as NetLocation} />}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-slate-700">
                  <Router className="h-3.5 w-3.5 text-slate-400" /> MAC del gateway vista por cada servidor
                </h4>
                {g.gateways.length === 0 ? (
                  <p className="text-[11px] text-slate-400">Ningún agente en esta red informa su gateway.</p>
                ) : (
                  <ul className="divide-y divide-slate-100 text-xs">
                    {g.gateways.map((x) => (
                      <li key={x.serverId} className="py-2">
                        <div className="flex flex-wrap items-center gap-2">
                          {x.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> : <ShieldAlert className="h-3.5 w-3.5 text-red-600" />}
                          <span className="font-semibold text-slate-800">{x.serverName}</span>
                          <span className="font-mono text-slate-500">→ {x.gatewayIp}</span>
                          <span className="ml-auto text-[10px] text-slate-400">{timeAgo(x.updatedAt)}</span>
                        </div>
                        <p className="mt-0.5 font-mono text-[11px] text-slate-500">
                          habitual {x.baselineMac ?? '—'} {x.baselineVendor ? `(${x.baselineVendor})` : ''}
                          {!x.ok && (
                            <span className="text-red-700">
                              {' '}
                              · ahora {x.currentMac} {x.currentVendor ? `(${x.currentVendor})` : ''}
                            </span>
                          )}
                        </p>
                        {!x.ok && (
                          <div className="mt-1 flex flex-wrap gap-1.5">
                            {x.currentMac && (
                              <button onClick={() => locate(x.currentMac!)} className="rounded border border-sky-200 px-2 py-0.5 text-[10px] text-sky-700 hover:bg-sky-50">
                                Ubicar equipo
                              </button>
                            )}
                            {isAdmin && (
                              <button
                                onClick={() => window.confirm('¿Se reemplazó el firewall/router? La nueva MAC pasa a ser la habitual.') && post(`/api/netguard/gateway/${x.serverId}/accept`, 'Nueva MAC aceptada')}
                                className="rounded border border-slate-200 px-2 py-0.5 text-[10px] text-slate-600 hover:bg-slate-50"
                              >
                                Cambio planificado: aceptar
                              </button>
                            )}
                          </div>
                        )}
                        {!x.ok && x.currentMac && located[x.currentMac] && located[x.currentMac] !== 'loading' && <Location loc={located[x.currentMac] as NetLocation} />}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <h4 className="mb-1.5 mt-4 text-xs font-semibold text-slate-700">
              Equipos en esta red ({g.devices.length} · {g.devices.filter((d) => d.online).length} en línea
              {g.devices.some((d) => d.isNew) ? ` · ${g.devices.filter((d) => d.isNew).length} nuevos sin revisar` : ''})
            </h4>
            {g.devices.length === 0 ? (
              <p className="text-[11px] text-slate-400">{allDevices === null ? 'Cargando...' : 'Sin equipos registrados en esta red todavía.'}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-400">
                      <th className="py-1.5 pr-3 font-medium">MAC / fabricante</th>
                      <th className="py-1.5 pr-3 font-medium">IP / nombre</th>
                      <th className="py-1.5 pr-3 font-medium">Usuario</th>
                      <th className="py-1.5 pr-3 font-medium">Visto</th>
                      <th className="py-1.5 pr-3 font-medium">Estado</th>
                      <th className="py-1.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {g.devices.map((d) => {
                      const loc = located[d.mac];
                      return (
                        <tr key={d.mac} className="border-b border-slate-100 align-top">
                          <td className="py-1.5 pr-3">
                            <span className="block font-mono text-slate-800">{d.mac}</span>
                            <span className="text-[10px] text-slate-400">{d.vendor ?? 'desconocido'}</span>
                            {loc && loc !== 'loading' && <Location loc={loc} />}
                          </td>
                          <td className="py-1.5 pr-3">
                            <span className="block font-mono">{d.ip ?? '—'}</span>
                            <span className="text-[10px] text-slate-400">{d.hostname ?? ''}</span>
                          </td>
                          <td className="py-1.5 pr-3 text-slate-600">{d.user ?? '—'}</td>
                          <td className="py-1.5 pr-3 text-[11px] text-slate-500">
                            <span className="flex items-center gap-1.5">
                              <span className={`h-2 w-2 rounded-full ${d.online ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                              {d.online ? 'en línea' : timeAgo(d.lastSeenAt)}
                            </span>
                            <span className="text-[10px] text-slate-400">desde {timeAgo(d.firstSeenAt)}</span>
                          </td>
                          <td className="py-1.5 pr-3">
                            {d.isNew ? (
                              <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">Nuevo sin revisar</span>
                            ) : (
                              <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700">Conocido</span>
                            )}
                          </td>
                          <td className="space-x-1 whitespace-nowrap py-1.5 text-right">
                            <button onClick={() => locate(d.mac)} className="rounded border border-sky-200 px-2 py-0.5 text-[10px] text-sky-700 hover:bg-sky-50">
                              Ubicar
                            </button>
                            {d.isNew && canWrite && (
                              <button onClick={() => post(`/api/netguard/devices/${d.mac}/approve`, 'Equipo aprobado')} className="rounded border border-slate-200 px-2 py-0.5 text-[10px] text-slate-600 hover:bg-slate-50">
                                Aprobar
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </NetworkGroup>
        );
      })}
    </div>
  );
}
