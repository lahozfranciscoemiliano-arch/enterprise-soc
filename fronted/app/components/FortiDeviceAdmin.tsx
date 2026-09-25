import { useCallback, useEffect, useRef, useState } from 'react';
import type { FortiDevice, FortiScreenshotEvent } from '../types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

type Revealed = { name: string; apiKey: string };

function fileToBase64(file: File): Promise<{ data: string; mediaType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const [prefix, data] = result.split(',');
      const mediaType = prefix.match(/data:(.*);base64/)?.[1] ?? 'image/png';
      resolve({ data, mediaType });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function FortiDeviceAdmin() {
  const [devices, setDevices] = useState<FortiDevice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newDevice, setNewDevice] = useState({ name: '', host: '', method: 'API' as 'API' | 'SYSLOG' });
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<Revealed | null>(null);

  const [screenshotDeviceId, setScreenshotDeviceId] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [proposedEvents, setProposedEvents] = useState<FortiScreenshotEvent[]>([]);
  const [selectedEvents, setSelectedEvents] = useState<Set<number>>(new Set());
  const [ingesting, setIngesting] = useState(false);
  const [ingestOk, setIngestOk] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchDevices = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/admin/forti-devices`, { credentials: 'include' });
      if (!res.ok) throw new Error((await res.json()).error || 'No se pudo cargar');
      setDevices(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    }
  }, []);

  useEffect(() => {
    fetchDevices();
  }, [fetchDevices]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/api/admin/forti-devices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(newDevice),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'No se pudo crear el dispositivo');
      setRevealed({ name: body.name, apiKey: body.apiKey });
      setNewDevice({ name: '', host: '', method: 'API' });
      fetchDevices();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setCreating(false);
    }
  };

  const handleRotate = async (device: FortiDevice) => {
    if (!window.confirm(`¿Rotar la API key de ${device.name}?`)) return;
    const res = await fetch(`${API_URL}/api/admin/forti-devices/${device.id}/rotate-key`, {
      method: 'POST',
      credentials: 'include',
    });
    const body = await res.json();
    if (res.ok) setRevealed({ name: body.name, apiKey: body.apiKey });
  };

  const handleDelete = async (device: FortiDevice) => {
    if (!window.confirm(`¿Eliminar el dispositivo ${device.name}? Se borra también su historial de eventos.`)) return;
    await fetch(`${API_URL}/api/admin/forti-devices/${device.id}`, { method: 'DELETE', credentials: 'include' });
    fetchDevices();
  };

  const handleFileSelected = async (file: File) => {
    setAnalyzing(true);
    setAnalyzeError(null);
    setProposedEvents([]);
    setSelectedEvents(new Set());
    setIngestOk(null);
    try {
      const { data, mediaType } = await fileToBase64(file);
      const res = await fetch(`${API_URL}/api/admin/forti-devices/analyze-screenshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ imageBase64: data, mediaType }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'No se pudo analizar la imagen');
      const events: FortiScreenshotEvent[] = body.events ?? [];
      setProposedEvents(events);
      setSelectedEvents(new Set(events.map((_, i) => i)));
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setAnalyzing(false);
    }
  };

  const toggleEventSelection = (index: number) => {
    setSelectedEvents((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const handleIngestSelected = async () => {
    if (!screenshotDeviceId || selectedEvents.size === 0) return;
    setIngesting(true);
    setAnalyzeError(null);
    try {
      const events = proposedEvents.filter((_, i) => selectedEvents.has(i));
      const res = await fetch(`${API_URL}/api/admin/forti-devices/${screenshotDeviceId}/ingest-reviewed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ events }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'No se pudo ingerir los eventos');
      setIngestOk(body.createdEventIds.length);
      setProposedEvents([]);
      setSelectedEvents(new Set());
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setIngesting(false);
    }
  };

  return (
    <div className="space-y-4">
    <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">
      <h2 className="mb-4 text-sm font-semibold text-gray-200">🧱 Dispositivos Fortinet</h2>

      {error && <p className="mb-3 text-xs text-red-400">{error}</p>}

      {revealed && (
        <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
          <p className="mb-1 text-xs font-semibold text-amber-400">
            API key de &quot;{revealed.name}&quot; — copiála ahora, no se vuelve a mostrar
          </p>
          <p className="break-all font-mono text-[11px] text-gray-200">{revealed.apiKey}</p>
          <p className="mt-1 text-[10px] text-gray-500">
            Usala como header X-Api-Key (junto con X-Device-Id: {'<id del dispositivo>'}) desde el script que haga
            POST a {API_URL}/api/forti/events, o configurá el FortiGate para mandar syslog a este servidor si
            elegiste el método SYSLOG (ver Admin → Configuración → Fortinet).
          </p>
          <button
            onClick={() => setRevealed(null)}
            className="mt-2 rounded-lg border border-amber-500/40 px-2 py-1 text-[11px] text-amber-300 hover:bg-amber-500/10"
          >
            Cerrar
          </button>
        </div>
      )}

      <div className="mb-4 space-y-2">
        {devices.length === 0 && <p className="text-sm text-gray-500">Sin dispositivos registrados aún</p>}
        {devices.map((d) => (
          <div
            key={d.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-800 bg-gray-950/50 px-4 py-2 text-xs"
          >
            <span className="font-medium text-gray-200">{d.name}</span>
            <span className="text-gray-500">{d.host}</span>
            <span className="rounded-full border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-blue-400">
              {d.method}
            </span>
            <span className="text-gray-600">
              {d.lastSeenAt ? `Último evento: ${new Date(d.lastSeenAt).toLocaleString('es-ES')}` : 'Sin eventos aún'}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => handleRotate(d)}
                className="rounded-lg border border-amber-500/30 px-2 py-1 text-amber-400 transition-colors hover:bg-amber-500/10"
              >
                Rotar API key
              </button>
              <button
                onClick={() => handleDelete(d)}
                className="rounded-lg border border-red-500/30 px-2 py-1 text-red-400 transition-colors hover:bg-red-500/10"
              >
                Eliminar
              </button>
            </div>
          </div>
        ))}
      </div>

      <form onSubmit={handleCreate} className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <input
          type="text"
          required
          placeholder="Nombre (único, ej: FGT-Sucursal-Centro)"
          value={newDevice.name}
          onChange={(e) => setNewDevice((p) => ({ ...p, name: e.target.value }))}
          className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-gray-200 outline-none focus:border-blue-500"
        />
        <input
          type="text"
          required
          placeholder="IP de management"
          value={newDevice.host}
          onChange={(e) => setNewDevice((p) => ({ ...p, host: e.target.value }))}
          className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-gray-200 outline-none focus:border-blue-500"
        />
        <select
          value={newDevice.method}
          onChange={(e) => setNewDevice((p) => ({ ...p, method: e.target.value as 'API' | 'SYSLOG' }))}
          className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-gray-200"
        >
          <option value="API">Ingesta por API</option>
          <option value="SYSLOG">Syslog UDP</option>
        </select>
        <button
          type="submit"
          disabled={creating}
          className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
        >
          {creating ? 'Creando...' : '+ Nuevo dispositivo'}
        </button>
      </form>
      <p className="mt-3 text-xs text-gray-600">
        Si elegís SYSLOG, el campo IP se usa para matchear el origen de los paquetes UDP entrantes — necesitás activar
        el receptor en Admin → Configuración → Fortinet.
      </p>
    </div>

    <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">
      <h2 className="mb-1 text-sm font-semibold text-gray-200">🤖 Analizar captura de pantalla (vision)</h2>
      <p className="mb-4 text-[11px] text-gray-500">
        Para los sitios sin API key ni syslog configurado todavía: subí una captura del panel del FortiGate y Claude
        extrae los eventos visibles. Nunca se ingesta nada automático — revisás y confirmás cuáles cargar.
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          value={screenshotDeviceId}
          onChange={(e) => setScreenshotDeviceId(e.target.value)}
          className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-gray-200"
        >
          <option value="">Elegí el dispositivo destino...</option>
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          disabled={!screenshotDeviceId || analyzing}
          onChange={(e) => e.target.files?.[0] && handleFileSelected(e.target.files[0])}
          className="text-xs text-gray-300 file:mr-2 file:rounded-lg file:border-0 file:bg-blue-600 file:px-3 file:py-1.5 file:text-xs file:text-white hover:file:bg-blue-500"
        />
      </div>

      {!screenshotDeviceId && <p className="text-xs text-gray-600">Elegí primero a qué dispositivo pertenece la captura.</p>}
      {analyzing && <p className="text-xs text-gray-500">Analizando imagen...</p>}
      {analyzeError && <p className="text-xs text-red-400">{analyzeError}</p>}
      {ingestOk !== null && <p className="text-xs text-emerald-400">✓ {ingestOk} evento(s) ingresado(s) correctamente</p>}

      {proposedEvents.length > 0 && (
        <div className="mt-3 space-y-2">
          <p className="text-[11px] text-gray-500">
            {proposedEvents.length} evento(s) detectado(s) — desmarcá los que no quieras cargar:
          </p>
          {proposedEvents.map((ev, i) => (
            <label
              key={i}
              className="flex items-start gap-2 rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-2 text-xs"
            >
              <input
                type="checkbox"
                checked={selectedEvents.has(i)}
                onChange={() => toggleEventSelection(i)}
                className="mt-0.5 h-3.5 w-3.5"
              />
              <span>
                <span className="rounded-full border border-gray-700 px-1.5 py-0.5 text-[10px] text-gray-400">{ev.type}</span>{' '}
                <span className="rounded-full border border-gray-700 px-1.5 py-0.5 text-[10px] text-gray-400">{ev.severity}</span>{' '}
                {ev.description}
                {ev.sourceIp && <span className="text-gray-500"> · origen: {ev.sourceIp}</span>}
              </span>
            </label>
          ))}
          <button
            onClick={handleIngestSelected}
            disabled={ingesting || selectedEvents.size === 0}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
          >
            {ingesting ? 'Cargando...' : `Cargar ${selectedEvents.size} evento(s) seleccionado(s)`}
          </button>
        </div>
      )}
    </div>
    </div>
  );
}
