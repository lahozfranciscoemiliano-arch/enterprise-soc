import { useCallback, useEffect, useState } from 'react';
import ServerConfigPanel from '../ServerConfigPanel';
import AuditLogPanel from '../AuditLogPanel';
import SettingsPanel from '../SettingsPanel';
import FortiDeviceAdmin from '../FortiDeviceAdmin';
import RemoteAccessModal from '../RemoteAccessModal';
import type { AdminUser, Role, ServerSummary } from '../../types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

type RevealedCredential = { label: string; serverId: string; apiKey: string };
type AdminSection = 'usuarios' | 'servidores' | 'fortinet' | 'configuracion' | 'auditoria';

const SECTIONS: { id: AdminSection; label: string }[] = [
  { id: 'usuarios', label: '👤 Usuarios' },
  { id: 'servidores', label: '🖧 Servidores' },
  { id: 'fortinet', label: '🧱 Fortinet' },
  { id: 'configuracion', label: '⚙️ Configuración' },
  { id: 'auditoria', label: '📋 Auditoría' },
];

export default function AdminTab({
  currentUserEmail,
  servers,
  onServersChanged,
}: {
  currentUserEmail: string;
  servers: ServerSummary[];
  onServersChanged: () => void;
}) {
  const jsonHeaders = { 'Content-Type': 'application/json' };

  const [section, setSection] = useState<AdminSection>('usuarios');

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [usersError, setUsersError] = useState<string | null>(null);

  const [newUser, setNewUser] = useState({ email: '', password: '', name: '', role: 'VIEWER' as Role });
  const [creatingUser, setCreatingUser] = useState(false);
  const [userFormError, setUserFormError] = useState<string | null>(null);

  const [newServer, setNewServer] = useState({ name: '', hostname: '', ipAddress: '' });
  const [creatingServer, setCreatingServer] = useState(false);
  const [serverFormError, setServerFormError] = useState<string | null>(null);

  const [revealed, setRevealed] = useState<RevealedCredential | null>(null);
  const [expandedServerId, setExpandedServerId] = useState<string | null>(null);
  const [remoteAccessServer, setRemoteAccessServer] = useState<ServerSummary | null>(null);
  const [remoteAccessEnabled, setRemoteAccessEnabled] = useState(false);

  useEffect(() => {
    fetch(`${API_URL}/api/admin/settings`, { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setRemoteAccessEnabled(Boolean(data?.REMOTE_ACCESS_ENABLED?.value)))
      .catch(() => {});
  }, []);

  const fetchUsers = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/admin/users`, { credentials: 'include' });
      if (!res.ok) throw new Error((await res.json()).error || 'No se pudo cargar usuarios');
      setUsers(await res.json());
      setUsersError(null);
    } catch (err) {
      setUsersError(err instanceof Error ? err.message : 'Error desconocido');
    }
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const handleCreateUser = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setCreatingUser(true);
      setUserFormError(null);

      try {
        const res = await fetch(`${API_URL}/api/admin/users`, {
          method: 'POST',
          headers: jsonHeaders,
          credentials: 'include',
          body: JSON.stringify(newUser),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || 'No se pudo crear el usuario');

        setUsers((prev) => [...prev, body]);
        setNewUser({ email: '', password: '', name: '', role: 'VIEWER' });
      } catch (err) {
        setUserFormError(err instanceof Error ? err.message : 'Error desconocido');
      } finally {
        setCreatingUser(false);
      }
    },
    [newUser]
  );

  const handleDeleteUser = useCallback(async (user: AdminUser) => {
    if (!window.confirm(`¿Eliminar el usuario ${user.email}? Esta acción no se puede deshacer.`)) return;

    try {
      const res = await fetch(`${API_URL}/api/admin/users/${user.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok && res.status !== 204) {
        const body = await res.json();
        throw new Error(body.error || 'No se pudo eliminar el usuario');
      }
      setUsers((prev) => prev.filter((u) => u.id !== user.id));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error desconocido');
    }
  }, []);

  const handleRevokeSessions = useCallback(async (user: AdminUser) => {
    if (!window.confirm(`¿Cerrar todas las sesiones activas de ${user.email}?`)) return;

    try {
      const res = await fetch(`${API_URL}/api/admin/users/${user.id}/revoke-sessions`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok && res.status !== 204) {
        throw new Error((await res.json()).error || 'No se pudieron revocar las sesiones');
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error desconocido');
    }
  }, []);

  const handleReset2fa = useCallback(
    async (user: AdminUser) => {
      if (
        !window.confirm(
          `¿Restablecer el 2FA de ${user.email}? Se desactiva y se cierran sus sesiones activas (para cuando perdió el dispositivo).`
        )
      )
        return;

      try {
        const res = await fetch(`${API_URL}/api/admin/users/${user.id}/reset-2fa`, {
          method: 'POST',
          credentials: 'include',
        });
        if (!res.ok && res.status !== 204) {
          throw new Error((await res.json()).error || 'No se pudo restablecer el 2FA');
        }
        setUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, twoFactorEnabled: false } : u)));
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Error desconocido');
      }
    },
    []
  );

  const handleCreateServer = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setCreatingServer(true);
      setServerFormError(null);

      try {
        const res = await fetch(`${API_URL}/api/admin/servers`, {
          method: 'POST',
          headers: jsonHeaders,
          credentials: 'include',
          body: JSON.stringify(newServer),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || 'No se pudo crear el servidor');

        setRevealed({ label: body.name, serverId: body.id, apiKey: body.apiKey });
        setNewServer({ name: '', hostname: '', ipAddress: '' });
        onServersChanged();
      } catch (err) {
        setServerFormError(err instanceof Error ? err.message : 'Error desconocido');
      } finally {
        setCreatingServer(false);
      }
    },
    [newServer, onServersChanged]
  );

  const handleRotateKey = useCallback(async (server: ServerSummary) => {
    if (!window.confirm(`¿Rotar la API key de ${server.name}? La clave actual dejará de funcionar de inmediato.`))
      return;

    try {
      const res = await fetch(`${API_URL}/api/admin/servers/${server.id}/rotate-key`, {
        method: 'POST',
        credentials: 'include',
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'No se pudo rotar la API key');
      setRevealed({ label: body.name, serverId: body.id, apiKey: body.apiKey });
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Error desconocido');
    }
  }, []);

  const handleDeleteServer = useCallback(
    async (server: ServerSummary) => {
      if (
        !window.confirm(
          `¿Eliminar el servidor ${server.name}? Se borra también todo su historial de telemetría, alertas y backups.`
        )
      )
        return;

      try {
        const res = await fetch(`${API_URL}/api/admin/servers/${server.id}`, {
          method: 'DELETE',
          credentials: 'include',
        });
        if (!res.ok && res.status !== 204) {
          const body = await res.json();
          throw new Error(body.error || 'No se pudo eliminar el servidor');
        }
        onServersChanged();
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Error desconocido');
      }
    },
    [onServersChanged]
  );

  return (
    <div className="animate-fade-in space-y-6 px-6 py-6">
      <div className="flex flex-wrap gap-1 rounded-xl border border-gray-800 bg-gray-900/40 p-1.5">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => setSection(s.id)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              section === s.id ? 'bg-blue-600 text-white' : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {revealed && (
        <div className="animate-fade-in-scale rounded-xl border border-amber-500/40 bg-amber-500/5 p-4">
          <p className="mb-2 text-sm font-semibold text-amber-400">
            🔑 Credenciales de &quot;{revealed.label}&quot; — copiálas ahora, no se van a volver a mostrar
          </p>
          <div className="space-y-1 font-mono text-xs text-gray-200">
            <p>SERVER_ID={revealed.serverId}</p>
            <p className="break-all">API_KEY={revealed.apiKey}</p>
          </div>
          <button
            onClick={() => setRevealed(null)}
            className="mt-3 rounded-lg border border-amber-500/40 px-3 py-1 text-xs text-amber-300 hover:bg-amber-500/10"
          >
            Ya las copié, cerrar
          </button>
        </div>
      )}

      {section === 'usuarios' && (
      <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">
        <h2 className="mb-4 text-sm font-semibold text-gray-200">👤 Usuarios del dashboard</h2>

        <div className="mb-4 space-y-2">
          {usersError && <p className="text-sm text-red-400">{usersError}</p>}
          {users.map((u) => (
            <div
              key={u.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-800 bg-gray-950/50 px-4 py-2 text-xs"
            >
              <span className="font-medium text-gray-200">
                {u.name} <span className="text-gray-500">({u.email})</span>
              </span>
              <span className="rounded-full border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-blue-400">
                {u.role}
              </span>
              <span
                className={`rounded-full px-2 py-0.5 ${
                  u.twoFactorEnabled
                    ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                    : 'border border-gray-700 bg-gray-800 text-gray-500'
                }`}
              >
                {u.twoFactorEnabled ? '2FA activo' : '2FA off'}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => handleRevokeSessions(u)}
                  className="rounded-lg border border-amber-500/30 px-2 py-1 text-amber-400 transition-colors hover:bg-amber-500/10"
                >
                  Cerrar sesiones
                </button>
                {u.twoFactorEnabled && (
                  <button
                    onClick={() => handleReset2fa(u)}
                    className="rounded-lg border border-amber-500/30 px-2 py-1 text-amber-400 transition-colors hover:bg-amber-500/10"
                  >
                    Restablecer 2FA
                  </button>
                )}
                <button
                  onClick={() => handleDeleteUser(u)}
                  disabled={u.email === currentUserEmail}
                  className="rounded-lg border border-red-500/30 px-2 py-1 text-red-400 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  Eliminar
                </button>
              </div>
            </div>
          ))}
        </div>

        <form onSubmit={handleCreateUser} className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <input
            type="text"
            required
            placeholder="Nombre"
            value={newUser.name}
            onChange={(e) => setNewUser((p) => ({ ...p, name: e.target.value }))}
            className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-gray-200 outline-none focus:border-blue-500"
          />
          <input
            type="email"
            required
            placeholder="Email"
            value={newUser.email}
            onChange={(e) => setNewUser((p) => ({ ...p, email: e.target.value }))}
            className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-gray-200 outline-none focus:border-blue-500"
          />
          <input
            type="password"
            required
            minLength={8}
            placeholder="Contraseña (mín. 8)"
            value={newUser.password}
            onChange={(e) => setNewUser((p) => ({ ...p, password: e.target.value }))}
            className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-gray-200 outline-none focus:border-blue-500"
          />
          <select
            value={newUser.role}
            onChange={(e) => setNewUser((p) => ({ ...p, role: e.target.value as Role }))}
            className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-gray-200"
          >
            <option value="VIEWER">VIEWER</option>
            <option value="ANALYST">ANALYST</option>
            <option value="ADMIN">ADMIN</option>
          </select>
          <button
            type="submit"
            disabled={creatingUser}
            className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
          >
            {creatingUser ? 'Creando...' : '+ Nuevo usuario'}
          </button>
        </form>
        {userFormError && <p className="mt-2 text-xs text-red-400">{userFormError}</p>}
      </div>
      )}

      {section === 'servidores' && (
      <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">
        <h2 className="mb-4 text-sm font-semibold text-gray-200">🖧 Servidores registrados</h2>

        <div className="mb-4 space-y-2">
          {servers.length === 0 && <p className="text-sm text-gray-500">Sin servidores registrados aún</p>}
          {servers.map((s) => (
            <div key={s.id}>
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-800 bg-gray-950/50 px-4 py-2 text-xs">
                <span className="font-medium text-gray-200">{s.name}</span>
                <span className="text-gray-500">{s.status}</span>
                {s.tags.map((tag) => (
                  <span key={tag} className="rounded-full border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-violet-300">
                    {tag}
                  </span>
                ))}
                {s.agentVersion && <span className="font-mono text-gray-600">agente v{s.agentVersion}</span>}
                {s.inMaintenance && (
                  <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-sky-300">
                    🔧 Mantenimiento
                  </span>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={() => setExpandedServerId((prev) => (prev === s.id ? null : s.id))}
                    className="rounded-lg border border-gray-700 px-2 py-1 text-gray-300 transition-colors hover:bg-gray-800"
                  >
                    {expandedServerId === s.id ? 'Cerrar' : 'Configurar'}
                  </button>
                  <button
                    onClick={() => handleRotateKey(s)}
                    className="rounded-lg border border-amber-500/30 px-2 py-1 text-amber-400 transition-colors hover:bg-amber-500/10"
                  >
                    Rotar API key
                  </button>
                  {remoteAccessEnabled && (
                    <button
                      onClick={() => setRemoteAccessServer(s)}
                      className="rounded-lg border border-sky-500/30 px-2 py-1 text-sky-300 transition-colors hover:bg-sky-500/10"
                    >
                      🖥️ Conectar
                    </button>
                  )}
                  <button
                    onClick={() => handleDeleteServer(s)}
                    className="rounded-lg border border-red-500/30 px-2 py-1 text-red-400 transition-colors hover:bg-red-500/10"
                  >
                    Eliminar
                  </button>
                </div>
              </div>
              {expandedServerId === s.id && <ServerConfigPanel server={s} onUpdated={onServersChanged} />}
            </div>
          ))}
        </div>

        <form onSubmit={handleCreateServer} className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <input
            type="text"
            required
            placeholder="Nombre (único)"
            value={newServer.name}
            onChange={(e) => setNewServer((p) => ({ ...p, name: e.target.value }))}
            className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-gray-200 outline-none focus:border-blue-500"
          />
          <input
            type="text"
            required
            placeholder="Hostname"
            value={newServer.hostname}
            onChange={(e) => setNewServer((p) => ({ ...p, hostname: e.target.value }))}
            className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-gray-200 outline-none focus:border-blue-500"
          />
          <input
            type="text"
            required
            placeholder="IP"
            value={newServer.ipAddress}
            onChange={(e) => setNewServer((p) => ({ ...p, ipAddress: e.target.value }))}
            className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-gray-200 outline-none focus:border-blue-500"
          />
          <button
            type="submit"
            disabled={creatingServer}
            className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
          >
            {creatingServer ? 'Creando...' : '+ Nuevo servidor'}
          </button>
        </form>
        {serverFormError && <p className="mt-2 text-xs text-red-400">{serverFormError}</p>}
        <p className="mt-3 text-xs text-gray-600">
          Alternativa: si configuraste AGENT_ENROLLMENT_SECRET en el backend, podés usar el instalador del agente
          para que un servidor nuevo se registre solo, sin pasar por este formulario.
        </p>
      </div>
      )}

      {section === 'fortinet' && <FortiDeviceAdmin />}

      {section === 'configuracion' && <SettingsPanel />}

      {section === 'auditoria' && <AuditLogPanel />}

      {remoteAccessServer && (
        <RemoteAccessModal server={remoteAccessServer} onClose={() => setRemoteAccessServer(null)} />
      )}
    </div>
  );
}
