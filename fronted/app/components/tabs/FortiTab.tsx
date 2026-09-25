import { useEffect, useState } from 'react';
import { ShieldHalf } from 'lucide-react';
import { SEVERITY_STYLES } from '../../lib/health';
import type { FortiEvent } from '../../types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

const TYPE_LABELS: Record<string, string> = {
  VPN_LOGIN: 'Login VPN',
  VPN_LOGOUT: 'Logout VPN',
  ADMIN_LOGIN: 'Login de administrador',
  CONFIG_CHANGE: 'Cambio de configuración',
  IPS_ATTACK: 'Ataque bloqueado (IPS)',
  VIRUS_DETECTED: 'Virus/malware detectado',
  INTERFACE_DOWN: 'Interfaz caída',
  HA_FAILOVER: 'Failover de alta disponibilidad',
  TRAFFIC_ANOMALY: 'Anomalía de tráfico',
  FIREWALL_DENY: 'Tráfico denegado',
  OTHER: 'Otro',
};

export default function FortiTab({ events, onRefresh }: { events: FortiEvent[]; onRefresh: () => void }) {
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    onRefresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRefresh = async () => {
    setLoading(true);
    await onRefresh();
    setLoading(false);
  };

  return (
    <div className="px-6 py-6">
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
            <ShieldHalf className="h-4 w-4 text-slate-400" />
            Monitor Fortinet
          </h2>
          <button
            onClick={handleRefresh}
            disabled={loading}
            className="rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-50"
          >
            {loading ? 'Actualizando...' : 'Actualizar'}
          </button>
        </div>

        {events.length === 0 && (
          <p className="py-6 text-center text-sm text-slate-400">
            Sin eventos registrados todavía. Configurá un dispositivo Fortinet en Admin → Configuración → Fortinet.
          </p>
        )}

        {events.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-400">
                  <th className="py-2 pr-4 font-medium">Timestamp</th>
                  <th className="py-2 pr-4 font-medium">Dispositivo</th>
                  <th className="py-2 pr-4 font-medium">Tipo</th>
                  <th className="py-2 pr-4 font-medium">Severidad</th>
                  <th className="py-2 pr-4 font-medium">Origen</th>
                  <th className="py-2 pr-4 font-medium">Destino</th>
                  <th className="py-2 pr-4 font-medium">Detalle</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id} className="border-b border-slate-200 transition-colors hover:bg-slate-100/30">
                    <td className="py-2 pr-4 text-slate-500">{new Date(e.createdAt).toLocaleString('es-ES')}</td>
                    <td className="py-2 pr-4 text-slate-600">{e.deviceName}</td>
                    <td className="py-2 pr-4 text-slate-600">{TYPE_LABELS[e.type] ?? e.type}</td>
                    <td className="py-2 pr-4">
                      <span className={`rounded-full border px-2 py-0.5 text-[11px] ${SEVERITY_STYLES[e.severity]}`}>
                        {e.severity}
                      </span>
                    </td>
                    <td className="py-2 pr-4 font-mono text-slate-400">{e.sourceIp ?? '—'}</td>
                    <td className="py-2 pr-4 font-mono text-slate-400">{e.destIp ?? '—'}</td>
                    <td className="py-2 pr-4 text-slate-500">{e.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
