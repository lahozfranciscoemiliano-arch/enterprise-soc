'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Header from './Header';
import TabNav from './TabNav';
import GeneralTab from './tabs/GeneralTab';
import MonitoreoTab from './tabs/MonitoreoTab';
import TopologiaTab from './tabs/TopologiaTab';
import LogsRegexTab from './tabs/LogsRegexTab';
import { getHealthStatus } from '../lib/health';
import type {
  BackupInfo,
  ConnectionStatus,
  DashboardSummary,
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

type ServerApiItem = {
  id: string;
  name: string;
  status: string;
  lastSeenAt: string | null;
  healthStatus: ServerSummary['healthStatus'];
  cpuUsage: number | null;
  memoryUsage: number | null;
  diskUsage: number | null;
  recordedAt: string | null;
  backup: BackupInfo | null;
};

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

export default function Dashboard({ token, onLogout }: { token: string; onLogout: () => void }) {
  const [activeTab, setActiveTab] = useState<TabId>('general');
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [servers, setServers] = useState<Record<string, ServerSummary>>({});
  const [history, setHistory] = useState<Record<string, TelemetryPoint[]>>({});
  const [alerts, setAlerts] = useState<SecurityAlert[]>([]);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const summaryDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const authHeaders = useRef({ Authorization: `Bearer ${token}` });
  authHeaders.current = { Authorization: `Bearer ${token}` };

  const handleAuthFailure = useCallback(() => {
    window.localStorage.removeItem('soc_token');
    onLogout();
  }, [onLogout]);

  const fetchServers = useCallback(async (): Promise<ServerApiItem[] | null> => {
    const res = await fetch(`${API_URL}/api/servers`, { headers: authHeaders.current });
    if (res.status === 401) {
      handleAuthFailure();
      return null;
    }
    const data: ServerApiItem[] = await res.json();
    setServers(
      Object.fromEntries(
        data.map((s) => [
          s.id,
          {
            id: s.id,
            name: s.name,
            status: s.status,
            lastSeenAt: s.lastSeenAt,
            healthStatus: s.healthStatus,
            cpuUsage: s.cpuUsage,
            memoryUsage: s.memoryUsage,
            diskUsage: s.diskUsage,
            recordedAt: s.recordedAt,
            backup: s.backup,
          },
        ])
      )
    );
    return data;
  }, [handleAuthFailure]);

  const fetchEvents = useCallback(async () => {
    const res = await fetch(`${API_URL}/api/events?limit=${MAX_ALERTS}`, { headers: authHeaders.current });
    if (res.status === 401) {
      handleAuthFailure();
      return;
    }
    setAlerts(await res.json());
  }, [handleAuthFailure]);

  const fetchSummary = useCallback(async () => {
    const res = await fetch(`${API_URL}/api/dashboard/summary`, { headers: authHeaders.current });
    if (res.status === 401) {
      handleAuthFailure();
      return;
    }
    setSummary(await res.json());
  }, [handleAuthFailure]);

  const fetchHistoryFor = useCallback(
    async (serverId: string) => {
      const res = await fetch(`${API_URL}/api/servers/${serverId}/telemetry?limit=${MAX_POINTS}`, {
        headers: authHeaders.current,
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
  }, [token]);

  useEffect(() => {
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;

      setStatus('connecting');
      const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
      wsRef.current = ws;

      ws.onopen = () => setStatus('connected');

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);

          if (message.type === 'TELEMETRY') {
            const d = message.data;
            const healthStatus = getHealthStatus(d.cpuUsage, d.memoryUsage, d.diskUsage);
            const recordedAt = d.recordedAt ?? new Date().toISOString();

            setServers((prev) => ({
              ...prev,
              [d.serverId]: {
                backup: null,
                ...prev[d.serverId],
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
            }));

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

            setServers((prev) => ({
              ...prev,
              [d.serverId]: {
                status: 'OFFLINE',
                lastSeenAt: null,
                healthStatus: 'UNKNOWN',
                cpuUsage: null,
                memoryUsage: null,
                diskUsage: null,
                recordedAt: null,
                ...prev[d.serverId],
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
            }));

            setLastSync(recordedAt);
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
                  description: ev.description,
                  serverName: ev.serverName,
                  createdAt: ev.createdAt ?? new Date().toISOString(),
                },
                ...prev,
              ].slice(0, MAX_ALERTS)
            );
            scheduleSummaryRefresh();
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
  }, [token, handleAuthFailure, scheduleSummaryRefresh]);

  const serverList = Object.values(servers).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <Header status={status} lastSync={lastSync} onLogout={onLogout} />
      <TabNav active={activeTab} onChange={setActiveTab} />

      {activeTab === 'general' && <GeneralTab summary={summary} servers={serverList} />}
      {activeTab === 'monitoreo' && (
        <MonitoreoTab
          servers={serverList}
          history={history}
          alerts={alerts}
          onRefresh={handleManualRefresh}
          refreshing={refreshing}
        />
      )}
      {activeTab === 'topologia' && <TopologiaTab servers={serverList} />}
      {activeTab === 'logs' && <LogsRegexTab alerts={alerts} />}
    </div>
  );
}
