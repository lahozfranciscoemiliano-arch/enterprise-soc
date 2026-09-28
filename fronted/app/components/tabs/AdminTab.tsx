import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ClipboardList,
  KeyRound,
 
  Settings,
  ShieldHalf,
  BookOpen,
  FileText,
  UserRound,
  Server,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import ServerConfigPanel from '../ServerConfigPanel';
import AuditLogPanel from '../AuditLogPanel';
import SettingsPanel from '../SettingsPanel';
import FortiDeviceAdmin from '../FortiDeviceAdmin';
import RdpConnectButton from '../RdpConnectButton';
import PlaybooksAdmin from '../PlaybooksAdmin';
import ReportsPanel from '../ReportsPanel';
import { useToast } from '../Toast';
import type { AdminUser, Role, ServerSummary } from '../../types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

type RevealedCredential = { label: string; serverId: string; apiKey: string };
type AdminSection = 'usuarios' | 'servidores' | 'fortinet' | 'configuracion' | 'playbooks' | 'reportes' | 'auditoria';

const SECTIONS: { id: AdminSection; label: string; icon: LucideIcon }[] = [
  { id: 'usuarios', label: 'Usuarios', icon: UserRound },
  { id: 'servidores', label: 'Servidores', icon: Server },
  { id: 'fortinet', label: 'Fortinet', icon: ShieldHalf },
  { id: 'configuracion', label: 'Configuración', icon: Settings },
  { id: 'playbooks', label: 'Playbooks', icon: BookOpen },
  { id: 'reportes', label: 'Reportes', icon: FileText },
  { id: 'auditoria', label: 'Auditoría', icon: ClipboardList },
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
  const toast = useToast();

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
      toast.error(err instanceof Error ? err.message : 'Error desconocido');
    }
  }, [toast]);

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
      toast.error(err instanceof Error ? err.message : 'Error desconocido');
    }
  }, [toast]);

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
        toast.error(err instanceof Error ? err.message : 'Error desconocido');
      }
    },
    [toast]
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
      toast.error(err instanceof Error ? err.message : 'Error desconocido');
    }
  }, [toast]);

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
        toast.error(err instanceof Error ? err.message : 'Error desconocido');
      }
    },
    [onServersChanged, toast]
  );

  return (
    <div className="space-y-6 px-3 py-4 sm:px-6 sm:py-6">
      <div className="flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1.5">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => setSection(s.id)}
            className={`relative flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              section === s.id ? 'text-white' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'
            }`}
          >
            {section === s.id && (
              <motion.span
                layoutId="admin-section-active"
                className="absolute inset-0 rounded-lg bg-brand-600"
                transition={{ type: 'spring', bounce: 0.2, duration: 0.5 }}
              />
            )}
            <s.icon className="relative z-10 h-3.5 w-3.5" />
            <span className="relative z-10">{s.label}</span>
          </button>
        ))}
      </div>

      {revealed && (
        <div className="animate-fade-in-scale rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-amber-700">
            <KeyRound className="h-4 w-4" />
            Credenciales de &quot;{revealed.label}&quot; — copiálas ahora, no se van a volver a mostrar
          </p>
          <div className="space-y-1 font-mono text-xs text-slate-800">
            <p>SERVER_ID={revealed.serverId}</p>
            <p className="break-all">API_KEY={revealed.apiKey}</p>
          </div>
          <button
            onClick={() => setRevealed(null)}
            className="mt-3 rounded-lg border border-amber-200 px-3 py-1 text-xs text-amber-700 hover:bg-amber-50"
          >
            Ya las copié, cerrar
          </button>
        </div>
      )}

      <AnimatePresence mode="wait">
      <motion.div key={section} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
      {section === 'usuarios' && (
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
        <h2 className="mb-4 flex items-center gap-1.5 text-sm font-semibold text-slate-800">
          <UserRound className="h-4 w-4 text-slate-400" />
          Usuarios del dashboard
        </h2>

        <div className="mb-4 space-y-2">
          {usersError && <p className="text-sm text-red-700">{usersError}</p>}
          {users.map((u) => (
            <div
              key={u.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-xs"
            >
              <span className="font-medium text-slate-800">
                {u.name} <span className="text-slate-400">({u.email})</span>
              </span>
              <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-blue-700">
                {u.role}
              </span>
              <span
                className={`rounded-full px-2 py-0.5 ${
                  u.twoFactorEnabled
                    ? 'border border-emerald-200 bg-emerald-50 text-emerald-700'
                    : 'border border-slate-300 bg-slate-50 text-slate-400'
                }`}
              >
                {u.twoFactorEnabled ? '2FA activo' : '2FA off'}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => handleRevokeSessions(u)}
                  className="rounded-lg border border-amber-200 px-2 py-1 text-amber-700 transition-colors hover:bg-amber-50"
                >
                  Cerrar sesiones
                </button>
                {u.twoFactorEnabled && (
                  <button
                    onClick={() => handleReset2fa(u)}
                    className="rounded-lg border border-amber-200 px-2 py-1 text-amber-700 transition-colors hover:bg-amber-50"
                  >
                    Restablecer 2FA
                  </button>
                )}
                <button
                  onClick={() => handleDeleteUser(u)}
                  disabled={u.email === currentUserEmail}
                  className="rounded-lg border border-red-200 px-2 py-1 text-red-700 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-30"
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
            className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-800 outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10 transition-colors"
          />
          <input
            type="email"
            required
            placeholder="Email"
            value={newUser.email}
            onChange={(e) => setNewUser((p) => ({ ...p, email: e.target.value }))}
            className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-800 outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10 transition-colors"
          />
          <input
            type="password"
            required
            minLength={8}
            placeholder="Contraseña (mín. 8)"
            value={newUser.password}
            onChange={(e) => setNewUser((p) => ({ ...p, password: e.target.value }))}
            className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-800 outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10 transition-colors"
          />
          <select
            value={newUser.role}
            onChange={(e) => setNewUser((p) => ({ ...p, role: e.target.value as Role }))}
            className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-800"
          >
            <option value="VIEWER">VIEWER</option>
            <option value="ANALYST">ANALYST</option>
            <option value="ADMIN">ADMIN</option>
          </select>
          <button
            type="submit"
            disabled={creatingUser}
            className="rounded-lg bg-brand-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-brand-700 disabled:opacity-50"
          >
            {creatingUser ? 'Creando...' : '+ Nuevo usuario'}
          </button>
        </form>
        {userFormError && <p className="mt-2 text-xs text-red-700">{userFormError}</p>}
      </div>
      )}

      {section === 'servidores' && (
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
        <h2 className="mb-4 flex items-center gap-1.5 text-sm font-semibold text-slate-800">
          <Server className="h-4 w-4 text-slate-400" />
          Servidores registrados
        </h2>

        <div className="mb-4 space-y-2">
          {servers.length === 0 && <p className="text-sm text-slate-400">Sin servidores registrados aún</p>}
          {servers.map((s) => (
            <div key={s.id}>
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2 text-xs">
                <span className="font-medium text-slate-800">{s.name}</span>
                <span className="text-slate-400">{s.status}</span>
                {s.tags.map((tag) => (
                  <span key={tag} className="rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-violet-700">
                    {tag}
                  </span>
                ))}
                {s.agentVersion && <span className="font-mono text-slate-500">agente v{s.agentVersion}</span>}
                {s.inMaintenance && (
                  <span className="flex items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-sky-700">
                    <Wrench className="h-3 w-3" />
                    Mantenimiento
                  </span>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={() => setExpandedServerId((prev) => (prev === s.id ? null : s.id))}
                    className="rounded-lg border border-slate-300 px-2 py-1 text-slate-600 transition-colors hover:bg-slate-100"
                  >
                    {expandedServerId === s.id ? 'Cerrar' : 'Configurar'}
                  </button>
                  <button
                    onClick={() => handleRotateKey(s)}
                    className="rounded-lg border border-amber-200 px-2 py-1 text-amber-700 transition-colors hover:bg-amber-50"
                  >
                    Rotar API key
                  </button>
                  <RdpConnectButton name={s.name} host={s.ipAddress} compact />
                  <button
                    onClick={() => handleDeleteServer(s)}
                    className="rounded-lg border border-red-200 px-2 py-1 text-red-700 transition-colors hover:bg-red-50"
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
            className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-800 outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10 transition-colors"
          />
          <input
            type="text"
            required
            placeholder="Hostname"
            value={newServer.hostname}
            onChange={(e) => setNewServer((p) => ({ ...p, hostname: e.target.value }))}
            className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-800 outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10 transition-colors"
          />
          <input
            type="text"
            required
            placeholder="IP"
            value={newServer.ipAddress}
            onChange={(e) => setNewServer((p) => ({ ...p, ipAddress: e.target.value }))}
            className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-800 outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10 transition-colors"
          />
          <button
            type="submit"
            disabled={creatingServer}
            className="rounded-lg bg-brand-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-brand-700 disabled:opacity-50"
          >
            {creatingServer ? 'Creando...' : '+ Nuevo servidor'}
          </button>
        </form>
        {serverFormError && <p className="mt-2 text-xs text-red-700">{serverFormError}</p>}
        <p className="mt-3 text-xs text-slate-500">
          Alternativa: si configuraste AGENT_ENROLLMENT_SECRET en el backend, podés usar el instalador del agente
          para que un servidor nuevo se registre solo, sin pasar por este formulario.
        </p>
      </div>
      )}

      {section === 'fortinet' && <FortiDeviceAdmin />}

      {section === 'configuracion' && <SettingsPanel />}

      {section === 'playbooks' && <PlaybooksAdmin />}

      {section === 'reportes' && <ReportsPanel />}

      {section === 'auditoria' && <AuditLogPanel />}
      </motion.div>
      </AnimatePresence>

    </div>
  );
}
