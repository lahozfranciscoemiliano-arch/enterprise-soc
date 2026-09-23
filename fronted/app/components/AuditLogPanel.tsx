import { useCallback, useEffect, useState } from 'react';
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
    <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-200">📋 Auditoría</h2>
        <button
          onClick={fetchLog}
          className="rounded-lg border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-800"
        >
          Actualizar
        </button>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {loading && !error && <p className="text-sm text-gray-500">Cargando...</p>}

      {!loading && !error && (
        <div className="max-h-96 overflow-y-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-gray-900">
              <tr className="border-b border-gray-800 text-gray-500">
                <th className="py-2 pr-4 font-medium">Fecha</th>
                <th className="py-2 pr-4 font-medium">Usuario</th>
                <th className="py-2 pr-4 font-medium">Acción</th>
                <th className="py-2 pr-4 font-medium">Objetivo</th>
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-6 text-center text-gray-500">
                    Sin actividad registrada
                  </td>
                </tr>
              )}
              {entries.map((e) => (
                <tr key={e.id} className="border-b border-gray-800/60">
                  <td className="py-2 pr-4 text-gray-400">{new Date(e.createdAt).toLocaleString('es-ES')}</td>
                  <td className="py-2 pr-4 text-gray-300">{e.userName}</td>
                  <td className="py-2 pr-4 text-gray-200">{ACTION_LABELS[e.action] ?? e.action}</td>
                  <td className="py-2 pr-4 text-gray-500">{e.targetType}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
