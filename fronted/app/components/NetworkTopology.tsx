'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, Cloud, Minus, Monitor, Plus, Router, Server, Share2, Wifi } from 'lucide-react';
import { useLiveData } from './inventory/useLiveData';
import { timeAgo } from '../lib/health';
import type { TopoNode, TopoSite } from '../types';

const NODE_W = 150;
const NODE_H = 56;
const GAP_X = 18;
const GAP_Y = 46;

const ICON = { internet: Cloud, gateway: Router, switch: Share2, ap: Wifi, device: Monitor, server: Server } as const;
const STATUS: Record<TopoNode['status'], { ring: string; dot: string; line: string; label: string }> = {
  ok: { ring: 'border-emerald-200 bg-white', dot: 'bg-emerald-500', line: '#10b981', label: 'OK' },
  warning: { ring: 'border-amber-300 bg-amber-50', dot: 'bg-amber-500', line: '#f59e0b', label: 'Advertencia' },
  critical: { ring: 'border-red-300 bg-red-50', dot: 'bg-red-500', line: '#ef4444', label: 'Crítico' },
  down: { ring: 'border-red-400 bg-red-50', dot: 'bg-red-600', line: '#dc2626', label: 'Caído' },
};

// Arbol de arriba hacia abajo: nivel = distancia desde "Internet".
function layout(site: TopoSite) {
  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const e of site.edges) {
    children.set(e.from, [...(children.get(e.from) ?? []), e.to]);
    hasParent.add(e.to);
  }
  const roots = site.nodes.filter((n) => !hasParent.has(n.id)).map((n) => n.id);
  const pos = new Map<string, { x: number; y: number }>();
  let cursor = 0;
  const visit = (id: string, depth: number, seen: Set<string>): number => {
    if (seen.has(id)) return pos.get(id)?.x ?? 0;
    seen.add(id);
    const kids = (children.get(id) ?? []).filter((k) => !seen.has(k));
    let x: number;
    if (kids.length === 0) {
      x = cursor;
      cursor += NODE_W + GAP_X;
    } else {
      const xs = kids.map((k) => visit(k, depth + 1, seen));
      x = (Math.min(...xs) + Math.max(...xs)) / 2;
    }
    pos.set(id, { x, y: depth * (NODE_H + GAP_Y) });
    return x;
  };
  const seen = new Set<string>();
  for (const r of roots) visit(r, 0, seen);
  for (const n of site.nodes) if (!pos.has(n.id)) visit(n.id, 0, seen);
  const width = Math.max(cursor - GAP_X, NODE_W);
  const height = Math.max(...[...pos.values()].map((p) => p.y)) + NODE_H;
  return { pos, width, height };
}

// Oculta los descendientes de las ramas contraidas.
function visibleSite(site: TopoSite, collapsed: Set<string>): TopoSite {
  const children = new Map<string, string[]>();
  for (const e of site.edges) children.set(e.from, [...(children.get(e.from) ?? []), e.to]);
  const hidden = new Set<string>();
  const hide = (id: string) => {
    for (const k of children.get(id) ?? []) {
      if (hidden.has(k)) continue;
      hidden.add(k);
      hide(k);
    }
  };
  for (const id of collapsed) hide(id);
  return { ...site, nodes: site.nodes.filter((n) => !hidden.has(n.id)), edges: site.edges.filter((e) => !hidden.has(e.to) && !hidden.has(e.from)) };
}

function descendantsCount(site: TopoSite, id: string): number {
  const children = new Map<string, string[]>();
  for (const e of site.edges) children.set(e.from, [...(children.get(e.from) ?? []), e.to]);
  const seen = new Set<string>();
  const walk = (x: string) => {
    for (const k of children.get(x) ?? []) {
      if (!seen.has(k)) {
        seen.add(k);
        walk(k);
      }
    }
  };
  walk(id);
  return seen.size;
}

