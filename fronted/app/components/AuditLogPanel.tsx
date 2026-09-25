import { useCallback, useEffect, useState } from 'react';
import { ClipboardList } from 'lucide-react';
import type { AuditLogEntry } from '../types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

const ACTION_LABELS: Record<string, string> = {
  LOGIN: 'Inicio de sesión',
  LOGOUT_ALL_DEVICES: 'Cierre de sesión en todos los dispositivos',
  USER_CREATE: 'Usuario creado',
  USER_DELETE: 'Usuario eliminado',
  USER_REVOKE_SESSIONS: 'Sesiones revocadas',
  SERVER_CREATE: 'Servidor creado',
  SERVER_DELETE: 'Servidor eliminado',
  SERVER_ROTATE_KEY: 'API key rotada',
  SERVER_AUTO_ENROLL: 'Servidor auto-enrolado',
  SERVER_UPDATE_THRESHOLDS: 'Umbrales actualizados',
  SERVER_MAINTENANCE_START: 'Mantenimiento iniciado',
  SERVER_MAINTENANCE_END: 'Mantenimiento finalizado',
  EVENT_ACKNOWLEDGED: 'Alerta reconocida',
  EVENT_RESOLVED: 'Alerta resuelta',
  '2FA_ENABLED': '2FA activado',
  '2FA_DISABLED': '2FA desactivado',
  '2FA_LOGIN_FAILED': 'Intento de login con 2FA fallido',
  '2FA_BACKUP_CODE_USED': 'Código de respaldo de 2FA usado',
  ADMIN_RESET_2FA: '2FA restablecido por un admin',
};

export default function AuditLogPanel() {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchLog = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/admin/audit-log?limit=100`, { credentials: 'include' });
      if (!res.ok) throw new Error((await res.json()).error || 'No se pudo cargar la auditoría');
      setEntries(await res.json());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLog();
  }, [fetchLog]);

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-800"><ClipboardList className="inline h-4 w-4 -mt-0.5 mr-1.5 text-slate-400" />Auditoría</h2>
        <button
          onClick={fetchLog}
          className="rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
        >
          Actualizar
        </button>
      </div>

      {error && <p className="text-sm text-red-700">{error}</p>}
      {loading && !error && <p className="text-sm text-slate-400">Cargando...</p>}

      {!loading && !error && (
        <div className="max-h-96 overflow-y-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-white">
              <tr className="border-b border-slate-200 text-slate-400">
                <th className="py-2 pr-4 font-medium">Fecha</th>
                <th className="py-2 pr-4 font-medium">Usuario</th>
                <th className="py-2 pr-4 font-medium">Acción</th>
                <th className="py-2 pr-4 font-medium">Objetivo</th>
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-6 text-center text-slate-400">
                    Sin actividad registrada
                  </td>
                </tr>
              )}
              {entries.map((e) => (
                <tr key={e.id} className="border-b border-slate-200">
                  <td className="py-2 pr-4 text-slate-500">{new Date(e.createdAt).toLocaleString('es-ES')}</td>
                  <td className="py-2 pr-4 text-slate-600">{e.userName}</td>
                  <td className="py-2 pr-4 text-slate-800">{ACTION_LABELS[e.action] ?? e.action}</td>
                  <td className="py-2 pr-4 text-slate-400">{e.targetType}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
