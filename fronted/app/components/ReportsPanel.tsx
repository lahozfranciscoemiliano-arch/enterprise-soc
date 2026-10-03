'use client';

import { useCallback, useEffect, useState } from 'react';
import { FileText, HeartPulse, Mail, Radio, Trash2, TrendingUp } from 'lucide-react';
import type { AnomalyBaselineStatus, HeartbeatRun, HousekeepingRun, ReportMeta, SyntheticMonitorRun } from '../types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

export default function ReportsPanel() {
  const [reports, setReports] = useState<ReportMeta[]>([]);
  const [housekeeping, setHousekeeping] = useState<HousekeepingRun | null>(null);
  const [heartbeat, setHeartbeat] = useState<HeartbeatRun | null>(null);
  const [synthetic, setSynthetic] = useState<SyntheticMonitorRun | null>(null);
  const [anomaly, setAnomaly] = useState<AnomalyBaselineStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [runningHousekeeping, setRunningHousekeeping] = useState(false);
  const [runningHeartbeat, setRunningHeartbeat] = useState(false);
  const [runningSynthetic, setRunningSynthetic] = useState(false);
  const [periodDays, setPeriodDays] = useState('7');
  const [emailTo, setEmailTo] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [mailRow, setMailRow] = useState<string | null>(null);
  const [rowTo, setRowTo] = useState('');
  const [sendingRow, setSendingRow] = useState(false);

  const sendExisting = useCallback(async (filename: string) => {
    setSendingRow(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`${API_URL}/api/admin/reports/${encodeURIComponent(filename)}/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(rowTo.trim() ? { to: rowTo.trim() } : {}),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'No se pudo enviar el reporte');
      setNotice(`${filename} enviado a ${body.to.join(', ')}`);
      setMailRow(null);
      setRowTo('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setSendingRow(false);
    }
  }, [rowTo]);

  const fetchAll = useCallback(async () => {
    try {
      const [reportsRes, hkRes, hbRes, synRes, anomalyRes] = await Promise.all([
        fetch(`${API_URL}/api/admin/reports`, { credentials: 'include' }),
        fetch(`${API_URL}/api/admin/housekeeping`, { credentials: 'include' }),
        fetch(`${API_URL}/api/admin/heartbeat`, { credentials: 'include' }),
        fetch(`${API_URL}/api/admin/synthetic-monitor`, { credentials: 'include' }),
        fetch(`${API_URL}/api/admin/anomaly-detection`, { credentials: 'include' }),
      ]);
      if (!reportsRes.ok) throw new Error((await reportsRes.json()).error || 'No se pudieron cargar los reportes');
      setReports(await reportsRes.json());
      if (hkRes.ok) setHousekeeping((await hkRes.json()).lastRun);
      if (hbRes.ok) setHeartbeat((await hbRes.json()).lastRun);
      if (synRes.ok) setSynthetic((await synRes.json()).lastRun);
      if (anomalyRes.ok) setAnomaly(await anomalyRes.json());
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

  const handleGenerate = useCallback(async (send = false) => {
    setGenerating(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`${API_URL}/api/admin/reports/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ periodDays: Number(periodDays) || 7, ...(send ? (emailTo.trim() ? { emailTo: emailTo.trim() } : { email: true }) : {}) }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'No se pudo generar el reporte');
      if (body.emailError) setError(`El PDF se generó, pero no se pudo enviar: ${body.emailError}`);
      else if (body.emailedTo) setNotice(`Reporte generado y enviado a ${body.emailedTo.join(', ')}`);
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setGenerating(false);
    }
  }, [periodDays, emailTo, fetchAll]);

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

  const handleRunHeartbeat = useCallback(async () => {
    setRunningHeartbeat(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/admin/heartbeat/run`, { method: 'POST', credentials: 'include' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'No se pudo correr el heartbeat');
      setHeartbeat(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setRunningHeartbeat(false);
    }
  }, []);

  const handleRunSynthetic = useCallback(async () => {
    setRunningSynthetic(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/admin/synthetic-monitor/run`, { method: 'POST', credentials: 'include' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'No se pudo correr el chequeo de red');
      setSynthetic(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setRunningSynthetic(false);
    }
  }, []);

  const totalDeleted = housekeeping ? Object.values(housekeeping.deleted).reduce((a, b) => a + b, 0) : null;

  if (loading) return <p className="text-sm text-slate-400">Cargando...</p>;

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">{error}</p>}
      {notice && <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-700">{notice}</p>}

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
        <h2 className="mb-1 text-sm font-semibold text-slate-800"><FileText className="inline h-4 w-4 -mt-0.5 mr-1.5 text-slate-400" />Reportes ejecutivos</h2>
        <p className="mb-4 text-[11px] text-slate-400">
          PDF con SLA, incidentes y estado de backups del período (incluye un resumen redactado por IA si el
          asistente está configurado). Se pueden generar a demanda acá, o programar el envío automático por email en
          Admin → Configuración → Reportes ejecutivos.
        </p>

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <label className="text-xs text-slate-500">Período (días)</label>
          <input
            type="number"
            min={1}
            max={90}
            value={periodDays}
            onChange={(e) => setPeriodDays(e.target.value)}
            className="w-20 rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs text-slate-800 outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10 transition-colors"
          />
          <button
            onClick={() => handleGenerate(false)}
            disabled={generating}
            className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-700 disabled:opacity-50"
          >
            {generating ? 'Generando...' : '+ Generar PDF'}
          </button>
          <input
            value={emailTo}
            onChange={(e) => setEmailTo(e.target.value)}
            placeholder="Enviar a (vacío = los de Configuración)"
            className="w-80 rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs text-slate-800 outline-none focus:border-brand-500"
          />
          <button
            onClick={() => handleGenerate(true)}
            disabled={generating}
            className="flex items-center gap-1 rounded-lg border border-brand-300 px-3 py-1.5 text-xs font-medium text-brand-700 transition-colors hover:bg-brand-50 disabled:opacity-50"
          >
            <Mail className="h-3.5 w-3.5" /> Generar y enviar por mail
          </button>
          <a
            href={`${API_URL}/api/admin/reports/export.csv?periodDays=${Number(periodDays) || 7}`}
            target="_blank"
            rel="noreferrer"
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 transition-colors hover:bg-slate-100"
          >
            ⬇ Exportar CSV
          </a>
        </div>

        <div className="space-y-1">
          {reports.length === 0 && <p className="text-xs text-slate-400">Todavía no se generó ningún reporte</p>}
          {reports.map((r) => (
            <div
              key={r.filename}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-xs"
            >
              <span className="font-mono text-slate-600">{r.filename}</span>
              <span className="text-slate-400">{new Date(r.createdAt).toLocaleString('es-ES')}</span>
              <span className="text-slate-500">{r.sizeLabel}</span>
              <a
                href={`${API_URL}/api/admin/reports/${encodeURIComponent(r.filename)}`}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg border border-slate-300 px-2 py-1 text-slate-600 transition-colors hover:bg-slate-100"
              >
                Descargar
              </a>
              <button
                onClick={() => {
                  setMailRow(mailRow === r.filename ? null : r.filename);
                  setRowTo('');
                }}
                className="flex items-center gap-1 rounded-lg border border-slate-300 px-2 py-1 text-slate-600 transition-colors hover:bg-slate-100"
              >
                <Mail className="h-3 w-3" /> Enviar por mail
              </button>
              {mailRow === r.filename && (
                <div className="flex w-full flex-wrap items-center gap-2 pt-1">
                  <input
                    autoFocus
                    value={rowTo}
                    onChange={(e) => setRowTo(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && sendExisting(r.filename)}
                    placeholder="a@empresa.com, b@empresa.com (vacío = destinatarios de Configuración)"
                    className="min-w-[280px] flex-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-800 outline-none focus:border-brand-500"
                  />
                  <button
                    onClick={() => sendExisting(r.filename)}
                    disabled={sendingRow}
                    className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
                  >
                    {sendingRow ? 'Enviando…' : 'Enviar'}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
          <h2 className="mb-1 text-sm font-semibold text-slate-800"><HeartPulse className="inline h-4 w-4 -mt-0.5 mr-1.5 text-slate-400" />Heartbeat (agentes caídos)</h2>
          <p className="mb-3 text-[11px] text-slate-400">
            Corre cada minuto. Marca OFFLINE y alerta CRITICAL a cualquier servidor sin telemetría por más del umbral
            configurado (Admin → Configuración → Sesión y agentes).
          </p>
          <button
            onClick={handleRunHeartbeat}
            disabled={runningHeartbeat}
            className="mb-3 rounded-lg border border-amber-200 px-3 py-1.5 text-xs text-amber-700 transition-colors hover:bg-amber-50 disabled:opacity-50"
          >
            {runningHeartbeat ? 'Corriendo...' : '▶ Correr ahora'}
          </button>
          {heartbeat ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
              <p className="mb-1 text-slate-400">Última corrida: {new Date(heartbeat.checkedAt).toLocaleString('es-ES')}</p>
              {heartbeat.markedOffline.length === 0 ? (
                <p className="text-emerald-700">Todos los servidores reportando con normalidad</p>
              ) : (
                <p className="text-red-700">
                  Marcados OFFLINE: {heartbeat.markedOffline.map((s) => s.name).join(', ')}
                </p>
              )}
            </div>
          ) : (
            <p className="text-xs text-slate-400">Todavía no corrió (corre solo a los 30s de arrancar el backend)</p>
          )}
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
          <h2 className="mb-1 text-sm font-semibold text-slate-800"><Radio className="inline h-4 w-4 -mt-0.5 mr-1.5 text-slate-400" />Synthetic monitoring (red)</h2>
          <p className="mb-3 text-[11px] text-slate-400">
            Chequeo TCP activo cada 2 minutos a los servidores con puerto configurado (Admin → Servidores →
            Configurar). Distingue un sitio caído de red de un agente que dejó de responder.
          </p>
          <button
            onClick={handleRunSynthetic}
            disabled={runningSynthetic}
            className="mb-3 rounded-lg border border-amber-200 px-3 py-1.5 text-xs text-amber-700 transition-colors hover:bg-amber-50 disabled:opacity-50"
          >
            {runningSynthetic ? 'Corriendo...' : '▶ Correr ahora'}
          </button>
          {synthetic ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
              <p className="mb-1 text-slate-400">
                Última corrida: {new Date(synthetic.checkedAt).toLocaleString('es-ES')} ({synthetic.checked} servidor(es) con chequeo activo)
              </p>
              {synthetic.unreachable.length === 0 ? (
                <p className="text-emerald-700">Todos los puertos chequeados responden</p>
              ) : (
                <p className="text-red-700">Inalcanzables: {synthetic.unreachable.map((s) => s.name).join(', ')}</p>
              )}
            </div>
          ) : (
            <p className="text-xs text-slate-400">Todavía no corrió, o ningún servidor tiene puerto configurado</p>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
        <h2 className="mb-1 text-sm font-semibold text-slate-800"><TrendingUp className="inline h-4 w-4 -mt-0.5 mr-1.5 text-slate-400" />Detección de anomalías</h2>
        <p className="mb-3 text-[11px] text-slate-400">
          Baseline estadístico (media + desvío por servidor, métrica y hora del día) recalculado cada hora sobre los
          últimos 14 días. Detecta picos raros para ESE servidor aunque no crucen ningún umbral fijo.
        </p>
        {anomaly ? (
          <p className="text-xs text-slate-600">
            {anomaly.serversWithBaseline > 0
              ? `${anomaly.serversWithBaseline} servidor(es) con historial suficiente para tener baseline propio.`
              : 'Todavía no hay suficiente historial (se necesitan al menos ~20 muestras por hora en los últimos 14 días).'}
            {anomaly.lastRefreshAt && (
              <span className="text-slate-400"> Última actualización: {new Date(anomaly.lastRefreshAt).toLocaleString('es-ES')}</span>
            )}
          </p>
        ) : (
          <p className="text-xs text-slate-400">Sin datos todavía.</p>
        )}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
        <h2 className="mb-1 text-sm font-semibold text-slate-800"><Trash2 className="inline h-4 w-4 -mt-0.5 mr-1.5 text-slate-400" />Housekeeping (retención de datos)</h2>
        <p className="mb-4 text-[11px] text-slate-400">
          Corre solo una vez por día y purga telemetría/alertas resueltas/backups/auditoría viejos según los días
          configurados en Admin → Configuración → Retención de datos.
        </p>

        <button
          onClick={handleRunHousekeeping}
          disabled={runningHousekeeping}
          className="mb-3 rounded-lg border border-amber-200 px-3 py-1.5 text-xs text-amber-700 transition-colors hover:bg-amber-50 disabled:opacity-50"
        >
          {runningHousekeeping ? 'Corriendo...' : '▶ Correr ahora'}
        </button>

        {housekeeping ? (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
            <p className="mb-1 text-slate-400">
              Última corrida: {new Date(housekeeping.finishedAt).toLocaleString('es-ES')}
              {housekeeping.error && <span className="text-red-700"> — Error: {housekeeping.error}</span>}
            </p>
            {!housekeeping.error && (
              <>
                <p className="mb-2 font-medium text-slate-800">{totalDeleted} fila(s) borrada(s) en total</p>
                <div className="grid grid-cols-2 gap-1 sm:grid-cols-4">
                  {Object.entries(housekeeping.deleted).map(([key, count]) => (
                    <span key={key} className="text-[11px] text-slate-400">
                      {key}: <span className="text-slate-600">{count}</span>
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
        ) : (
          <p className="text-xs text-slate-400">Todavía no corrió (corre automáticamente a los 2 minutos de arrancar el backend)</p>
        )}
      </div>
    </div>
  );
}
