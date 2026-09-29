'use client';

import { useMemo, useState } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Download, Gauge, Play } from 'lucide-react';
import { useLiveData, API_URL } from './inventory/useLiveData';
import { useToast } from './Toast';
import { timeAgo } from '../lib/health';
import type { SpeedSiteServer, SpeedTestRow } from '../types';

const TOOLTIP_STYLE = { background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 12 };

type Site = { publicIp: string; servers: SpeedSiteServer[]; tests: SpeedTestRow[] };

function pct(v: number | null, of: number | null) {
  return v !== null && of ? Math.round((v / of) * 100) : null;
}

function exportCsv(site: Site) {
  const header = ['fecha', 'servidor', 'ip_publica', 'bajada_mbps', 'subida_mbps', 'latencia_ms', 'jitter_ms', 'contratado_bajada', 'contratado_subida', '%_bajada', 'manual'];
  const rows = site.tests.map((t) => [
    new Date(t.at).toLocaleString('es-AR'),
    t.serverName,
    t.publicIp ?? '',
    t.downloadMbps ?? '',
    t.uploadMbps ?? '',
    t.latencyMs ?? '',
    t.jitterMs ?? '',
    t.contractedDownMbps ?? '',
    t.contractedUpMbps ?? '',
    pct(t.downloadMbps, t.contractedDownMbps) ?? '',
    t.manual ? 'si' : 'no',
  ]);
  const csv = `﻿${[header, ...rows].map((r) => r.join(',')).join('\n')}\n`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `velocidad-${site.publicIp}.csv`;
  a.click();
}

function SiteCard({ site, isAdmin, canWrite, onSaved }: { site: Site; isAdmin: boolean; canWrite: boolean; onSaved: () => void }) {
  const toast = useToast();
  const main = site.servers[0];
  const [down, setDown] = useState(main.contractedDownMbps?.toString() ?? '');
  const [up, setUp] = useState(main.contractedUpMbps?.toString() ?? '');
  const last = site.tests[site.tests.length - 1];
  const contractedDown = main.contractedDownMbps;
  const contractedUp = main.contractedUpMbps;
  const data = site.tests.filter((t) => t.ok).map((t) => ({ at: new Date(t.at).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' }), bajada: t.downloadMbps, subida: t.uploadMbps }));
  const lowNights = site.tests.filter((t) => t.ok && t.contractedDownMbps && t.downloadMbps !== null && t.downloadMbps < t.contractedDownMbps * 0.6).length;

  const run = async () => {
    const res = await fetch(`${API_URL}/api/speedtests/run`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverId: main.id }) });
    const body = await res.json().catch(() => ({}));
    if (res.ok) toast.info(body.message);
    else toast.error(body.error ?? 'No se pudo iniciar');
  };

  const save = async () => {
    const body = { contractedDownMbps: down ? Number(down) : null, contractedUpMbps: up ? Number(up) : null };
    for (const s of site.servers) {
      // eslint-disable-next-line no-await-in-loop
      await fetch(`${API_URL}/api/servers/${s.id}/contracted-speed`, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }
    toast.success('Velocidad contratada guardada');
    onSaved();
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-slate-800">{site.servers.map((s) => s.name).join(', ')}</p>
          <p className="text-[11px] text-slate-400">
            IP pública {site.publicIp}
            {main.ispPrimaryName ? ` · ${main.ispPrimaryName}` : ''}
          </p>
        </div>
        <div className="flex gap-1.5">
          {site.tests.length > 0 && (
            <button onClick={() => exportCsv(site)} className="flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50" title="Evidencia para el reclamo al proveedor">
              <Download className="h-3 w-3" /> CSV
            </button>
          )}
          {canWrite && (
            <button onClick={run} className="flex items-center gap-1 rounded-lg border border-brand-200 px-2 py-1 text-[11px] text-brand-700 hover:bg-brand-50">
              <Play className="h-3 w-3" /> Probar ahora
            </button>
          )}
        </div>
      </div>
      {last ? (
        <div className="mb-2 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg bg-slate-50 p-2">
            <p className="text-[10px] uppercase text-slate-400">Bajada</p>
            <p className="text-lg font-semibold text-slate-800">{last.downloadMbps ?? '—'}</p>
            <p className="text-[10px] text-slate-400">{contractedDown ? `${pct(last.downloadMbps, contractedDown)}% de ${contractedDown}` : 'Mbps'}</p>
          </div>
          <div className="rounded-lg bg-slate-50 p-2">
            <p className="text-[10px] uppercase text-slate-400">Subida</p>
            <p className="text-lg font-semibold text-slate-800">{last.uploadMbps ?? '—'}</p>
            <p className="text-[10px] text-slate-400">{contractedUp ? `${pct(last.uploadMbps, contractedUp)}% de ${contractedUp}` : 'Mbps'}</p>
          </div>
          <div className="rounded-lg bg-slate-50 p-2">
            <p className="text-[10px] uppercase text-slate-400">Latencia</p>
            <p className="text-lg font-semibold text-slate-800">{last.latencyMs ?? '—'}</p>
            <p className="text-[10px] text-slate-400">ms · {timeAgo(last.at)}</p>
          </div>
        </div>
      ) : (
        <p className="mb-2 text-xs text-slate-400">Sin pruebas todavía: la primera corre esta madrugada (o con “Probar ahora”).</p>
      )}
      {lowNights > 0 && <p className="mb-2 text-[11px] font-medium text-red-700">{lowNights} prueba(s) por debajo del 60% de lo contratado en el período.</p>}
      {data.length > 1 && (
        <div className="h-44">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 5, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid stroke="#f1f5f9" />
              <XAxis dataKey="at" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} unit="" />
              <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v) => `${v} Mbps`} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {contractedDown && <ReferenceLine y={contractedDown} stroke="#2563eb" strokeDasharray="4 4" />}
              {contractedUp && <ReferenceLine y={contractedUp} stroke="#10b981" strokeDasharray="4 4" />}
              <Line type="monotone" dataKey="bajada" stroke="#2563eb" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="subida" stroke="#10b981" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
      {isAdmin && (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2 text-[11px] text-slate-500">
          Contratado:
          <input value={down} onChange={(e) => setDown(e.target.value.replace(/[^\d.]/g, ''))} placeholder="bajada" className="w-20 rounded border border-slate-300 px-2 py-1" /> /
          <input value={up} onChange={(e) => setUp(e.target.value.replace(/[^\d.]/g, ''))} placeholder="subida" className="w-20 rounded border border-slate-300 px-2 py-1" /> Mbps
          <button onClick={save} className="rounded border border-slate-200 px-2 py-1 hover:bg-slate-50">
            Guardar
          </button>
        </div>
      )}
    </div>
  );
}

