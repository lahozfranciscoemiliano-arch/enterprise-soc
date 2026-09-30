'use client';

import { Building2, Cpu, Globe2, MapPin, Shuffle, X } from 'lucide-react';

export type MacInfo = {
  mac: string;
  oui: string;
  vendor: string | null;
  address?: string | null;
  country?: string | null;
  block?: string | null;
  prefix?: string | null;
  source?: string | null;
  kind?: string | null;
  note?: string | null;
  randomized: boolean;
  multicast: boolean;
  administration: string;
  transmission: string;
  location?: {
    ip: string | null;
    hostname: string | null;
    site: string | null;
    switchName: string | null;
    switchPort: number | null;
    apName: string | null;
    essid: string | null;
    kind: string | null;
    lastUser?: string | null;
    firstSeenAt?: string | null;
  } | null;
};

const BLOCK_LABEL: Record<string, string> = {
  'MA-L': 'MA-L (bloque grande, 16 M direcciones)',
  'MA-M': 'MA-M (bloque mediano, 1 M direcciones)',
  'MA-S': 'MA-S (bloque chico, 4.096 direcciones)',
  IAB: 'IAB (bloque chico, 4.096 direcciones)',
};

function Row({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex gap-2 py-0.5">
      <span className="w-40 shrink-0 text-slate-400">{label}</span>
      <span className={`min-w-0 break-words text-slate-700 ${mono ? 'font-mono' : ''}`}>{value ?? '—'}</span>
    </div>
  );
}

/** Resultado de la busqueda por MAC: fabricante (IEEE / en linea), tipo de bloque y lo que sabe el NOC. */
export default function MacInfoCard({ info, onClose }: { info: MacInfo; onClose?: () => void }) {
  const loc = info.location;
  const where = loc?.switchName
    ? `Switch "${loc.switchName}"${loc.switchPort ? ` · puerto ${loc.switchPort}` : ''}`
    : loc?.apName
      ? `WiFi · AP "${loc.apName}"${loc.essid ? ` (${loc.essid})` : ''}`
      : null;
  return (
    <div className="mt-2 rounded-xl border border-sky-200 bg-sky-50/60 p-3 text-[11px]">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <p className="font-mono text-sm font-semibold text-slate-900">{info.mac.toUpperCase()}</p>
          <p className="flex items-center gap-1 text-sm font-semibold text-sky-900">
            {info.randomized ? <Shuffle className="h-3.5 w-3.5" /> : <Building2 className="h-3.5 w-3.5" />}
            {info.vendor ?? (info.randomized ? 'MAC aleatoria (privada)' : 'Fabricante no registrado')}
          </p>
          {info.kind && (
            <p className="flex items-center gap-1 text-slate-600">
              <Cpu className="h-3 w-3" /> Tipo probable: <b>{info.kind}</b>
            </p>
          )}
        </div>
        {onClose && (
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-white" aria-label="Cerrar">
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="grid gap-x-6 md:grid-cols-2">
        <div>
          <Row label="Dirección del fabricante" value={info.address} />
          <Row label="País" value={info.country ? <span className="inline-flex items-center gap-1"><Globe2 className="h-3 w-3" />{info.country}</span> : null} />
          <Row label="OUI / prefijo" value={info.prefix ?? info.oui.toUpperCase()} mono />
          <Row label="Bloque IEEE" value={info.block ? BLOCK_LABEL[info.block] ?? info.block : null} />
          <Row label="Fuente" value={info.source === 'IEEE' ? 'Registro oficial IEEE' : info.source === 'maclookup.app' ? 'Base en línea (maclookup.app)' : info.source} />
        </div>
        <div>
          <Row label="Administración" value={info.administration} />
          <Row label="Transmisión" value={info.transmission} />
          <Row label="IP / nombre en la red" value={loc?.ip || loc?.hostname ? `${loc?.ip ?? '—'}${loc?.hostname ? ` · ${loc.hostname}` : ''}` : null} />
          {loc?.lastUser && <Row label="Usuario del dominio" value={loc.lastUser} />}
          <Row label="Dónde está conectado" value={where ? <span className="inline-flex items-center gap-1 font-medium text-sky-800"><MapPin className="h-3 w-3" />{where}{loc?.site ? ` · ${loc.site}` : ''}</span> : 'Sin datos de UniFi'} />
        </div>
      </div>
      {info.note && <p className="mt-2 text-slate-500">{info.note}</p>}
    </div>
  );
}
