'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Bot } from 'lucide-react';
import { useToast } from './Toast';
import Header from './Header';
import TabNav from './TabNav';
import GeneralTab from './tabs/GeneralTab';
import MonitoreoTab from './tabs/MonitoreoTab';
import TopologiaTab from './tabs/TopologiaTab';
import MapaTab from './tabs/MapaTab';
import LogsRegexTab from './tabs/LogsRegexTab';
import GuardiaTab from './tabs/GuardiaTab';
import AdminTab from './tabs/AdminTab';
import AccountSettingsModal from './AccountSettingsModal';
import AssistantPanel from './AssistantPanel';
import FortiTab from './tabs/FortiTab';
import { getHealthStatus } from '../lib/health';
import type {
  ConnectionStatus,
  CurrentUser,
  DashboardSummary,
  FortiEvent,
  SecurityAlert,
  ServerSummary,
  TabId,
  TelemetryPoint,
} from '../types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:3000/ws';
const MAX_POINTS = 30;
const MAX_ALERTS = 100;
const RECONNECT_DELAY_MS = 3000;
const SUMMARY_DEBOUNCE_MS = 800;

// La respuesta de GET /api/servers ya trae exactamente los mismos campos
// que ServerSummary (ver server.js) -- un alias en vez de repetir la lista.
type ServerApiItem = ServerSummary;

const EMPTY_THRESHOLDS: ServerSummary['thresholds'] = {
  cpuThresholdHigh: null,
  cpuThresholdMedium: null,
  memThresholdHigh: null,
  memThresholdMedium: null,
  diskThresholdHigh: null,
  diskThresholdMedium: null,
};

// Campos que solo llegan por REST (GET /api/servers), no por los mensajes
// de WebSocket de telemetria/backup -- se preservan del estado anterior
// cuando llega un update parcial por WS (ver TELEMETRY/BACKUP_STATUS abajo).
const EMPTY_SITE_INFO = {
  latitude: null,
  longitude: null,
  ispPrimaryName: null,
  ispPrimaryContact: null,
  ispSecondaryName: null,
  ispSecondaryContact: null,
  siteContactName: null,
  siteContactPhone: null,
  hasFortinet: null,
  siteNotes: null,
  syntheticCheckPort: null,
} satisfies Pick<
  ServerSummary,
  | 'latitude'
  | 'longitude'
  | 'ispPrimaryName'
  | 'ispPrimaryContact'
  | 'ispSecondaryName'
  | 'ispSecondaryContact'
  | 'siteContactName'
  | 'siteContactPhone'
  | 'hasFortinet'
  | 'siteNotes'
  | 'syntheticCheckPort'
>;

type TelemetryApiPoint = {
  cpuUsage: number;
  memoryUsage: number;
  diskUsage: number;
  recordedAt: string;
};