// Prueba de velocidad nocturna por sede (un agente por IP publica) contra lo
// contratado: evidencia para reclamarle al proveedor.
export default function SpeedTestPanel({ isAdmin, canWrite }: { isAdmin: boolean; canWrite: boolean }) {
  const { data, reload } = useLiveData<{ tests: SpeedTestRow[]; servers: SpeedSiteServer[] }>('/api/speedtests?days=30', { event: 'soc:speedtest', intervalMs: 600_000 });
  const sites = useMemo(() => {
    const map = new Map<string, Site>();
    for (const s of data?.servers ?? []) {
      const site = map.get(s.publicIp) ?? { publicIp: s.publicIp, servers: [], tests: [] };
      site.servers.push(s);
      map.set(s.publicIp, site);
    }
    for (const t of data?.tests ?? []) {
      const site = map.get(t.publicIp ?? '');
      if (site) site.tests.push(t);
    }
    return [...map.values()].sort((a, b) => a.servers[0].name.localeCompare(b.servers[0].name));
  }, [data]);

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
      <h2 className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-slate-800">
        <Gauge className="h-4 w-4 text-slate-400" /> Velocidad de internet por sede
      </h2>
      <p className="mb-3 text-[11px] text-slate-500">Una prueba por sede cada madrugada (un servidor por IP pública), comparada con lo contratado. Descargá el CSV como evidencia para el reclamo.</p>
      {!data ? (
        <p className="py-6 text-center text-sm text-slate-400">Cargando...</p>
      ) : sites.length === 0 ? (
        <p className="text-xs text-slate-400">Todavía ningún agente informó su IP pública.</p>
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {sites.map((s) => (
            <SiteCard key={s.publicIp} site={s} isAdmin={isAdmin} canWrite={canWrite} onSaved={reload} />
          ))}
        </div>
      )}
    </div>
  );
}
