'use client';

import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, Boxes, ClipboardCheck, Cloud, Cpu, HardDrive, MapPin, MemoryStick, Pencil, Search, Server, ShieldCheck } from 'lucide-react';
import StatCard from '../StatCard';
import ServerVisual from './ServerVisual';
import ServerAssetModal, { STATUS_PILL, WARRANTY_BADGE } from './ServerAssetModal';
import { useLiveData } from '../inventory/useLiveData';
import { BRANDS, FORM_FACTOR_LABEL, completeness, fmtBytes, resolveSpecs, type AssetServer } from '../../lib/serverCatalog';

type Filter = 'todos' | 'fisicos' | 'virtuales' | 'garantia' | 'incompletos' | 'offline';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'todos', label: 'Todos' },
  { id: 'fisicos', label: 'Físicos' },
  { id: 'virtuales', label: 'Virtuales' },
  { id: 'garantia', label: 'Garantía a revisar' },
  { id: 'incompletos', label: 'Ficha incompleta' },
  { id: 'offline', label: 'Sin conexión' },
];

export function useAssets() {
  return useLiveData<AssetServer[]>('/api/assets', { event: 'soc:assets', intervalMs: 300_000 });
}

function Chip({ icon: Icon, children, title }: { icon: typeof Cpu; children: React.ReactNode; title?: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-600" title={title}>
      <Icon className="h-3 w-3 shrink-0 text-slate-400" />
      <span className="truncate">{children}</span>
    </span>
  );
}