function toPoint(t: TelemetryApiPoint): TelemetryPoint {
  return {
    time: new Date(t.recordedAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    cpuUsage: t.cpuUsage,
    memoryUsage: t.memoryUsage,
    diskUsage: t.diskUsage,
  };
}

export default function Dashboard({
  user,
  onUserChanged,
  onLogout,
}: {
  user: CurrentUser;
  onUserChanged: (user: CurrentUser) => void;
  onLogout: () => void;
}) {
  const { role } = user;
  const toast = useToast();
  const [activeTab, setActiveTab] = useState<TabId>('general');
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [servers, setServers] = useState<Record<string, ServerSummary>>({});
  const [history, setHistory] = useState<Record<string, TelemetryPoint[]>>({});
  const [alerts, setAlerts] = useState<SecurityAlert[]>([]);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [showAssistant, setShowAssistant] = useState(false);
  const [fortiEvents, setFortiEvents] = useState<FortiEvent[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const summaryDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleAuthFailure = useCallback(() => {
    onLogout();
  }, [onLogout]);

  const fetchServers = useCallback(async (): Promise<ServerApiItem[] | null> => {
    const res = await fetch(`${API_URL}/api/servers`, { credentials: 'include' });
    if (res.status === 401) {
      handleAuthFailure();
      return null;
    }
    const data: ServerApiItem[] = await res.json();
    setServers(Object.fromEntries(data.map((s) => [s.id, s])));
    return data;
  }, [handleAuthFailure]);

  const fetchEvents = useCallback(async () => {
    const res = await fetch(`${API_URL}/api/events?limit=${MAX_ALERTS}`, { credentials: 'include' });
    if (res.status === 401) {
      handleAuthFailure();
      return;
    }
    setAlerts(await res.json());
  }, [handleAuthFailure]);

  const fetchSummary = useCallback(async () => {
    const res = await fetch(`${API_URL}/api/dashboard/summary`, { credentials: 'include' });
    if (res.status === 401) {
      handleAuthFailure();
      return;
    }
    setSummary(await res.json());
  }, [handleAuthFailure]);

  const fetchHistoryFor = useCallback(
    async (serverId: string) => {
      const res = await fetch(`${API_URL}/api/servers/${serverId}/telemetry?limit=${MAX_POINTS}`, {
        credentials: 'include',
      });
      if (res.status === 401) {
        handleAuthFailure();
        return;
      }
      const data: TelemetryApiPoint[] = await res.json();
      setHistory((prev) => ({ ...prev, [serverId]: data.map(toPoint) }));
    },
    [handleAuthFailure]
  );

  const loadAll = useCallback(async () => {
    const [serverList] = await Promise.all([fetchServers(), fetchEvents(), fetchSummary()]);
    setLastSync(new Date().toISOString());

    const reported = (serverList ?? []).filter((s) => s.cpuUsage !== null);
    if (reported.length > 0) await fetchHistoryFor(reported[0].id);
  }, [fetchServers, fetchEvents, fetchSummary, fetchHistoryFor]);

  const handleManualRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadAll();
    } finally {
      setRefreshing(false);
    }
  }, [loadAll]);

  const handleUpdateEventStatus = useCallback(
    async (id: string, newStatus: 'ACKNOWLEDGED' | 'RESOLVED') => {
      try {
        const res = await fetch(`${API_URL}/api/events/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ status: newStatus }),
        });
        if (res.status === 401) {
          handleAuthFailure();
          return;
        }
        const updated = await res.json();
        if (!res.ok) throw new Error(updated.error || 'No se pudo actualizar la alerta');
        setAlerts((prev) => prev.map((a) => (a.id === id ? { ...a, ...updated } : a)));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Error desconocido');
      }
    },
    [handleAuthFailure, toast]
  );

  const fetchFortiEvents = useCallback(async () => {
    const res = await fetch(`${API_URL}/api/forti/events?limit=200`, { credentials: 'include' });
    if (res.status === 401) {
      handleAuthFailure();
      return;
    }
    if (res.ok) setFortiEvents(await res.json());
  }, [handleAuthFailure]);

  const scheduleSummaryRefresh = useCallback(() => {
    if (summaryDebounce.current) clearTimeout(summaryDebounce.current);
    summaryDebounce.current = setTimeout(fetchSummary, SUMMARY_DEBOUNCE_MS);
  }, [fetchSummary]);

  // Carga inicial: la base ya puede tener servidores/alertas antes de que
  // este cliente abra el WebSocket, que solo emite eventos nuevos desde que
  // se conecta.
  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;

      setStatus('connecting');
      // El navegador manda la cookie httpOnly sola en el handshake del WS
      // (es una request HTTP mas), sin necesidad de pasar nada en la URL.
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => setStatus('connected');

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);

          if (message.type === 'TELEMETRY') {
            const d = message.data;
            const healthStatus = getHealthStatus(d.cpuUsage, d.memoryUsage, d.diskUsage);
            const recordedAt = d.recordedAt ?? new Date().toISOString();

            setServers((prev) => {
              const existing = prev[d.serverId];
              return {
                ...prev,
                [d.serverId]: {
                  ...(existing ?? EMPTY_SITE_INFO),
                  backup: existing?.backup ?? null,
                  thresholds: existing?.thresholds ?? EMPTY_THRESHOLDS,
                  maintenanceUntil: existing?.maintenanceUntil ?? null,
                  inMaintenance: existing?.inMaintenance ?? false,
                  tags: existing?.tags ?? [],
                  agentVersion: existing?.agentVersion ?? null,
                  id: d.serverId,
                  name: d.serverName,
                  status: 'ONLINE',
                  lastSeenAt: recordedAt,
                  healthStatus,
                  cpuUsage: d.cpuUsage,
                  memoryUsage: d.memoryUsage,
                  diskUsage: d.diskUsage,
                  recordedAt,
                },
              };
            });

            setHistory((prev) => {
              const existing = prev[d.serverId] ?? [];
              const point: TelemetryPoint = {
                time: new Date(recordedAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
                cpuUsage: d.cpuUsage,
                memoryUsage: d.memoryUsage,
                diskUsage: d.diskUsage,
              };
              return { ...prev, [d.serverId]: [...existing, point].slice(-MAX_POINTS) };
            });

            setLastSync(recordedAt);
            scheduleSummaryRefresh();
          }

          if (message.type === 'BACKUP_STATUS') {
            const d = message.data;
            const recordedAt = d.recordedAt ?? new Date().toISOString();

            setServers((prev) => {
              const existing = prev[d.serverId];
              return {
                ...prev,
                [d.serverId]: {
                  ...(existing ?? EMPTY_SITE_INFO),
                  status: existing?.status ?? 'OFFLINE',
                  lastSeenAt: existing?.lastSeenAt ?? null,
                  healthStatus: existing?.healthStatus ?? 'UNKNOWN',
                  cpuUsage: existing?.cpuUsage ?? null,
                  memoryUsage: existing?.memoryUsage ?? null,
                  diskUsage: existing?.diskUsage ?? null,
                  recordedAt: existing?.recordedAt ?? null,
                  thresholds: existing?.thresholds ?? EMPTY_THRESHOLDS,
                  maintenanceUntil: existing?.maintenanceUntil ?? null,
                  inMaintenance: existing?.inMaintenance ?? false,
                  tags: existing?.tags ?? [],
                  agentVersion: existing?.agentVersion ?? null,
                  id: d.serverId,
                  name: d.serverName,
                  backup: {
                    result: d.result,
                    method: d.method,
                    lastBackupAt: d.lastBackupAt ?? null,
                    targetPath: d.targetPath ?? null,
                    sizeBytes: d.sizeBytes ?? null,
                    vssServiceOk: d.vssServiceOk,
                    detail: d.detail ?? null,
                    recordedAt,
                  },
                },
              };
            });

            setLastSync(recordedAt);
            scheduleSummaryRefresh();
          }

          // El heartbeat (backend) manda esto cuando marca un servidor
          // OFFLINE por falta de telemetria -- sin esto, el dashboard no se
          // entera hasta el proximo fetch periodico de /api/servers.
          if (message.type === 'SERVER_STATUS') {
            setServers((prev) => {
              const existing = prev[message.serverId];
              if (!existing) return prev;
              return {
                ...prev,
                [message.serverId]: {
                  ...existing,
                  status: message.status,
                  healthStatus: message.status === 'OFFLINE' ? 'CRITICAL' : existing.healthStatus,
                },
              };
            });
            scheduleSummaryRefresh();
          }

          if (message.type === 'SECURITY_ALERT') {
            const ev = message.event;
            setAlerts((prev) =>
              [
                {
                  id: ev.id,
                  type: ev.type,
                  severity: ev.severity,
                  status: 'OPEN' as const,
                  description: ev.description,
                  serverName: ev.serverName,
                  acknowledgedByName: null,
                  createdAt: ev.createdAt ?? new Date().toISOString(),
                  resolvedAt: null,
                },
                ...prev,
              ].slice(0, MAX_ALERTS)
            );
            scheduleSummaryRefresh();
          }

          if (message.type === 'SECURITY_ALERT_UPDATE') {
            const ev = message.event;
            setAlerts((prev) => prev.map((a) => (a.id === ev.id ? { ...a, ...ev } : a)));
            scheduleSummaryRefresh();
          }

          if (message.type === 'FORTI_EVENT') {
            const ev = message.event;
            setFortiEvents((prev) => [ev, ...prev].slice(0, 200));
          }
        } catch (err) {
          console.error('Mensaje WS inválido', err);
        }
      };

      ws.onclose = (event) => {
        setStatus('disconnected');
        wsRef.current = null;

        if (event.code === 4001 || event.code === 4002) {
          handleAuthFailure();
          return;
        }

        if (!cancelled) {
          reconnectTimeout.current = setTimeout(connect, RECONNECT_DELAY_MS);
        }
      };

      ws.onerror = () => ws.close();
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimeout.current) clearTimeout(reconnectTimeout.current);
      if (summaryDebounce.current) clearTimeout(summaryDebounce.current);
      wsRef.current?.close();
    };
  }, [handleAuthFailure, scheduleSummaryRefresh]);

  const serverList = Object.values(servers).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <Header
        status={status}
        lastSync={lastSync}
        userEmail={user.email}
        onLogout={onLogout}
        onOpenAccount={() => setShowAccountModal(true)}
      />
      <TabNav active={activeTab} onChange={setActiveTab} showAdmin={role === 'ADMIN'} />

      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          {activeTab === 'general' && <GeneralTab summary={summary} servers={serverList} alerts={alerts} />}
          {activeTab === 'monitoreo' && (
            <MonitoreoTab
              servers={serverList}
              history={history}
              alerts={alerts}
              onRefresh={handleManualRefresh}
              refreshing={refreshing}
            />
          )}
          {activeTab === 'topologia' && <TopologiaTab servers={serverList} alerts={alerts} />}
          {activeTab === 'mapa' && <MapaTab servers={serverList} alerts={alerts} />}
          {activeTab === 'logs' && <LogsRegexTab alerts={alerts} onUpdateStatus={handleUpdateEventStatus} />}
          {activeTab === 'fortinet' && <FortiTab events={fortiEvents} onRefresh={fetchFortiEvents} />}
          {activeTab === 'guardia' && (
            <GuardiaTab servers={serverList} alerts={alerts} onUpdateStatus={handleUpdateEventStatus} />
          )}
          {activeTab === 'admin' && role === 'ADMIN' && (
            <AdminTab currentUserEmail={user.email} servers={serverList} onServersChanged={fetchServers} />
          )}
        </motion.div>
      </AnimatePresence>

      {showAccountModal && (
        <AccountSettingsModal
          user={user}
          onUserChanged={onUserChanged}
          onClose={() => setShowAccountModal(false)}
          onLogout={onLogout}
        />
      )}

      <AnimatePresence>
        {showAssistant ? (
          <AssistantPanel key="assistant-panel" onClose={() => setShowAssistant(false)} />
        ) : (
          <motion.button
            key="assistant-fab"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            whileHover={{ scale: 1.06 }}
            whileTap={{ scale: 0.96 }}
            onClick={() => setShowAssistant(true)}
            className="fixed bottom-5 right-5 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-brand-600 text-white shadow-lg shadow-brand-900/20"
            title="Abrir asistente"
          >
            <Bot className="h-5 w-5" />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
