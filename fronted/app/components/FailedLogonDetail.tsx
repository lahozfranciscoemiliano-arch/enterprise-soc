'use client';

import { useState } from 'react';
import { ChevronDown, Globe, Monitor, ShieldAlert } from 'lucide-react';

export type FailedLogonSource = {
  ip: string | null;
  workstation: string | null;
  hostname?: string | null;
  knownAs?: string | null;
  domainUser?: string | null;
  mac?: string | null;
  vendor?: string | null;
  count: number;
  first: string | null;
  last: string | null;
  public: boolean;
  users: { name: string; count: number }[];
  logonTypes: Record<string, number>;
  reasons: Record<string, number>;
  processes: { name: string; count: number }[];
  packages?: { name: string; count: number }[];
  mainTypeLabel?: string | null;
  mainReasonLabel?: string | null;
};

export type FailedLogonDetailData = {
  total: number;
  truncated?: boolean;
  byHour: number[];
  logonTypes: Record<string, number>;
  sourceCount: number;
  sources: FailedLogonSource[];
  users: { user: string; count: number; sources: number }[];
};

const LOGON_TYPE: Record<string, string> = {
  '2': 'Local',
  '3': 'Red (SMB)',
  '4': 'Tarea programada',
  '5': 'Servicio',
  '7': 'Desbloqueo',
  '8': 'Red texto plano',
  '9': 'RunAs',
  '10': 'RDP',
  '11': 'Caché',
};
const REASON: Record<string, string> = {
  '0xc000006a': 'contraseña incorrecta',
  '0xc0000064': 'usuario inexistente',
  '0xc000006d': 'usuario/contraseña incorrectos',
  '0xc0000072': 'cuenta deshabilitada',
  '0xc0000234': 'cuenta bloqueada',
  '0xc0000071': 'contraseña vencida',
  '0xc0000193': 'cuenta vencida',
  '0xc0000224': 'debe cambiar la contraseña',
  '0xc000006f': 'fuera de horario',
  '0xc0000070': 'equipo no permitido',
  '0xc000015b': 'tipo de inicio no permitido',
  '0xc0000133': 'reloj desfasado',
};

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const list = (o: Record<string, number>, map: Record<string, string>) =>
  Object.entries(o)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${map[k.toLowerCase()] ?? map[k] ?? k} ×${v}`)
    .join(', ');

/** De donde vienen los inicios de sesion fallidos: origen, usuario, via y motivo. */
export default function FailedLogonDetail({ detail, defaultOpen = false }: { detail: FailedLogonDetailData; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const max = Math.max(1, ...detail.byHour);
  const internet = detail.sources.filter((s) => s.public).length;
  return (
    <div className="mt-1.5">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 text-[11px] font-medium text-red-700 hover:text-red-800" aria-expanded={open}>
        <ShieldAlert className="h-3 w-3" />
        Ver de dónde vienen los {detail.total}
        {detail.truncated ? '+' : ''} intentos ({detail.sourceCount} origen/es{internet ? ` · ${internet} desde internet` : ''})
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="mt-2 space-y-3 rounded-lg border border-red-100 bg-white p-3 text-[11px]">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left">
              <thead>
                <tr className="border-b border-slate-200 text-slate-400">
                  <th className="py-1 pr-2 font-medium">Origen (IP / equipo)</th>
                  <th className="py-1 pr-2 font-medium">Usuario(s) que intenta</th>
                  <th className="py-1 pr-2 font-medium">Vía</th>
                  <th className="py-1 pr-2 font-medium">Motivo del fallo</th>
                  <th className="py-1 pr-2 text-right font-medium">Intentos</th>
                  <th className="py-1 font-medium">Primero / último</th>
                </tr>
              </thead>
              <tbody>
                {detail.sources.map((s) => (
                  <tr key={`${s.ip}-${s.workstation}`} className={`border-b border-slate-50 align-top ${s.public ? 'bg-red-50/70' : ''}`}>
                    <td className="py-1.5 pr-2">
                      <span className="flex items-center gap-1 font-mono font-semibold text-slate-800">
                        {s.public ? <Globe className="h-3 w-3 text-red-600" /> : <Monitor className="h-3 w-3 text-slate-400" />}
                        {s.ip ?? 'sin IP'}
                      </span>
                      {s.public && <span className="rounded bg-red-600 px-1 text-[9px] font-bold uppercase text-white">internet</span>}
                      {(s.hostname || s.knownAs) && <span className="block text-slate-600">{s.knownAs ?? s.hostname}</span>}
                      {s.domainUser && <span className="block text-slate-400">usa: {s.domainUser}</span>}
                      {(s.mac || s.vendor) && (
                        <span className="block font-mono text-[10px] text-slate-400">
                          {s.mac} {s.vendor ? `· ${s.vendor}` : ''}
                        </span>
                      )}
                      {!s.ip && !s.hostname && <span className="block text-slate-400">proceso del propio servidor</span>}
                    </td>
                    <td className="py-1.5 pr-2">
                      {s.users.map((u) => (
                        <span key={u.name} className="block">
                          <b className="font-medium text-slate-700">{u.name}</b> <span className="text-slate-400">×{u.count}</span>
                        </span>
                      ))}
                    </td>
                    <td className="py-1.5 pr-2 text-slate-600">
                      {list(s.logonTypes, LOGON_TYPE)}
                      {s.processes?.[0] && <span className="block text-[10px] text-slate-400">proceso: {s.processes.map((p) => p.name).join(', ')}</span>}
                    </td>
                    <td className="py-1.5 pr-2 text-slate-600">{list(s.reasons, REASON)}</td>
                    <td className="py-1.5 pr-2 text-right font-semibold tabular-nums text-slate-800">{s.count}</td>
                    <td className="py-1.5 tabular-nums text-slate-500">
                      {fmt(s.first)}
                      <span className="block">{fmt(s.last)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <p className="mb-1 font-semibold text-slate-600">Usuarios más intentados</p>
              <ul className="space-y-0.5">
                {detail.users.map((u) => (
                  <li key={u.user} className="flex justify-between gap-2">
                    <span className="truncate text-slate-700">{u.user}</span>
                    <span className="shrink-0 text-slate-400">
                      ×{u.count} · {u.sources} origen/es
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="mb-1 font-semibold text-slate-600">Intentos por hora (últimas 24 h)</p>
              <div className="flex h-16 items-end gap-[2px]">
                {detail.byHour.map((v, i) => (
                  <span
                    key={i}
                    title={`hace ${23 - i} h: ${v}`}
                    className={`flex-1 rounded-t ${v ? 'bg-red-400' : 'bg-slate-100'}`}
                    style={{ height: `${Math.max(4, (v / max) * 100)}%` }}
                  />
                ))}
              </div>
              <p className="mt-0.5 flex justify-between text-[9px] text-slate-400">
                <span>hace 24 h</span>
                <span>ahora</span>
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
