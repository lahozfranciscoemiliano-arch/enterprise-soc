'use client';

import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Activity,
  Ban,
  Bug,
  HelpCircle,
  LogIn,
  LogOut,
  RefreshCw,
  Settings,
  ShieldAlert,
  ShieldHalf,
  Unplug,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import { SEVERITY_STYLES } from '../../lib/health';
import type { FortiEvent, FortiEventType, Severity } from '../../types';

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

const TYPE_ICONS: Record<FortiEventType, LucideIcon> = {
  VPN_LOGIN: LogIn,
  VPN_LOGOUT: LogOut,
  ADMIN_LOGIN: UserRound,
  CONFIG_CHANGE: Settings,
  IPS_ATTACK: ShieldAlert,
  VIRUS_DETECTED: Bug,
  INTERFACE_DOWN: Unplug,
  HA_FAILOVER: RefreshCw,
  TRAFFIC_ANOMALY: Activity,
  FIREWALL_DENY: Ban,
  OTHER: HelpCircle,
};

const SEVERITY_ORDER: Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

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

  const severityCounts = useMemo(() => {
    const counts: Record<Severity, number> = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
    for (const e of events) counts[e.severity]++;
    return counts;
  }, [events]);

  return (
    <div className="px-3 py-4 sm:px-6 sm:py-6">
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
            <ShieldHalf className="h-4 w-4 text-slate-400" />
            Monitor Fortinet
          </h2>

          <div className="flex items-center gap-4">
            {events.length > 0 && (
              <div className="flex items-center gap-3 text-xs">
                {SEVERITY_ORDER.map((sev) => (
                  <span key={sev} className="flex items-center gap-1">
                    <span className={`rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${SEVERITY_STYLES[sev]}`}>
                      {severityCounts[sev]}
                    </span>
                    <span className="text-slate-400">{sev}</span>
                  </span>
                ))}
              </div>
            )}
            <motion.button
              whileTap={{ scale: 0.96 }}
              onClick={handleRefresh}
              disabled={loading}
              className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              {loading ? 'Actualizando...' : 'Actualizar'}
            </motion.button>
          </div>
        </div>

        {events.length === 0 && (
          <p className="py-6 text-center text-sm text-slate-400">
            Sin eventos registrados todavía. Configurá un dispositivo Fortinet en Admin → Configuración → Fortinet.
          </p>
        )}

        {events.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-left text-xs sm:min-w-0">
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
                <AnimatePresence initial={false}>
                  {events.map((e, i) => {
                    const Icon = TYPE_ICONS[e.type] ?? HelpCircle;
                    return (
                      <motion.tr
                        key={e.id}
                        initial={{ opacity: 0, backgroundColor: 'rgba(194,99,45,0.08)' }}
                        animate={{ opacity: 1, backgroundColor: 'rgba(194,99,45,0)' }}
                        transition={{ delay: Math.min(i * 0.01, 0.2), backgroundColor: { duration: 1.2 } }}
                        className="border-b border-slate-200 transition-colors hover:bg-slate-100/30"
                      >
                        <td className="py-2 pr-4 text-slate-500">{new Date(e.createdAt).toLocaleString('es-ES')}</td>
                        <td className="py-2 pr-4 text-slate-600">{e.deviceName}</td>
                        <td className="py-2 pr-4 text-slate-600">
                          <span className="flex items-center gap-1.5">
                            <Icon className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                            {TYPE_LABELS[e.type] ?? e.type}
                          </span>
                        </td>
                        <td className="py-2 pr-4">
                          <span className={`rounded-full border px-2 py-0.5 text-[11px] ${SEVERITY_STYLES[e.severity]}`}>
                            {e.severity}
                          </span>
                        </td>
                        <td className="py-2 pr-4 font-mono text-slate-400">{e.sourceIp ?? '—'}</td>
                        <td className="py-2 pr-4 font-mono text-slate-400">{e.destIp ?? '—'}</td>
                        <td className="py-2 pr-4 text-slate-500">{e.description}</td>
                      </motion.tr>
                    );
                  })}
                </AnimatePresence>
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