function SiteMap({ site, onServer, open, onToggle }: { site: TopoSite; onServer: (id: string) => void; open: boolean; onToggle: () => void }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const shown = useMemo(() => visibleSite(site, collapsed), [site, collapsed]);
  const { pos, width, height } = useMemo(() => layout(shown), [shown]);
  const byId = new Map(site.nodes.map((n) => [n.id, n]));
  const hasKids = new Set(site.edges.map((e) => e.from));
  const problems = site.nodes.filter((n) => n.status !== 'ok');
  const toggleNode = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className={`flex flex-wrap items-center justify-between gap-2 ${open ? 'mb-3' : ''}`}>
        <button type="button" onClick={onToggle} className="flex items-start gap-2 text-left" aria-expanded={open}>
          <ChevronDown className={`mt-0.5 h-4 w-4 shrink-0 text-slate-400 transition-transform ${open ? '' : '-rotate-90'}`} />
          <span>
            <span className="block text-sm font-semibold text-slate-800">{site.name}</span>
            <span className="block text-[11px] text-slate-400">
              Fuente: {site.source}
              {site.counts.devices ? ` · ${site.counts.devices} equipos de red` : ''}
              {site.counts.offline ? ` · ${site.counts.offline} caídos` : ''}
              {site.counts.clients ? ` · ${site.counts.clients} clientes` : ''}
            </span>
          </span>
        </button>
        {problems.length > 0 ? (
          <span className="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700">
            {problems.length} eslabón(es) con problemas: {problems.slice(0, 3).map((p) => p.name).join(', ')}
          </span>
        ) : (
          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">Todo en línea</span>
        )}
      </div>
      {open && (
      <div className="overflow-x-auto">
        <div className="relative mx-auto" style={{ width, height }}>
          <svg className="absolute inset-0" width={width} height={height}>
            {shown.edges.map((e) => {
              const a = pos.get(e.from);
              const b = pos.get(e.to);
              const child = byId.get(e.to);
              if (!a || !b || !child) return null;
              const x1 = a.x + NODE_W / 2;
              const y1 = a.y + NODE_H;
              const x2 = b.x + NODE_W / 2;
              const y2 = b.y;
              const my = (y1 + y2) / 2;
              const color = child.status === 'ok' ? '#cbd5e1' : STATUS[child.status].line;
              return (
                <g key={`${e.from}-${e.to}`}>
                  <path d={`M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`} fill="none" stroke={color} strokeWidth={child.status === 'ok' ? 1.5 : 2.5} strokeDasharray={child.status === 'down' ? '5 4' : undefined} />
                  {e.label && (
                    <text x={x2} y={y2 - 6} textAnchor="middle" className="fill-slate-400" fontSize="9">
                      {e.label}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          {shown.nodes.map((n) => {
            const p = pos.get(n.id);
            if (!p) return null;
            const Icon = ICON[n.type] ?? Monitor;
            const st = STATUS[n.status];
            const clickable = n.type === 'server' && n.serverId;
            const folded = collapsed.has(n.id);
            return (
              <div key={n.id} className="absolute" style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}>
              <button
                type="button"
                disabled={!clickable}
                onClick={() => clickable && onServer(n.serverId!)}
                title={[n.name, n.ip, n.detail, st.label].filter(Boolean).join(' · ')}
                className={`flex h-full w-full items-center gap-2 rounded-lg border px-2 text-left shadow-sm transition-shadow ${st.ring} ${clickable ? 'cursor-pointer hover:shadow-md' : 'cursor-default'}`}
              >
                <span className="relative shrink-0">
                  <Icon className="h-5 w-5 text-slate-500" />
                  <span className={`absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full ring-2 ring-white ${st.dot}`} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[11px] font-semibold text-slate-800">{n.name}</span>
                  {n.ip && <span className="block truncate font-mono text-[10px] text-slate-500">{n.ip}</span>}
                  {n.detail && <span className="block truncate text-[9px] text-slate-400">{n.detail}</span>}
                </span>
              </button>
              {hasKids.has(n.id) && (
                <button
                  type="button"
                  onClick={() => toggleNode(n.id)}
                  title={folded ? `Expandir (${descendantsCount(site, n.id)} equipos)` : 'Contraer esta rama'}
                  className="absolute -bottom-2.5 left-1/2 z-10 flex h-5 min-w-5 -translate-x-1/2 items-center justify-center gap-0.5 rounded-full border border-slate-300 bg-white px-1 text-[9px] text-slate-500 shadow-sm hover:bg-slate-50"
                >
                  {folded ? (
                    <>
                      <Plus className="h-3 w-3" />
                      {descendantsCount(site, n.id)}
                    </>
                  ) : (
                    <Minus className="h-3 w-3" />
                  )}
                </button>
              )}
              </div>
            );
          })}
        </div>
      </div>
      )}
    </div>
  );
}

// Topologia real de cada sede (Internet -> gateway -> switches -> APs ->
// servidores) armada con UniFi + agentes, con el estado de cada eslabon.
export default function NetworkTopology({ onServer }: { onServer: (id: string) => void }) {
  const { data } = useLiveData<{ sites: TopoSite[]; generatedAt: string }>('/api/topology/network', { event: 'soc:unifi', intervalMs: 60_000 });
  const [filter, setFilter] = useState('');
  const [closed, setClosed] = useState<Set<string>>(new Set());
  if (!data) return <p className="py-10 text-center text-sm text-slate-400">Armando la topología...</p>;
  const sites = data.sites.filter((s) => !filter || s.name.toLowerCase().includes(filter.toLowerCase()) || s.nodes.some((n) => n.name.toLowerCase().includes(filter.toLowerCase())));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
        <span>
          {data.sites.length} sede(s) · actualizada {timeAgo(data.generatedAt)} · la línea roja/punteada marca el eslabón caído
        </span>
        <span className="flex gap-1.5">
          <button onClick={() => setClosed(new Set())} className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 hover:bg-slate-50">
            Expandir todo
          </button>
          <button onClick={() => setClosed(new Set(data.sites.map((s) => s.id)))} className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 hover:bg-slate-50">
            Contraer todo
          </button>
        </span>
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filtrar sede o equipo..." className="w-52 rounded-lg border border-slate-300 px-2.5 py-1.5 outline-none focus:border-brand-500" />
      </div>
      {sites.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-400">Sin sedes que coincidan.</p>
      ) : (
        sites.map((s) => (
          <SiteMap
            key={s.id}
            site={s}
            onServer={onServer}
            open={!closed.has(s.id)}
            onToggle={() =>
              setClosed((prev) => {
                const next = new Set(prev);
                if (next.has(s.id)) next.delete(s.id);
                else next.add(s.id);
                return next;
              })
            }
          />
        ))
      )}
    </div>
  );
}
