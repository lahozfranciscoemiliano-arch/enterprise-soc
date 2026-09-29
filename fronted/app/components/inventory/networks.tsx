'use client';

import { useState } from 'react';
import { ChevronDown, Router } from 'lucide-react';
import { useLiveData } from './useLiveData';

export type NetworkInfo = { cidr: string; network: string; mask: string; gateway: string | null; servers: string[]; scopes: string[]; sources: string[] };

function ipToInt(ip: string | null | undefined): number | null {
  const p = String(ip ?? '').split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

/** Redes conocidas (ambitos DHCP, redes de cada sede y gateways de los agentes). */
export function useNetworks() {
  const { data } = useLiveData<NetworkInfo[]>('/api/inventory/networks', { intervalMs: 300_000 });
  return data ?? [];
}

/** Red a la que pertenece una IP (la mas especifica), o una /24 generica. */
export function networkOf(ip: string | null | undefined, nets: NetworkInfo[]): { key: string; label: string; gateway: string | null; servers: string[] } {
  const n = ipToInt(ip);
  if (n !== null) {
    let best: NetworkInfo | null = null;
    let bestBits = -1;
    for (const net of nets) {
      const [base, bits] = net.cidr.split('/');
      const b = Number(bits);
      const start = ipToInt(base);
      if (start === null) continue;
      const size = 2 ** (32 - b);
      if (n >= start && n < start + size && b > bestBits) {
        best = net;
        bestBits = b;
      }
    }
    if (best) return { key: best.cidr, label: best.cidr, gateway: best.gateway, servers: best.servers };
    const parts = String(ip).split('.');
    const key = `${parts.slice(0, 3).join('.')}.0/24`;
    return { key, label: key, gateway: null, servers: [] };
  }
  return { key: 'sin-ip', label: 'Sin IP', gateway: null, servers: [] };
}

export function sortNetKeys(a: string, b: string) {
  return (ipToInt(a.split('/')[0]) ?? Number.MAX_SAFE_INTEGER) - (ipToInt(b.split('/')[0]) ?? Number.MAX_SAFE_INTEGER);
}

/** Encabezado contraible de un grupo de red: "Red 192.168.109.0/24 · gateway .1 · BSFS2, KSFS2". */
export function NetworkGroup({
  label,
  gateway,
  servers,
  count,
  badge,
  defaultOpen = true,
  children,
}: {
  label: string;
  gateway: string | null;
  servers: string[];
  count?: number;
  badge?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border border-slate-200 bg-white">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-xs" aria-expanded={open}>
        <ChevronDown className={`h-4 w-4 text-slate-400 transition-transform ${open ? '' : '-rotate-90'}`} />
        <Router className="h-3.5 w-3.5 text-slate-400" />
        <span className="font-mono font-semibold text-slate-800">{label}</span>
        {gateway && <span className="text-slate-500">gateway <span className="font-mono">{gateway}</span></span>}
        {servers.length > 0 && <span className="truncate text-slate-400">· {servers.slice(0, 4).join(', ')}{servers.length > 4 ? ` +${servers.length - 4}` : ''}</span>}
        {badge}
        {count !== undefined && <span className="ml-auto rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-500">{count}</span>}
      </button>
      {open && <div className="border-t border-slate-100 p-3">{children}</div>}
    </div>
  );
}