function ServerCard({ server, onOpen, onEdit, isAdmin }: { server: AssetServer; onOpen: () => void; onEdit: () => void; isAdmin: boolean }) {
  const r = resolveSpecs(server);
  const comp = completeness(server);
  const pill = STATUS_PILL[server.status] ?? STATUS_PILL.OFFLINE;
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.2 }}
      className="group flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card transition-shadow hover:shadow-card-hover"
    >
      <button onClick={onOpen} className="relative block text-left" aria-label={`Ver ficha de ${server.name}`}>
        <ServerVisual serverId={server.id} photoAt={server.photoAt} profile={r.profile} status={server.status} className="h-44 transition-transform duration-300 group-hover:scale-[1.02]" />
        <span className={`absolute left-3 top-3 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 backdrop-blur ${pill.cls}`}>{pill.label}</span>
        <span className="absolute right-3 top-3 rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-medium text-slate-200 ring-1 ring-white/15 backdrop-blur">
          {FORM_FACTOR_LABEL[r.profile.formFactor]}
        </span>
      </button>
      <div className="flex flex-1 flex-col p-4">
        <div className="flex items-start justify-between gap-2">
          <button onClick={onOpen} className="min-w-0 text-left">
            <p className="text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: r.profile.accent }}>
              {r.profile.brandLabel}
            </p>
            <h3 className="truncate text-base font-semibold text-slate-900">{server.name}</h3>
            <p className="truncate text-xs text-slate-500">{r.profile.model || 'Modelo sin detectar'}</p>
          </button>
          {isAdmin && (
            <button onClick={onEdit} className="shrink-0 rounded-lg p-1.5 text-slate-400 opacity-70 hover:bg-slate-100 hover:text-slate-700 group-hover:opacity-100" title="Editar ficha">
              <Pencil className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {r.cpuShort && (
            <Chip icon={Cpu} title={r.cpu.value ?? undefined}>
              {r.coresLabel ?? r.cpuShort.replace(/^(Intel|AMD)\s+/, '')}
            </Chip>
          )}
          {r.ram.value && <Chip icon={MemoryStick}>{r.ram.value}</Chip>}
          {(server.asset.storage || r.diskTotal > 0) && (
            <Chip icon={HardDrive} title={r.storage.value ?? undefined}>
              {server.asset.storage ?? fmtBytes(r.diskTotal)}
            </Chip>
          )}
        </div>
        {r.cpuShort && <p className="mt-2 truncate text-[11px] text-slate-400" title={r.cpu.value ?? undefined}>{r.cpuShort}</p>}

        <div className="mt-auto space-y-2 pt-3">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className={`rounded-full px-2 py-0.5 font-medium ring-1 ${WARRANTY_BADGE[r.warranty.tone]}`}>{r.warranty.label}</span>
            {server.asset.location && (
              <span className="inline-flex min-w-0 items-center gap-1 text-slate-500" title={server.asset.location}>
                <MapPin className="h-3 w-3 shrink-0" /> <span className="truncate">{server.asset.location}</span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 text-[10px] text-slate-400">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-slate-100" title={comp.missing.length ? `Falta: ${comp.missing.join(', ')}` : 'Ficha completa'}>
              <div className={`h-full rounded-full ${comp.pct === 100 ? 'bg-emerald-500' : comp.pct >= 60 ? 'bg-brand-500' : 'bg-amber-500'}`} style={{ width: `${comp.pct}%` }} />
            </div>
            <span>Ficha {comp.pct}%</span>
          </div>
          <p className="truncate font-mono text-[10px] text-slate-400">
            {server.ipAddress ?? 'sin IP'} · S/N {r.serial.value ?? '—'}
          </p>
        </div>
      </div>
    </motion.div>
  );
}

/** Vista principal: galeria del parque de servidores. `adminList` muestra la tabla para completar fichas. */
export default function ServerFleet({ isAdmin, adminList = false }: { isAdmin: boolean; adminList?: boolean }) {
  const { data, error, reload } = useAssets();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('todos');
  const [brand, setBrand] = useState('');
  const [open, setOpen] = useState<{ id: string; edit: boolean } | null>(null);

  const rows = useMemo(
    () =>
      (data ?? []).map((s) => {
        const r = resolveSpecs(s);
        return { s, r, comp: completeness(s) };
      }),
    [data]
  );

  const kpis = useMemo(() => {
    const virtual = rows.filter((x) => x.r.profile.formFactor === 'vm').length;
    const warranty = rows.filter((x) => x.r.warranty.tone === 'warn' || x.r.warranty.tone === 'bad').length;
    const incomplete = rows.filter((x) => x.comp.pct < 100).length;
    return { total: rows.length, physical: rows.length - virtual, virtual, warranty, incomplete };
  }, [rows]);

  const brands = useMemo(() => [...new Set(rows.map((x) => x.r.profile.brandLabel))].sort(), [rows]);

  const visible = rows.filter(({ s, r, comp }) => {
    if (filter === 'fisicos' && r.profile.formFactor === 'vm') return false;
    if (filter === 'virtuales' && r.profile.formFactor !== 'vm') return false;
    if (filter === 'garantia' && !(r.warranty.tone === 'warn' || r.warranty.tone === 'bad')) return false;
    if (filter === 'incompletos' && comp.pct === 100) return false;
    if (filter === 'offline' && s.status !== 'OFFLINE') return false;
    if (brand && r.profile.brandLabel !== brand) return false;
    if (!query.trim()) return true;
    const q = query.trim().toLowerCase();
    return [s.name, s.hostname, s.ipAddress, r.profile.brandLabel, r.profile.model, r.serial.value, s.asset.location, s.asset.role, r.cpu.value]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q));
  });

  const current = open ? data?.find((s) => s.id === open.id) ?? null : null;
  const onSaved = () => {
    reload();
    window.dispatchEvent(new Event('soc:assets'));
  };

  if (error && !data) return <p className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</p>;

  return (
    <div className="space-y-5">
      {!adminList && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatCard label="Servidores" value={String(kpis.total)} icon={<Server />} />
          <StatCard label="Físicos" value={String(kpis.physical)} icon={<Boxes />} color="emerald" />
          <StatCard label="Virtuales" value={String(kpis.virtual)} icon={<Cloud />} />
          <StatCard label="Garantía a revisar" value={String(kpis.warranty)} icon={<ShieldCheck />} color={kpis.warranty ? 'amber' : 'emerald'} />
          <StatCard label="Fichas incompletas" value={String(kpis.incomplete)} icon={<ClipboardCheck />} color={kpis.incomplete ? 'amber' : 'emerald'} />
        </div>
      )}

      <div className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-card sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar por nombre, IP, marca, modelo, serie, ubicación..."
            className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm focus:border-brand-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-500/20"
          />
        </div>
        <select value={brand} onChange={(e) => setBrand(e.target.value)} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
          <option value="">Todas las marcas</option>
          {brands.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        <div className="no-scrollbar flex gap-1 overflow-x-auto">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                filter === f.id ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {!data ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-80 animate-pulse rounded-2xl bg-slate-100" />
          ))}
        </div>
      ) : adminList ? (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Servidor</th>
                  <th className="px-4 py-2.5 font-medium">Marca / modelo</th>
                  <th className="px-4 py-2.5 font-medium">N° de serie</th>
                  <th className="px-4 py-2.5 font-medium">Ubicación</th>
                  <th className="px-4 py-2.5 font-medium">Garantía</th>
                  <th className="px-4 py-2.5 font-medium">Ficha</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visible.map(({ s, r, comp }) => (
                  <tr key={s.id} className="hover:bg-slate-50/70">
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-3">
                        <ServerVisual serverId={s.id} photoAt={s.photoAt} profile={r.profile} status={s.status} className="h-10 w-16 shrink-0 rounded-md" compact />
                        <div className="min-w-0">
                          <p className="truncate font-medium text-slate-800">{s.name}</p>
                          <p className="truncate font-mono text-[11px] text-slate-400">{s.ipAddress ?? '—'}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      <p className="text-xs font-semibold" style={{ color: r.profile.accent }}>
                        {r.profile.brandLabel}
                      </p>
                      <p className="truncate text-xs text-slate-500">{r.profile.model || '—'}</p>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-600">{r.serial.value ?? '—'}</td>
                    <td className="max-w-[200px] truncate px-4 py-2 text-xs text-slate-600">{s.asset.location ?? <span className="text-slate-300">Sin cargar</span>}</td>
                    <td className="px-4 py-2">
                      <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${WARRANTY_BADGE[r.warranty.tone]}`}>{r.warranty.label}</span>
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2" title={comp.missing.length ? `Falta: ${comp.missing.join(', ')}` : 'Ficha completa'}>
                        <div className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-100">
                          <div className={`h-full rounded-full ${comp.pct === 100 ? 'bg-emerald-500' : comp.pct >= 60 ? 'bg-brand-500' : 'bg-amber-500'}`} style={{ width: `${comp.pct}%` }} />
                        </div>
                        <span className="text-[11px] text-slate-500">{comp.pct}%</span>
                      </div>
                    </td>
                    <td className="px-4 py-2 text-right">
                      <button
                        onClick={() => setOpen({ id: s.id, edit: true })}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                      >
                        <Pencil className="h-3.5 w-3.5" /> Editar ficha
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <motion.div layout className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          <AnimatePresence>
            {visible.map(({ s }) => (
              <ServerCard key={s.id} server={s} isAdmin={isAdmin} onOpen={() => setOpen({ id: s.id, edit: false })} onEdit={() => setOpen({ id: s.id, edit: true })} />
            ))}
          </AnimatePresence>
        </motion.div>
      )}

      {data && !visible.length && (
        <p className="flex items-center gap-2 rounded-xl border border-dashed border-slate-300 p-6 text-sm text-slate-500">
          <AlertTriangle className="h-4 w-4" /> No hay servidores que coincidan con el filtro.
        </p>
      )}

      {data && !adminList && (
        <p className="text-[11px] text-slate-400">
          La imagen de cada servidor se genera sola según la marca, el modelo y el formato detectados ({Object.values(BRANDS).length - 1} marcas reconocidas). Un
          administrador puede reemplazarla por una foto real desde la ficha.
        </p>
      )}

      <AnimatePresence>
        {current && open && (
          <ServerAssetModal key={`${current.id}-${open.edit}`} server={current} isAdmin={isAdmin} startEditing={open.edit} onClose={() => setOpen(null)} onSaved={onSaved} />
        )}
      </AnimatePresence>
    </div>
  );
}
