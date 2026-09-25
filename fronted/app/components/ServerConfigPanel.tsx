import { useState } from 'react';
import { Wrench } from 'lucide-react';
import type { ServerSummary } from '../types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

export default function ServerConfigPanel({
  server,
  onUpdated,
}: {
  server: ServerSummary;
  onUpdated: () => void;
}) {
  const jsonHeaders = { 'Content-Type': 'application/json' };

  const [thresholds, setThresholds] = useState({
    cpuThresholdMedium: server.thresholds.cpuThresholdMedium ?? '',
    cpuThresholdHigh: server.thresholds.cpuThresholdHigh ?? '',
    memThresholdMedium: server.thresholds.memThresholdMedium ?? '',
    memThresholdHigh: server.thresholds.memThresholdHigh ?? '',
    diskThresholdMedium: server.thresholds.diskThresholdMedium ?? '',
    diskThresholdHigh: server.thresholds.diskThresholdHigh ?? '',
  });
  const [savingThresholds, setSavingThresholds] = useState(false);
  const [savingMaintenance, setSavingMaintenance] = useState(false);
  const [tagsInput, setTagsInput] = useState(server.tags.join(', '));
  const [savingTags, setSavingTags] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [siteInfo, setSiteInfo] = useState({
    latitude: server.latitude ?? '',
    longitude: server.longitude ?? '',
    ispPrimaryName: server.ispPrimaryName ?? '',
    ispPrimaryContact: server.ispPrimaryContact ?? '',
    ispSecondaryName: server.ispSecondaryName ?? '',
    ispSecondaryContact: server.ispSecondaryContact ?? '',
    siteContactName: server.siteContactName ?? '',
    siteContactPhone: server.siteContactPhone ?? '',
    hasFortinet: server.hasFortinet,
    siteNotes: server.siteNotes ?? '',
    syntheticCheckPort: server.syntheticCheckPort ?? '',
  });
  const [savingSiteInfo, setSavingSiteInfo] = useState(false);

  const handleSaveTags = async () => {
    setSavingTags(true);
    setError(null);

    const tags = tagsInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    try {
      const res = await fetch(`${API_URL}/api/admin/servers/${server.id}/tags`, {
        method: 'PATCH',
        headers: jsonHeaders,
        credentials: 'include',
        body: JSON.stringify({ tags }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'No se pudieron guardar las etiquetas');
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setSavingTags(false);
    }
  };

  const handleSaveThresholds = async () => {
    setSavingThresholds(true);
    setError(null);

    const body: Record<string, number | null> = {};
    for (const [key, value] of Object.entries(thresholds)) {
      body[key] = value === '' ? null : Number(value);
    }

    try {
      const res = await fetch(`${API_URL}/api/admin/servers/${server.id}/thresholds`, {
        method: 'PATCH',
        headers: jsonHeaders,
        credentials: 'include',
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'No se pudieron guardar los umbrales');
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setSavingThresholds(false);
    }
  };

  const handleSaveSiteInfo = async () => {
    setSavingSiteInfo(true);
    setError(null);

    const body = {
      latitude: siteInfo.latitude === '' ? null : Number(siteInfo.latitude),
      longitude: siteInfo.longitude === '' ? null : Number(siteInfo.longitude),
      ispPrimaryName: siteInfo.ispPrimaryName || null,
      ispPrimaryContact: siteInfo.ispPrimaryContact || null,
      ispSecondaryName: siteInfo.ispSecondaryName || null,
      ispSecondaryContact: siteInfo.ispSecondaryContact || null,
      siteContactName: siteInfo.siteContactName || null,
      siteContactPhone: siteInfo.siteContactPhone || null,
      hasFortinet: siteInfo.hasFortinet,
      siteNotes: siteInfo.siteNotes || null,
      syntheticCheckPort: siteInfo.syntheticCheckPort === '' ? null : Number(siteInfo.syntheticCheckPort),
    };

    try {
      const res = await fetch(`${API_URL}/api/admin/servers/${server.id}/site-info`, {
        method: 'PATCH',
        headers: jsonHeaders,
        credentials: 'include',
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'No se pudo guardar la información del sitio');
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setSavingSiteInfo(false);
    }
  };

  const setMaintenanceFor = async (hours: number | null) => {
    setSavingMaintenance(true);
    setError(null);

    const maintenanceUntil = hours ? new Date(Date.now() + hours * 60 * 60 * 1000).toISOString() : null;

    try {
      const res = await fetch(`${API_URL}/api/admin/servers/${server.id}/maintenance`, {
        method: 'PATCH',
        headers: jsonHeaders,
        credentials: 'include',
        body: JSON.stringify({ maintenanceUntil }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'No se pudo actualizar el mantenimiento');
      onUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setSavingMaintenance(false);
    }
  };

  const field = (key: keyof typeof thresholds, label: string, defaultValue: number) => (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-slate-400">{label}</span>
      <input
        type="number"
        min={0}
        max={100}
        placeholder={String(defaultValue)}
        value={thresholds[key]}
        onChange={(e) => setThresholds((p) => ({ ...p, [key]: e.target.value }))}
        className="w-20 rounded-lg border border-slate-300 bg-slate-50 px-2 py-1 text-xs text-slate-800 outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10 transition-colors"
      />
    </label>
  );

  return (
    <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-4">
      <div className="mb-3 border-b border-slate-200 pb-3">
        <p className="mb-2 text-[11px] uppercase tracking-wide text-slate-400">
          Etiquetas (separadas por coma — sucursal, ambiente, rol, etc.)
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            type="text"
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            placeholder="ej: sucursal-centro, produccion, sql"
            className="min-w-[240px] flex-1 rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs text-slate-800 outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10 transition-colors"
          />
          <button
            onClick={handleSaveTags}
            disabled={savingTags}
            className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-700 disabled:opacity-50"
          >
            {savingTags ? 'Guardando...' : 'Guardar etiquetas'}
          </button>
        </div>
      </div>

      <div className="mb-3">
        <p className="mb-2 text-[11px] uppercase tracking-wide text-slate-400">
          Umbrales personalizados (vacío = usar el default global)
        </p>
        <div className="flex flex-wrap gap-4">
          <div className="flex gap-2">
            <span className="self-end pb-1 text-xs text-slate-500">CPU</span>
            {field('cpuThresholdMedium', 'Advertencia %', 75)}
            {field('cpuThresholdHigh', 'Crítico %', 90)}
          </div>
          <div className="flex gap-2">
            <span className="self-end pb-1 text-xs text-slate-500">RAM</span>
            {field('memThresholdMedium', 'Advertencia %', 80)}
            {field('memThresholdHigh', 'Crítico %', 90)}
          </div>
          <div className="flex gap-2">
            <span className="self-end pb-1 text-xs text-slate-500">Disco</span>
            {field('diskThresholdMedium', 'Advertencia %', 85)}
            {field('diskThresholdHigh', 'Crítico %', 95)}
          </div>
          <button
            onClick={handleSaveThresholds}
            disabled={savingThresholds}
            className="self-end rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-700 disabled:opacity-50"
          >
            {savingThresholds ? 'Guardando...' : 'Guardar umbrales'}
          </button>
        </div>
      </div>

      <div className="mb-3 border-t border-slate-200 pt-3">
        <p className="mb-2 text-[11px] uppercase tracking-wide text-slate-400">
          Info del sitio (mapa + CMDB) — todo opcional
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <input
            type="number"
            step="any"
            placeholder="Latitud (ej: -34.5701)"
            value={siteInfo.latitude}
            onChange={(e) => setSiteInfo((p) => ({ ...p, latitude: e.target.value }))}
            className="rounded-lg border border-slate-300 bg-slate-50 px-2 py-1.5 text-xs text-slate-800 outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10 transition-colors"
          />
          <input
            type="number"
            step="any"
            placeholder="Longitud (ej: -58.5237)"
            value={siteInfo.longitude}
            onChange={(e) => setSiteInfo((p) => ({ ...p, longitude: e.target.value }))}
            className="rounded-lg border border-slate-300 bg-slate-50 px-2 py-1.5 text-xs text-slate-800 outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10 transition-colors"
          />
          <input
            type="text"
            placeholder="ISP primario"
            value={siteInfo.ispPrimaryName}
            onChange={(e) => setSiteInfo((p) => ({ ...p, ispPrimaryName: e.target.value }))}
            className="rounded-lg border border-slate-300 bg-slate-50 px-2 py-1.5 text-xs text-slate-800 outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10 transition-colors"
          />
          <input
            type="text"
            placeholder="Contacto ISP primario"
            value={siteInfo.ispPrimaryContact}
            onChange={(e) => setSiteInfo((p) => ({ ...p, ispPrimaryContact: e.target.value }))}
            className="rounded-lg border border-slate-300 bg-slate-50 px-2 py-1.5 text-xs text-slate-800 outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10 transition-colors"
          />
          <input
            type="text"
            placeholder="ISP secundario"
            value={siteInfo.ispSecondaryName}
            onChange={(e) => setSiteInfo((p) => ({ ...p, ispSecondaryName: e.target.value }))}
            className="rounded-lg border border-slate-300 bg-slate-50 px-2 py-1.5 text-xs text-slate-800 outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10 transition-colors"
          />
          <input
            type="text"
            placeholder="Contacto ISP secundario"
            value={siteInfo.ispSecondaryContact}
            onChange={(e) => setSiteInfo((p) => ({ ...p, ispSecondaryContact: e.target.value }))}
            className="rounded-lg border border-slate-300 bg-slate-50 px-2 py-1.5 text-xs text-slate-800 outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10 transition-colors"
          />
          <input
            type="text"
            placeholder="Contacto del sitio (nombre)"
            value={siteInfo.siteContactName}
            onChange={(e) => setSiteInfo((p) => ({ ...p, siteContactName: e.target.value }))}
            className="rounded-lg border border-slate-300 bg-slate-50 px-2 py-1.5 text-xs text-slate-800 outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10 transition-colors"
          />
          <input
            type="text"
            placeholder="Teléfono del contacto"
            value={siteInfo.siteContactPhone}
            onChange={(e) => setSiteInfo((p) => ({ ...p, siteContactPhone: e.target.value }))}
            className="rounded-lg border border-slate-300 bg-slate-50 px-2 py-1.5 text-xs text-slate-800 outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10 transition-colors"
          />
          <input
            type="number"
            min={1}
            max={65535}
            placeholder="Puerto synthetic monitoring (ej: 3389)"
            value={siteInfo.syntheticCheckPort}
            onChange={(e) => setSiteInfo((p) => ({ ...p, syntheticCheckPort: e.target.value }))}
            className="rounded-lg border border-slate-300 bg-slate-50 px-2 py-1.5 text-xs text-slate-800 outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10 transition-colors"
          />
          <select
            value={siteInfo.hasFortinet === null ? '' : String(siteInfo.hasFortinet)}
            onChange={(e) =>
              setSiteInfo((p) => ({ ...p, hasFortinet: e.target.value === '' ? null : e.target.value === 'true' }))
            }
            className="rounded-lg border border-slate-300 bg-slate-50 px-2 py-1.5 text-xs text-slate-800"
          >
            <option value="">¿Tiene Fortinet propio? (sin definir)</option>
            <option value="true">Sí, tiene Fortinet propio</option>
            <option value="false">No, sin Fortinet propio</option>
          </select>
          <textarea
            placeholder="Notas del sitio"
            value={siteInfo.siteNotes}
            onChange={(e) => setSiteInfo((p) => ({ ...p, siteNotes: e.target.value }))}
            rows={1}
            className="rounded-lg border border-slate-300 bg-slate-50 px-2 py-1.5 text-xs text-slate-800 outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10 transition-colors sm:col-span-2 lg:col-span-3"
          />
        </div>
        <p className="mt-2 text-[11px] text-slate-400">
          El puerto de synthetic monitoring es opcional: si se define, el backend intenta conectarse a ese puerto
          cada 2 minutos para distinguir un sitio caído de red de un agente que dejó de responder.
        </p>
        <button
          onClick={handleSaveSiteInfo}
          disabled={savingSiteInfo}
          className="mt-2 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-700 disabled:opacity-50"
        >
          {savingSiteInfo ? 'Guardando...' : 'Guardar info del sitio'}
        </button>
      </div>

      <div className="border-t border-slate-200 pt-3">
        <p className="mb-2 text-[11px] uppercase tracking-wide text-slate-400">Ventana de mantenimiento</p>
        {server.inMaintenance ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-xs text-sky-700">
              <Wrench className="h-3 w-3" />
              Activo hasta {server.maintenanceUntil ? new Date(server.maintenanceUntil).toLocaleString('es-ES') : '—'}
            </span>
            <button
              onClick={() => setMaintenanceFor(null)}
              disabled={savingMaintenance}
              className="rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
            >
              Terminar ahora
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {[1, 4, 24].map((h) => (
              <button
                key={h}
                onClick={() => setMaintenanceFor(h)}
                disabled={savingMaintenance}
                className="rounded-lg border border-sky-200 px-2 py-1 text-xs text-sky-700 transition-colors hover:bg-sky-50"
              >
                {h}h
              </button>
            ))}
          </div>
        )}
      </div>

      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
    </div>
  );
}
