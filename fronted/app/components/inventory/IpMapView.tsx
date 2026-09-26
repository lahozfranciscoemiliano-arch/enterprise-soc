'use client';

import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Check, Copy } from 'lucide-react';
import { useLiveData } from './useLiveData';
import type { DhcpScopeRow, IpEntry, IpStatus } from '../../types';

const STATUS: Record<IpStatus, { label: string; cell: string; dot: string; hint: string }> = {
  lease: { label: 'Concedida (DHCP)', cell: 'bg-sky-500 hover:bg-sky-600', dot: 'bg-sky-500', hint: 'Entregada por el DHCP a un equipo' },
  reserved: { label: 'Reservada', cell: 'bg-violet-500 hover:bg-violet-600', dot: 'bg-violet-500', hint: 'Reserva DHCP (siempre la misma IP para ese equipo)' },
  static: { label: 'Fija en uso', cell: 'bg-slate-600 hover:bg-slate-700', dot: 'bg-slate-600', hint: 'Responde en la red pero no la dio el DHCP (IP fija)' },
  conflict: { label: 'Conflicto', cell: 'bg-red-500 hover:bg-red-600 animate-pulse', dot: 'bg-red-500', hint: 'El DHCP la rechazó porque otro equipo ya la usaba' },
  free: { label: 'Libre (rango DHCP)', cell: 'bg-emerald-400 hover:bg-emerald-500', dot: 'bg-emerald-400', hint: 'Libre para que el DHCP la entregue' },
  'free-static': { label: 'Libre para IP fija', cell: 'bg-emerald-100 hover:bg-emerald-200 ring-1 ring-inset ring-emerald-300', dot: 'bg-emerald-100 ring-1 ring-emerald-300', hint: 'Fuera del rango DHCP o excluida, y nadie responde: sirve para asignar una IP fija' },
};

function lastOctet(ip: string) {
  return ip.split('.').pop();
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
      className="flex items-center gap-1 rounded-md border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-500 transition-colors hover:bg-slate-50"
    >
      {done ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
      {done ? 'Copiado' : 'Copiar'}
    </button>
  );
}

