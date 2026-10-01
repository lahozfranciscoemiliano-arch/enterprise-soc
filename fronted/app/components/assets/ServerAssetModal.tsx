'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Camera,
  Cpu,
  HardDrive,
  ImageOff,
  MemoryStick,
  Network as NetworkIcon,
  Pencil,
  Save,
  ShieldCheck,
  Sparkles,
  Wand2,
  X,
  type LucideIcon,
} from 'lucide-react';
import ServerVisual from './ServerVisual';
import { API_URL } from '../inventory/useLiveData';
import { useToast } from '../Toast';
import { formatUptime, timeAgo } from '../../lib/health';
import {
  BRANDS,
  FORM_FACTOR_LABEL,
  detectProfile,
  fmtBytes,
  resolveSpecs,
  shortCpu,
  type AssetServer,
  type FormFactor,
  type ServerAssetInfo,
  type Spec,
} from '../../lib/serverCatalog';

export const STATUS_PILL: Record<string, { label: string; cls: string }> = {
  ONLINE: { label: 'En línea', cls: 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/30' },
  DEGRADED: { label: 'Degradado', cls: 'bg-amber-500/15 text-amber-300 ring-amber-400/30' },
  OFFLINE: { label: 'Sin conexión', cls: 'bg-red-500/15 text-red-300 ring-red-400/30' },
};

export const WARRANTY_BADGE: Record<string, string> = {
  ok: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  warn: 'bg-amber-50 text-amber-700 ring-amber-200',
  bad: 'bg-red-50 text-red-700 ring-red-200',
  none: 'bg-slate-100 text-slate-500 ring-slate-200',
};

type Draft = Record<keyof ServerAssetInfo, string>;
const FIELDS: (keyof ServerAssetInfo)[] = [
  'brand',
  'model',
  'serial',
  'assetTag',
  'formFactor',
  'cpu',
  'ramGb',
  'storage',
  'raid',
  'psu',
  'os',
  'role',
  'location',
  'rack',
  'purchaseDate',
  'warrantyUntil',
  'supplier',
  'supportContact',
  'notes',
];

function toDraft(a: ServerAssetInfo): Draft {
  return Object.fromEntries(FIELDS.map((k) => [k, a[k] === undefined || a[k] === null ? '' : String(a[k])])) as Draft;
}

function fromDraft(d: Draft): ServerAssetInfo {
  const out: Record<string, unknown> = {};
  for (const k of FIELDS) {
    const v = d[k].trim();
    if (!v) continue;
    out[k] = k === 'ramGb' ? Number(v.replace(',', '.')) : v;
  }
  return out as ServerAssetInfo;
}

// Achica la foto en el navegador (max 1280 px, WEBP/JPEG) antes de subirla.
async function shrinkImage(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const webp = canvas.toDataURL('image/webp', 0.86);
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.86);
}

function SourceTag({ source }: { source: Spec['source'] }) {
  if (!source) return null;
  return (
    <span
      className={`rounded px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide ${
        source === 'agente' ? 'bg-sky-50 text-sky-600' : 'bg-violet-50 text-violet-600'
      }`}
      title={source === 'agente' ? 'Detectado automáticamente por el agente' : 'Cargado a mano en la ficha'}
    >
      {source === 'agente' ? 'Agente' : 'Manual'}
    </span>
  );
}

function SpecRow({ label, spec, mono, wide }: { label: string; spec: Spec; mono?: boolean; wide?: boolean }) {
  return (
    <div className={`flex min-w-0 flex-col gap-0.5 rounded-lg bg-slate-50 px-3 py-2 ${wide ? 'sm:col-span-2' : ''}`}>
      <span className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-slate-400">
        {label} <SourceTag source={spec.source} />
      </span>
      <span className={`truncate text-sm ${spec.value ? 'text-slate-800' : 'text-slate-300'} ${mono ? 'font-mono text-[13px]' : ''}`} title={spec.value ?? undefined}>
        {spec.value ?? 'Sin dato'}
      </span>
    </div>
  );
}

function Section({ icon: Icon, title, children, right }: { icon: LucideIcon; title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h4 className="flex items-center gap-2 text-sm font-semibold text-slate-800">
          <Icon className="h-4 w-4 text-slate-400" /> {title}
        </h4>
        {right}
      </div>
      {children}
    </section>
  );
}

