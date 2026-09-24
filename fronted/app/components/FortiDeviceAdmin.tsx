import { useCallback, useEffect, useState } from 'react';
import type { FortiDevice } from '../types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

type Revealed = { name: string; apiKey: string };

export default function FortiDeviceAdmin() {
  const [devices, setDevices] = useState<FortiDevice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newDevice, setNewDevice] = useState({ name: '', host: '', method: 'API' as 'API' | 'SYSLOG' });
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<Revealed | null>(null);

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

  return (
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
  );
}
