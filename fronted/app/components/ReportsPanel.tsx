'use client';

import { useCallback, useEffect, useState } from 'react';
import type { HousekeepingRun, ReportMeta } from '../types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

export default function ReportsPanel() {
  const [reports, setReports] = useState<ReportMeta[]>([]);
  const [housekeeping, setHousekeeping] = useState<HousekeepingRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [runningHousekeeping, setRunningHousekeeping] = useState(false);
  const [periodDays, setPeriodDays] = useState('7');

  const fetchAll = useCallback(async () => {
    try {
      const [reportsRes, hkRes] = await Promise.all([
        fetch(`${API_URL}/api/admin/reports`, { credentials: 'include' }),
        fetch(`${API_URL}/api/admin/housekeeping`, { credentials: 'include' }),
      ]);
      if (!reportsRes.ok) throw new Error((await reportsRes.json()).error || 'No se pudieron cargar los reportes');
      setReports(await reportsRes.json());
      if (hkRes.ok) setHousekeeping((await hkRes.json()).lastRun);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/admin/reports/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ periodDays: Number(periodDays) || 7 }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'No se pudo generar el reporte');
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setGenerating(false);
    }
  }, [periodDays, fetchAll]);

  const handleRunHousekeeping = useCallback(async () => {
    setRunningHousekeeping(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/admin/housekeeping/run`, { method: 'POST', credentials: 'include' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'No se pudo correr el housekeeping');
      setHousekeeping(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setRunningHousekeeping(false);
    }
  }, []);

  const totalDeleted = housekeeping ? Object.values(housekeeping.deleted).reduce((a, b) => a + b, 0) : null;

  if (loading) return <p className="text-sm text-gray-500">Cargando...</p>;

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-400">{error}</p>}

      <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">
        <h2 className="mb-1 text-sm font-semibold text-gray-200">📄 Reportes ejecutivos</h2>
        <p className="mb-4 text-[11px] text-gray-500">
          PDF con SLA, incidentes y estado de backups del período. Se pueden generar a demanda acá, o programar el
          envío automático por email en Admin → Configuración → Reportes ejecutivos.
        </p>

        <div className="mb-4 flex items-center gap-2">
          <label className="text-xs text-gray-400">Período (días)</label>
          <input
            type="number"
            min={1}
            max={90}
            value={periodDays}
            onChange={(e) => setPeriodDays(e.target.value)}
            className="w-20 rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-xs text-gray-200 outline-none focus:border-blue-500"
          />
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
          >
            {generating ? 'Generando...' : '+ Generar ahora'}
          </button>
        </div>

        <div className="space-y-1">
          {reports.length === 0 && <p className="text-xs text-gray-500">Todavía no se generó ningún reporte</p>}
          {reports.map((r) => (
            <div
              key={r.filename}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-800 bg-gray-950/50 px-4 py-2 text-xs"
            >
              <span className="font-mono text-gray-300">{r.filename}</span>
              <span className="text-gray-500">{new Date(r.createdAt).toLocaleString('es-ES')}</span>
              <span className="text-gray-600">{r.sizeLabel}</span>
              <a
                href={`${API_URL}/api/admin/reports/${encodeURIComponent(r.filename)}`}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg border border-gray-700 px-2 py-1 text-gray-300 transition-colors hover:bg-gray-800"
              >
                Descargar
              </a>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">
        <h2 className="mb-1 text-sm font-semibold text-gray-200">🧹 Housekeeping (retención de datos)</h2>
        <p className="mb-4 text-[11px] text-gray-500">
          Corre solo una vez por día y purga telemetría/alertas resueltas/backups/auditoría viejos según los días
          configurados en Admin → Configuración → Retención de datos.
        </p>

        <button
          onClick={handleRunHousekeeping}
          disabled={runningHousekeeping}
          className="mb-3 rounded-lg border border-amber-500/30 px-3 py-1.5 text-xs text-amber-400 transition-colors hover:bg-amber-500/10 disabled:opacity-50"
        >
          {runningHousekeeping ? 'Corriendo...' : '▶ Correr ahora'}
        </button>

        {housekeeping ? (
          <div className="rounded-lg border border-gray-800 bg-gray-950/50 p-3 text-xs text-gray-300">
            <p className="mb-1 text-gray-500">
              Última corrida: {new Date(housekeeping.finishedAt).toLocaleString('es-ES')}
              {housekeeping.error && <span className="text-red-400"> — Error: {housekeeping.error}</span>}
            </p>
            {!housekeeping.error && (
              <>
                <p className="mb-2 font-medium text-gray-200">{totalDeleted} fila(s) borrada(s) en total</p>
                <div className="grid grid-cols-2 gap-1 sm:grid-cols-4">
                  {Object.entries(housekeeping.deleted).map(([key, count]) => (
                    <span key={key} className="text-[11px] text-gray-500">
                      {key}: <span className="text-gray-300">{count}</span>
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
        ) : (
          <p className="text-xs text-gray-500">Todavía no corrió (corre automáticamente a los 2 minutos de arrancar el backend)</p>
        )}
      </div>
    </div>
  );
}