function UsageBar({ label, value }: { label: string; value: number | null }) {
  const v = value ?? 0;
  const color = v >= 90 ? 'bg-red-500' : v >= 75 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs text-slate-500">
        <span>{label}</span>
        <span className="font-medium text-slate-700">{value === null ? '—' : `${Math.round(v)}%`}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(100, v)}%` }} />
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  list,
  wide,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string | null;
  type?: string;
  list?: string;
  wide?: boolean;
}) {
  return (
    <label className={`flex flex-col gap-1 text-xs font-medium text-slate-600 ${wide ? 'sm:col-span-2' : ''}`}>
      {label}
      <input
        type={type}
        value={value}
        list={list}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? ''}
        className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal text-slate-800 placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
      />
    </label>
  );
}

export default function ServerAssetModal({
  server,
  isAdmin,
  startEditing = false,
  onClose,
  onSaved,
}: {
  server: AssetServer;
  isAdmin: boolean;
  startEditing?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(startEditing && isAdmin);
  const [draft, setDraft] = useState<Draft>(() => toDraft(server.asset ?? {}));
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const specs = useMemo(() => resolveSpecs(server), [server]);
  const hw = server.hardware;
  // Mientras se edita, la imagen se actualiza en vivo con la marca / modelo / formato.
  const profile = useMemo(() => (editing ? detectProfile(hw, fromDraft(draft)) : specs.profile), [editing, hw, draft, specs.profile]);
  const set = (k: keyof ServerAssetInfo) => (v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const pill = STATUS_PILL[server.status] ?? STATUS_PILL.OFFLINE;

  const fillDetected = () => {
    setDraft((d) => ({
      ...d,
      brand: d.brand || (specs.profile.brandKey === 'generic' ? hw?.manufacturer ?? '' : specs.profile.brandLabel),
      model: d.model || specs.profile.model || '',
      serial: d.serial || hw?.serial || '',
      assetTag: d.assetTag || hw?.assetTag || '',
      cpu: d.cpu || (hw?.cpu ? `${hw.cpuCount && hw.cpuCount > 1 ? `${hw.cpuCount}× ` : ''}${shortCpu(hw.cpu)}` : ''),
      ramGb: d.ramGb || (specs.ramGbDetected ? String(specs.ramGbDetected) : ''),
      storage: d.storage || (specs.storage.source === 'agente' ? specs.storage.value ?? '' : ''),
      os: d.os || hw?.os?.replace(/^Microsoft /, '') || '',
    }));
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/api/assets/${server.id}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fromDraft(draft)),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'No se pudo guardar la ficha');
      toast.success(`Ficha de ${server.name} guardada`);
      setEditing(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo guardar la ficha');
    } finally {
      setSaving(false);
    }
  };

  const uploadPhoto = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const dataUrl = await shrinkImage(file);
      const res = await fetch(`${API_URL}/api/assets/${server.id}/photo`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'No se pudo subir la foto');
      toast.success('Foto actualizada');
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo subir la foto');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const removePhoto = async () => {
    const res = await fetch(`${API_URL}/api/assets/${server.id}/photo`, { method: 'DELETE', credentials: 'include' });
    if (res.ok) {
      toast.success('Se vuelve a usar la imagen automática');
      onSaved();
    } else toast.error('No se pudo quitar la foto');
  };

  const memModules = hw?.memoryModules ?? [];
  const memGroups = Object.entries(
    memModules.reduce<Record<string, number>>((acc, m) => {
      const key = `${m.sizeBytes ? Math.round(m.sizeBytes / 1024 ** 3) : '?'} GB${m.speedMhz ? ` · ${m.speedMhz} MHz` : ''}${m.maker && !/^0+$|unknown/i.test(m.maker) ? ` · ${m.maker}` : ''}`;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {})
  );

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/50 backdrop-blur-[2px] sm:items-center sm:p-4" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, y: 24, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.2 }}
        onClick={(e) => e.stopPropagation()}
        className="max-h-[94vh] w-full max-w-6xl overflow-y-auto rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl"
      >
        {/* Encabezado oscuro con la imagen */}
        <div className="grid gap-0 lg:grid-cols-[minmax(0,420px)_1fr]">
          <div className="relative">
            <ServerVisual serverId={server.id} photoAt={server.photoAt} profile={profile} status={server.status} className="h-60 sm:h-72 lg:h-full lg:min-h-[320px] lg:rounded-tl-2xl" />
            <div className="absolute left-3 top-3 flex flex-wrap gap-1.5">
              <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 backdrop-blur ${pill.cls}`}>{pill.label}</span>
              <span className="rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium text-slate-200 ring-1 ring-white/15 backdrop-blur">
                {FORM_FACTOR_LABEL[profile.formFactor]}
              </span>
            </div>
            {isAdmin && (
              <div className="absolute bottom-3 left-3 right-3 flex flex-wrap gap-2">
                <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => uploadPhoto(e.target.files?.[0])} />
                <button
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                  className="flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium text-white ring-1 ring-white/20 backdrop-blur hover:bg-white/20 disabled:opacity-50"
                >
                  <Camera className="h-3.5 w-3.5" /> {uploading ? 'Subiendo...' : server.photoAt ? 'Cambiar foto' : 'Subir foto real'}
                </button>
                {server.photoAt && (
                  <button
                    onClick={removePhoto}
                    className="flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium text-white ring-1 ring-white/20 backdrop-blur hover:bg-white/20"
                  >
                    <ImageOff className="h-3.5 w-3.5" /> Usar imagen automática
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="min-w-0 p-5 sm:p-6">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-bold uppercase tracking-[0.18em]" style={{ color: profile.accent }}>
                  {profile.brandLabel}
                </p>
                <h3 className="mt-0.5 truncate text-2xl font-semibold text-slate-900">{server.name}</h3>
                <p className="truncate text-sm text-slate-500">{profile.model || 'Modelo sin detectar'}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {isAdmin && !editing && (
                  <button onClick={() => setEditing(true)} className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700">
                    <Pencil className="h-3.5 w-3.5" /> Editar ficha
                  </button>
                )}
                <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100" aria-label="Cerrar">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
              {[
                ['IP', server.ipAddress ?? '—'],
                ['Equipo', server.hostname ?? '—'],
                ['Encendido hace', formatUptime(server.uptimeSeconds)],
                ['Último dato', timeAgo(server.lastSeenAt)],
                ['N° de serie', specs.serial.value ?? '—'],
                ['Agente', server.agentVersion ? `v${server.agentVersion}` : '—'],
                ['Dominio', hw?.domain ?? '—'],
                ['En el NOC desde', new Date(server.createdAt).toLocaleDateString('es-AR')],
              ].map(([k, v]) => (
                <div key={k} className="min-w-0">
                  <dt className="text-[10px] uppercase tracking-wide text-slate-400">{k}</dt>
                  <dd className="truncate font-medium text-slate-700" title={v}>
                    {v}
                  </dd>
                </div>
              ))}
            </dl>

            {!hw && (
              <p className="mt-4 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                El agente todavía no envió la ficha de hardware (necesita la versión 1.18.0 o superior y se actualiza solo). Mientras tanto podés cargar los datos a mano.
              </p>
            )}

            {!editing && (
              <div className="mt-4 grid grid-cols-3 gap-3">
                <UsageBar label="CPU" value={server.cpuUsage} />
                <UsageBar label="Memoria" value={server.memoryUsage} />
                <UsageBar label="Disco" value={server.diskUsage} />
              </div>
            )}
          </div>
        </div>

        <div className="space-y-4 p-5 sm:p-6">
          {editing ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-50 px-4 py-3 text-xs text-slate-600">
                <span>
                  Lo que dejes vacío se completa con lo que detecta el agente (en gris). La imagen cambia sola según marca, modelo y formato.
                </span>
                <button onClick={fillDetected} className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-100">
                  <Wand2 className="h-3.5 w-3.5" /> Completar con lo detectado
                </button>
              </div>
              <datalist id="asset-brands">
                {Object.values(BRANDS)
                  .filter((b) => b.label !== 'Genérico')
                  .map((b) => (
                    <option key={b.label} value={b.label} />
                  ))}
              </datalist>

              <Section icon={ShieldCheck} title="Identificación">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Field label="Marca" value={draft.brand} onChange={set('brand')} placeholder={specs.brand.value} list="asset-brands" />
                  <Field label="Modelo" value={draft.model} onChange={set('model')} placeholder={specs.profile.model || 'Ej: PowerEdge R740'} />
                  <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
                    Formato
                    <select
                      value={draft.formFactor}
                      onChange={(e) => set('formFactor')(e.target.value)}
                      className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal text-slate-800 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                    >
                      <option value="">Automático ({FORM_FACTOR_LABEL[detectProfile(hw, { ...fromDraft(draft), formFactor: undefined }).formFactor]})</option>
                      {(Object.keys(FORM_FACTOR_LABEL) as FormFactor[]).map((f) => (
                        <option key={f} value={f}>
                          {FORM_FACTOR_LABEL[f]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Field label="N° de serie / Service Tag" value={draft.serial} onChange={set('serial')} placeholder={hw?.serial} />
                  <Field label="Etiqueta de inventario" value={draft.assetTag} onChange={set('assetTag')} placeholder={hw?.assetTag ?? 'Ej: BIS-SRV-012'} />
                  <Field label="Función / rol" value={draft.role} onChange={set('role')} placeholder="Ej: Controlador de dominio + archivos" wide />
                </div>
              </Section>

              <Section icon={Cpu} title="Hardware">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <Field label="Procesador" value={draft.cpu} onChange={set('cpu')} placeholder={specs.cpu.source === 'agente' ? specs.cpu.value : 'Ej: 2× Xeon Silver 4214R'} />
                  <Field label="Memoria RAM (GB)" value={draft.ramGb} onChange={set('ramGb')} type="number" placeholder={specs.ramGbDetected ? String(specs.ramGbDetected) : '64'} />
                  <Field label="Almacenamiento" value={draft.storage} onChange={set('storage')} placeholder={specs.storage.source === 'agente' ? specs.storage.value : 'Ej: 4× 1,2 TB SAS 10k'} />
                  <Field label="Controladora / RAID" value={draft.raid} onChange={set('raid')} placeholder="Ej: PERC H730P · RAID 5" />
                  <Field label="Fuentes de alimentación" value={draft.psu} onChange={set('psu')} placeholder="Ej: 2× 750 W redundantes" />
                  <Field label="Sistema operativo" value={draft.os} onChange={set('os')} placeholder={hw?.os?.replace(/^Microsoft /, '')} />
                </div>
              </Section>

              <Section icon={NetworkIcon} title="Ubicación, compra y soporte">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Field label="Ubicación" value={draft.location} onChange={set('location')} placeholder="Ej: Sucursal Centro · sala de racks" wide />
                  <Field label="Rack / posición" value={draft.rack} onChange={set('rack')} placeholder="Ej: R1 · U12-U13" />
                  <Field label="Proveedor" value={draft.supplier} onChange={set('supplier')} placeholder="Ej: Dell Argentina" />
                  <Field label="Fecha de compra" value={draft.purchaseDate} onChange={set('purchaseDate')} type="date" />
                  <Field label="Garantía hasta" value={draft.warrantyUntil} onChange={set('warrantyUntil')} type="date" />
                  <Field label="Contacto de soporte" value={draft.supportContact} onChange={set('supportContact')} placeholder="Ej: ProSupport 0800-... / contrato N°" wide />
                </div>
                <label className="mt-3 flex flex-col gap-1 text-xs font-medium text-slate-600">
                  Notas
                  <textarea
                    value={draft.notes}
                    onChange={(e) => set('notes')(e.target.value)}
                    rows={3}
                    placeholder="Cambios de hardware, licencias, observaciones..."
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal text-slate-800 placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
                  />
                </label>
              </Section>

              <div className="flex justify-end gap-2">
                <button
                  onClick={() => {
                    setDraft(toDraft(server.asset ?? {}));
                    setEditing(false);
                  }}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Cancelar
                </button>
                <button
                  onClick={save}
                  disabled={saving}
                  className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
                >
                  <Save className="h-4 w-4" /> {saving ? 'Guardando...' : 'Guardar ficha'}
                </button>
              </div>
            </div>
          ) : (
            <>
              <Section icon={Cpu} title="Especificaciones">
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  <SpecRow label="Marca" spec={specs.brand} />
                  <SpecRow label="Modelo" spec={specs.model} />
                  <SpecRow label="Formato" spec={specs.formFactor} />
                  <SpecRow label="N° de serie" spec={specs.serial} mono />
                  <SpecRow label="Procesador" spec={specs.cpu} wide />
                  <SpecRow label="Memoria RAM" spec={specs.ram} />
                  <SpecRow label="Almacenamiento" spec={specs.storage} />
                  <SpecRow label="Sistema operativo" spec={specs.os} wide />
                  <SpecRow label="BIOS" spec={specs.bios} />
                  <SpecRow label="Controladora / RAID" spec={specs.raid} />
                  <SpecRow label="Fuentes" spec={specs.psu} />
                  <SpecRow label="Etiqueta de inventario" spec={specs.assetTag} mono />
                </div>
              </Section>

              <div className="grid gap-4 lg:grid-cols-2">
                <Section icon={ShieldCheck} title="Ciclo de vida y soporte">
                  <div className="mb-3">
                    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${WARRANTY_BADGE[specs.warranty.tone]}`}>{specs.warranty.label}</span>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <SpecRow label="Función / rol" spec={specs.role} />
                    <SpecRow label="Ubicación" spec={specs.location} />
                    <SpecRow label="Fecha de compra" spec={specs.purchaseDate} />
                    <SpecRow label="Proveedor" spec={specs.supplier} />
                    <div className="sm:col-span-2">
                      <SpecRow label="Contacto de soporte" spec={specs.supportContact} />
                    </div>
                  </div>
                  {server.asset.notes && <p className="mt-3 whitespace-pre-wrap rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">{server.asset.notes}</p>}
                </Section>

                <Section icon={HardDrive} title="Discos y volúmenes">
                  <ul className="space-y-1.5">
                    {(server.physicalDisks.length ? server.physicalDisks : (hw?.disks ?? []).map((d) => ({ name: d.model ?? 'Disco', mediaType: d.interface ?? '', health: '', sizeBytes: d.sizeBytes, predictFailure: false }))).map((d, i) => (
                      <li key={`${d.name}-${i}`} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-1.5 text-xs">
                        <span className="min-w-0 truncate text-slate-700" title={d.name}>
                          {d.name} {d.mediaType && <span className="text-slate-400">· {d.mediaType}</span>}
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          <span className="font-medium text-slate-700">{fmtBytes(d.sizeBytes)}</span>
                          {d.health && (
                            <span
                              className={`rounded px-1.5 py-px text-[10px] font-semibold ${
                                d.predictFailure || d.health === 'Unhealthy' ? 'bg-red-50 text-red-700' : d.health === 'Warning' ? 'bg-amber-50 text-amber-700' : d.health === 'Healthy' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'
                              }`}
                            >
                              {d.predictFailure ? 'Falla prevista' : d.health === 'Healthy' ? 'Sano' : d.health === 'Warning' ? 'Advertencia' : d.health === 'Unhealthy' ? 'Dañado' : 'Desconocido'}
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {server.volumes.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {server.volumes.map((v) => (
                        <div key={v.mount}>
                          <div className="mb-0.5 flex justify-between text-[11px] text-slate-500">
                            <span className="font-medium text-slate-700">{v.mount}</span>
                            <span>
                              {fmtBytes(v.totalBytes - v.freeBytes)} de {fmtBytes(v.totalBytes)} · libres {fmtBytes(v.freeBytes)}
                            </span>
                          </div>
                          <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                            <div className={`h-full rounded-full ${v.percent >= 90 ? 'bg-red-500' : v.percent >= 80 ? 'bg-amber-500' : 'bg-brand-500'}`} style={{ width: `${v.percent}%` }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {!server.physicalDisks.length && !hw?.disks?.length && !server.volumes.length && <p className="text-xs text-slate-400">Sin datos de discos todavía.</p>}
                </Section>

                <Section icon={MemoryStick} title="Memoria" right={hw?.memoryModules?.length ? <span className="text-xs text-slate-400">{memModules.length} módulos</span> : undefined}>
                  {memGroups.length ? (
                    <ul className="space-y-1.5">
                      {memGroups.map(([k, n]) => (
                        <li key={k} className="flex justify-between rounded-lg bg-slate-50 px-3 py-1.5 text-xs text-slate-700">
                          <span>{k}</span>
                          <span className="font-semibold">× {n}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-slate-400">{specs.ram.value ? `Total: ${specs.ram.value}` : 'Sin datos de memoria todavía.'}</p>
                  )}
                </Section>

                <Section icon={NetworkIcon} title="Placas de red">
                  {hw?.nics?.length ? (
                    <ul className="space-y-1.5">
                      {hw.nics.map((n, i) => (
                        <li key={`${n.mac}-${i}`} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-1.5 text-xs">
                          <span className="min-w-0 truncate text-slate-700" title={n.name}>
                            {n.name}
                          </span>
                          <span className="flex shrink-0 items-center gap-2 text-slate-500">
                            <span className="font-mono">{n.mac ?? ''}</span>
                            {n.speedMbps ? <span className="font-medium text-slate-700">{n.speedMbps >= 1000 ? `${n.speedMbps / 1000} Gbps` : `${n.speedMbps} Mbps`}</span> : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-slate-400">Sin datos de placas de red todavía.</p>
                  )}
                </Section>
              </div>
              {server.hardwareAt && <p className="text-right text-[11px] text-slate-400">Hardware leído por el agente {timeAgo(server.hardwareAt)}</p>}
            </>
          )}
        </div>
      </motion.div>
    </div>
  );
}
