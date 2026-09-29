'use client';

import { useState } from 'react';
import { CheckCircle2, Crosshair, Radar, Router, ShieldAlert, ShieldCheck, Smartphone } from 'lucide-react';
import { timeAgo } from '../../lib/health';
import { useToast } from '../Toast';
import { API_URL, useLiveData } from './useLiveData';
import type { NetGuardOverview, NetLocation } from '../../types';

const card = 'rounded-xl border border-slate-200 bg-white p-4';

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
  const devices = data.newDevices.filter((d) => showRandom || !d.randomized);
  const allOk = rogue.length === 0 && badGw.length === 0;
  const queryLoc = located[macQuery.trim().toLowerCase()];

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

      <div className="grid gap-4 xl:grid-cols-2">
        <div className={card}>
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-700">
            <Radar className="h-4 w-4 text-slate-400" /> Servidores DHCP que respondieron (24 h)
          </h3>
          {data.dhcpServers.length === 0 ? (
            <p className="text-xs text-slate-400">Todavía ningún agente informó la prueba de DHCP (agente 1.14.0 o superior).</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-xs">
              {data.dhcpServers.map((d) => (
                <li key={d.id} className="py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${d.authorized ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                      {d.authorized ? 'Autorizado' : 'NO AUTORIZADO'}
                    </span>
                    <span className="font-mono font-semibold text-slate-800">{d.dhcpServer}</span>
                    {d.mac && <span className="font-mono text-slate-500">{d.mac}</span>}
                    {d.vendor && <span className="text-slate-500">{d.vendor}</span>}
                    <span className="ml-auto text-[10px] text-slate-400">visto por {d.serverName} · {timeAgo(d.lastSeenAt)}</span>
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

        <div className={card}>
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-700">
            <Router className="h-4 w-4 text-slate-400" /> Gateway de cada servidor (MAC)
          </h3>
          {data.gateways.length === 0 ? (
            <p className="text-xs text-slate-400">Sin datos todavía.</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-xs">
              {data.gateways.map((g) => (
                <li key={g.serverId} className="py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    {g.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> : <ShieldAlert className="h-3.5 w-3.5 text-red-600" />}
                    <span className="font-semibold text-slate-800">{g.serverName}</span>
                    <span className="font-mono text-slate-500">→ {g.gatewayIp}</span>
                    <span className="ml-auto text-[10px] text-slate-400">{timeAgo(g.updatedAt)}</span>
                  </div>
                  <p className="mt-0.5 font-mono text-[11px] text-slate-500">
                    habitual {g.baselineMac ?? '—'} {g.baselineVendor ? `(${g.baselineVendor})` : ''}
                    {!g.ok && (
                      <span className="text-red-700">
                        {' '}
                        · ahora {g.currentMac} {g.currentVendor ? `(${g.currentVendor})` : ''}
                      </span>
                    )}
                  </p>
                  {!g.ok && (
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {g.currentMac && (
                        <button onClick={() => locate(g.currentMac!)} className="rounded border border-sky-200 px-2 py-0.5 text-[10px] text-sky-700 hover:bg-sky-50">
                          Ubicar equipo
                        </button>
                      )}
                      {isAdmin && (
                        <button
                          onClick={() => window.confirm('¿Se reemplazó el firewall/router? La nueva MAC pasa a ser la habitual.') && post(`/api/netguard/gateway/${g.serverId}/accept`, 'Nueva MAC aceptada')}
                          className="rounded border border-slate-200 px-2 py-0.5 text-[10px] text-slate-600 hover:bg-slate-50"
                        >
                          Cambio planificado: aceptar
                        </button>
                      )}
                    </div>
                  )}
                  {g.currentMac && located[g.currentMac] && located[g.currentMac] !== 'loading' && !g.ok && <Location loc={located[g.currentMac] as NetLocation} />}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className={card}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-700">Equipos nuevos en la red (14 días)</h3>
          <label className="flex items-center gap-1.5 text-[11px] text-slate-500">
            <input type="checkbox" checked={showRandom} onChange={(e) => setShowRandom(e.target.checked)} />
            <Smartphone className="h-3 w-3" /> Mostrar celulares (MAC aleatoria)
          </label>
        </div>
        {devices.length === 0 ? (
          <p className="text-xs text-slate-400">Ningún equipo nuevo.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-400">
                  <th className="py-1.5 pr-3 font-medium">MAC / fabricante</th>
                  <th className="py-1.5 pr-3 font-medium">IP / nombre</th>
                  <th className="py-1.5 pr-3 font-medium">Primera vez</th>
                  <th className="py-1.5 pr-3 font-medium">Estado</th>
                  <th className="py-1.5" />
                </tr>
              </thead>
              <tbody>
                {devices.map((d) => {
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
                      <td className="py-1.5 pr-3 text-slate-500">{timeAgo(d.firstSeenAt)}</td>
                      <td className="py-1.5 pr-3">
                        {d.approved ? (
                          <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700">Aprobado</span>
                        ) : (
                          <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">Sin revisar</span>
                        )}
                      </td>
                      <td className="space-x-1 whitespace-nowrap py-1.5 text-right">
                        <button onClick={() => locate(d.mac)} className="rounded border border-sky-200 px-2 py-0.5 text-[10px] text-sky-700 hover:bg-sky-50">
                          Ubicar
                        </button>
                        {!d.approved && canWrite && (
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
      </div>
    </div>
  );
}