export default function IpMapView() {
  const { data, error } = useLiveData<DhcpScopeRow[]>('/api/inventory/scopes');
  const [scopeId, setScopeId] = useState<string | null>(null);
  const [hover, setHover] = useState<IpEntry | null>(null);
  const [highlight, setHighlight] = useState<IpStatus | null>(null);
  const [search, setSearch] = useState('');

  const scopes = data ?? [];
  const scope = scopes.find((s) => s.id === scopeId) ?? scopes[0] ?? null;
  const q = search.trim().toLowerCase();
  const matchesSearch = (a: IpEntry) => !q || [a.ip, a.h, a.m, a.u].some((v) => v?.toLowerCase().includes(q));

  const freeList = useMemo(() => (scope ? scope.addresses.filter((a) => a.s === 'free' || a.s === 'free-static') : []), [scope]);

  if (error) return <p className="text-xs text-red-600">{error}</p>;
  if (data === null) return <p className="py-6 text-center text-sm text-slate-400">Cargando...</p>;
  if (!scope) {
    return (
      <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-xs text-slate-500">
        Sin ámbitos todavía: aparecen cuando el agente de BSFS2 (servidor DHCP) manda su primer inventario.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {scopes.map((s) => (
          <button
            key={s.id}
            onClick={() => setScopeId(s.id)}
            className={`rounded-lg border px-3 py-1.5 text-left text-xs transition-colors ${
              s.id === scope.id ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            <span className="block font-semibold">{s.name ?? s.id}</span>
            <span className="block text-[10px] text-slate-400">
              {s.id} · {s.percentInUse}% en uso
            </span>
          </button>
        ))}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Resaltar IP, equipo, MAC, usuario..."
          className="ml-auto w-60 rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs outline-none focus:border-brand-500"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
            <span>
              Rango DHCP <b className="font-mono text-slate-700">{scope.startRange}</b> → <b className="font-mono text-slate-700">{scope.endRange}</b> · máscara {scope.mask}
              {scope.leaseHours ? ` · concesión ${scope.leaseHours} h` : ''}
            </span>
            <span className="h-2 w-40 overflow-hidden rounded-full bg-slate-100" title={`${scope.percentInUse}% del rango DHCP en uso`}>
              <motion.span
                className={`block h-full ${scope.percentInUse >= 95 ? 'bg-red-500' : scope.percentInUse >= 85 ? 'bg-amber-500' : 'bg-sky-500'}`}
                initial={{ width: 0 }}
                animate={{ width: `${scope.percentInUse}%` }}
              />
            </span>
          </div>

          <div className="grid gap-1" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(26px, 1fr))' }}>
            {scope.addresses.map((a) => {
              const dim = (highlight && a.s !== highlight) || (q && !matchesSearch(a));
              return (
                <button
                  key={a.ip}
                  onMouseEnter={() => setHover(a)}
                  onFocus={() => setHover(a)}
                  className={`flex h-6 items-center justify-center rounded text-[9px] font-medium transition-all ${STATUS[a.s].cell} ${
                    a.s === 'free-static' ? 'text-emerald-800' : 'text-white'
                  } ${dim ? 'opacity-15' : ''}`}
                  title={`${a.ip} — ${STATUS[a.s].label}${a.h ? ` — ${a.h}` : ''}${a.u ? ` (${a.u})` : ''}`}
                >
                  {lastOctet(a.ip)}
                </button>
              );
            })}
          </div>

          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5">
            {(Object.keys(STATUS) as IpStatus[]).map((s) => (
              <button
                key={s}
                onClick={() => setHighlight((h) => (h === s ? null : s))}
                title={STATUS[s].hint}
                className={`flex items-center gap-1.5 text-[11px] transition-opacity ${highlight && highlight !== s ? 'opacity-40' : ''}`}
              >
                <span className={`h-3 w-3 rounded ${STATUS[s].dot}`} />
                {STATUS[s].label}
                <span className="font-semibold text-slate-700">{scope.counts[s]}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-3">
          <div className="min-h-[132px] rounded-xl border border-slate-200 bg-white p-4 text-xs">
            {hover ? (
              <>
                <p className="font-mono text-base font-semibold text-slate-900">{hover.ip}</p>
                <p className="mt-1 flex items-center gap-1.5">
                  <span className={`h-2.5 w-2.5 rounded ${STATUS[hover.s].dot}`} />
                  {STATUS[hover.s].label}
                </p>
                <div className="mt-2 space-y-0.5 text-[11px] text-slate-600">
                  {hover.h && <p>Equipo: <b>{hover.h}</b></p>}
                  {hover.u && <p>Último usuario: <b>{hover.u}</b></p>}
                  {hover.m && <p className="font-mono">MAC {hover.m}</p>}
                  <p>{hover.a ? 'Responde en la red' : 'No responde'}</p>
                  {hover.e && <p>Concesión vence {new Date(hover.e).toLocaleString('es-ES')}</p>}
                </div>
              </>
            ) : (
              <p className="text-slate-400">Pasá el mouse por una IP para ver el detalle.</p>
            )}
          </div>

          <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-4">
            <div className="mb-1 flex items-center justify-between">
              <p className="text-xs font-semibold text-emerald-900">Libres para IP fija ({scope.counts['free-static']})</p>
              {scope.freeStaticRanges.length > 0 && <CopyButton text={scope.freeStaticRanges.join(', ')} />}
            </div>
            <p className="mb-2 text-[10px] text-emerald-800/70">Fuera del rango DHCP y sin nadie respondiendo: seguras para impresoras, relojes, cámaras.</p>
            <ul className="max-h-32 space-y-0.5 overflow-y-auto font-mono text-[11px] text-emerald-900">
              {scope.freeStaticRanges.length === 0 ? <li className="font-sans text-slate-500">Ninguna</li> : scope.freeStaticRanges.map((r) => <li key={r}>{r}</li>)}
            </ul>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="mb-1 flex items-center justify-between">
              <p className="text-xs font-semibold text-slate-800">Libres en el rango DHCP ({scope.counts.free})</p>
              {scope.freeRanges.length > 0 && <CopyButton text={scope.freeRanges.join(', ')} />}
            </div>
            <ul className="max-h-32 space-y-0.5 overflow-y-auto font-mono text-[11px] text-slate-700">
              {scope.freeRanges.length === 0 ? <li className="font-sans text-red-600">Ninguna: el ámbito está agotado</li> : scope.freeRanges.map((r) => <li key={r}>{r}</li>)}
            </ul>
          </div>
          <p className="text-[10px] text-slate-400">
            {freeList.length} IP(s) libres en total. Se considera libre la que no tiene concesión ni reserva y no responde a ping ni a puertos comunes.
          </p>
        </div>
      </div>
    </div>
  );
}
