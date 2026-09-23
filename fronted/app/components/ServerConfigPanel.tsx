import { useState } from 'react';
import type { ServerSummary } from '../types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

export default function ServerConfigPanel({
  server,
  token,
  onUpdated,
}: {
  server: ServerSummary;
  token: string;
  onUpdated: () => void;
}) {
  const authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

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
  const [error, setError] = useState<string | null>(null);

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
        headers: authHeaders,
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

  const setMaintenanceFor = async (hours: number | null) => {
    setSavingMaintenance(true);
    setError(null);

    const maintenanceUntil = hours ? new Date(Date.now() + hours * 60 * 60 * 1000).toISOString() : null;

    try {
      const res = await fetch(`${API_URL}/api/admin/servers/${server.id}/maintenance`, {
        method: 'PATCH',
        headers: authHeaders,
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
      <span className="text-[10px] uppercase tracking-wide text-gray-500">{label}</span>
      <input
        type="number"
        min={0}
        max={100}
        placeholder={String(defaultValue)}
        value={thresholds[key]}
        onChange={(e) => setThresholds((p) => ({ ...p, [key]: e.target.value }))}
        className="w-20 rounded-lg border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-200 outline-none focus:border-blue-500"
      />
    </label>
  );

  return (
    <div className="mt-2 rounded-lg border border-gray-800 bg-gray-950/60 p-4">
      <div className="mb-3">
        <p className="mb-2 text-[11px] uppercase tracking-wide text-gray-500">
          Umbrales personalizados (vacío = usar el default global)
        </p>
        <div className="flex flex-wrap gap-4">
          <div className="flex gap-2">
            <span className="self-end pb-1 text-xs text-gray-400">CPU</span>
            {field('cpuThresholdMedium', 'Advertencia %', 75)}
            {field('cpuThresholdHigh', 'Crítico %', 90)}
          </div>
          <div className="flex gap-2">
            <span className="self-end pb-1 text-xs text-gray-400">RAM</span>
            {field('memThresholdMedium', 'Advertencia %', 80)}
            {field('memThresholdHigh', 'Crítico %', 90)}
          </div>
          <div className="flex gap-2">
            <span className="self-end pb-1 text-xs text-gray-400">Disco</span>
            {field('diskThresholdMedium', 'Advertencia %', 85)}
            {field('diskThresholdHigh', 'Crítico %', 95)}
          </div>
          <button
            onClick={handleSaveThresholds}
            disabled={savingThresholds}
            className="self-end rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
          >
            {savingThresholds ? 'Guardando...' : 'Guardar umbrales'}
          </button>
        </div>
      </div>

      <div className="border-t border-gray-800 pt-3">
        <p className="mb-2 text-[11px] uppercase tracking-wide text-gray-500">Ventana de mantenimiento</p>
        {server.inMaintenance ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-xs text-sky-300">
              🔧 Activo hasta {server.maintenanceUntil ? new Date(server.maintenanceUntil).toLocaleString('es-ES') : '—'}
            </span>
            <button
              onClick={() => setMaintenanceFor(null)}
              disabled={savingMaintenance}
              className="rounded-lg border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-800"
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
                className="rounded-lg border border-sky-500/30 px-2 py-1 text-xs text-sky-300 transition-colors hover:bg-sky-500/10"
              >
                {h}h
              </button>
            ))}
          </div>
        )}
      </div>

      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  );
}
