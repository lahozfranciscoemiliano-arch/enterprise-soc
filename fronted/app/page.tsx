'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
const WS_URL = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:3000/ws';
const MAX_POINTS = 30;
const MAX_ALERTS = 50;
const RECONNECT_DELAY_MS = 3000;

type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

type SecurityAlert = {
  id: string;
  type: string;
  severity: Severity;
  description: string;
  serverName?: string;
  createdAt: string;
};

type TelemetryPoint = {
  time: string;
  cpuUsage: number;
  memoryUsage: number;
  diskUsage: number;
};

type ServerSummary = {
  id: string;
  name: string;
  lastSeenAt: string;
  cpuUsage: number;
  memoryUsage: number;
  diskUsage: number;
};

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

type ServerApiItem = {
  id: string;
  name: string;
  lastSeenAt: string | null;
  cpuUsage: number | null;
  memoryUsage: number | null;
  diskUsage: number | null;
};

type TelemetryApiPoint = {
  cpuUsage: number;
  memoryUsage: number;
  diskUsage: number;
  recordedAt: string;
};

const SEVERITY_STYLES: Record<Severity, string> = {
  LOW: 'bg-slate-500/10 text-slate-300 border-slate-500/30',
  MEDIUM: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30',
  HIGH: 'bg-orange-500/10 text-orange-400 border-orange-500/30',
  CRITICAL: 'bg-red-500/10 text-red-400 border-red-500/30',
};

export default function DashboardPage() {
  const [token, setToken] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);

  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [servers, setServers] = useState<Record<string, ServerSummary>>({});
  const [history, setHistory] = useState<Record<string, TelemetryPoint[]>>({});
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<SecurityAlert[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const stored = window.localStorage.getItem('soc_token');
    if (stored) setToken(stored);
  }, []);

  const handleLogin = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      setLoginError(null);
      setLoggingIn(true);

      try {
        const res = await fetch(`${API_URL}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });

        const body = await res.json();

        if (!res.ok) {
          throw new Error(body.error || 'No se pudo iniciar sesión');
        }

        window.localStorage.setItem('soc_token', body.token);
        setToken(body.token);
      } catch (err) {
        setLoginError(err instanceof Error ? err.message : 'Error desconocido');
      } finally {
        setLoggingIn(false);
      }
    },
    [email, password]
  );

  const handleLogout = useCallback(() => {
    window.localStorage.removeItem('soc_token');
    wsRef.current?.close();
    setToken(null);
    setServers({});
    setHistory({});
    setAlerts([]);
  }, []);

  // Carga el estado ya existente en la base al abrir el dashboard: el
  // WebSocket solo emite eventos nuevos a partir de que se conecta, asi que
  // sin esto una pestana recien abierta se queda vacia hasta la proxima
  // telemetria/alerta, aunque ya haya datos guardados.
  useEffect(() => {
    if (!token) return;

    let cancelled = false;
    const headers = { Authorization: `Bearer ${token}` };

    const loadInitialState = async () => {
      try {
        const [serversRes, eventsRes] = await Promise.all([
          fetch(`${API_URL}/api/servers`, { headers }),
          fetch(`${API_URL}/api/events`, { headers }),
        ]);

        if (serversRes.status === 401 || eventsRes.status === 401) {
          window.localStorage.removeItem('soc_token');
          setToken(null);
          return;
        }

        const serversData: ServerApiItem[] = await serversRes.json();
        const eventsData: SecurityAlert[] = await eventsRes.json();

        if (cancelled) return;

        const reportedServers = serversData.filter(
          (s): s is ServerApiItem & { cpuUsage: number; memoryUsage: number; diskUsage: number } =>
            s.cpuUsage !== null && s.memoryUsage !== null && s.diskUsage !== null
        );

        setServers(
          Object.fromEntries(
            reportedServers.map((s) => [
              s.id,
              {
                id: s.id,
                name: s.name,
                lastSeenAt: s.lastSeenAt ?? new Date().toISOString(),
                cpuUsage: s.cpuUsage,
                memoryUsage: s.memoryUsage,
                diskUsage: s.diskUsage,
              },
            ])
          )
        );

        setAlerts(eventsData);

        const defaultServer = reportedServers[0];
        if (defaultServer) {
          setSelectedServerId((current) => current ?? defaultServer.id);

          const historyRes = await fetch(
            `${API_URL}/api/servers/${defaultServer.id}/telemetry?limit=${MAX_POINTS}`,
            { headers }
          );
          const historyData: TelemetryApiPoint[] = await historyRes.json();

          if (!cancelled) {
            setHistory((prev) => ({
              ...prev,
              [defaultServer.id]: historyData.map((t) => ({
                time: new Date(t.recordedAt).toLocaleTimeString('es-ES', {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                }),
                cpuUsage: t.cpuUsage,
                memoryUsage: t.memoryUsage,
                diskUsage: t.diskUsage,
              })),
            }));
          }
        }
      } catch (err) {
        console.error('No se pudo cargar el estado inicial del dashboard', err);
      }
    };

    loadInitialState();

    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!token) return;

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
            const time = new Date(d.recordedAt ?? Date.now()).toLocaleTimeString('es-ES', {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            });

            setServers((prev) => ({
              ...prev,
              [d.serverId]: {
                id: d.serverId,
                name: d.serverName,
                lastSeenAt: d.recordedAt ?? new Date().toISOString(),
                cpuUsage: d.cpuUsage,
                memoryUsage: d.memoryUsage,
                diskUsage: d.diskUsage,
              },
            }));

            setHistory((prev) => {
              const existing = prev[d.serverId] ?? [];
              const next = [
                ...existing,
                { time, cpuUsage: d.cpuUsage, memoryUsage: d.memoryUsage, diskUsage: d.diskUsage },
              ].slice(-MAX_POINTS);
              return { ...prev, [d.serverId]: next };
            });

            setSelectedServerId((current) => current ?? d.serverId);
          }

          if (message.type === 'SECURITY_ALERT') {
            const ev = message.event;
            setAlerts((prev) =>
              [
                {
                  id: ev.id,
                  type: ev.type,
                  severity: ev.severity as Severity,
                  description: ev.description,
                  serverName: ev.serverName,
                  createdAt: ev.createdAt ?? new Date().toISOString(),
                },
                ...prev,
              ].slice(0, MAX_ALERTS)
            );
          }
        } catch (err) {
          console.error('Mensaje WS inválido', err);
        }
      };

      ws.onclose = (event) => {
        setStatus('disconnected');
        wsRef.current = null;

        if (event.code === 4001 || event.code === 4002) {
          window.localStorage.removeItem('soc_token');
          setToken(null);
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
      wsRef.current?.close();
    };
  }, [token]);

  const serverList = useMemo(() => Object.values(servers), [servers]);
  const selectedHistory = selectedServerId ? history[selectedServerId] ?? [] : [];
  const criticalCount = alerts.filter((a) => a.severity === 'CRITICAL').length;

  if (!token) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gray-950 px-4">
        <form
          onSubmit={handleLogin}
          className="w-full max-w-sm rounded-xl border border-gray-800 bg-gray-900/60 p-8 shadow-xl"
        >
          <h1 className="mb-1 text-xl font-semibold text-gray-100">Enterprise SOC</h1>
          <p className="mb-6 text-sm text-gray-400">Inicia sesión para acceder al panel</p>

          <label className="mb-1 block text-xs font-medium text-gray-400">Email</label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mb-4 w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 outline-none focus:border-blue-500"
          />

          <label className="mb-1 block text-xs font-medium text-gray-400">Contraseña</label>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mb-4 w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 outline-none focus:border-blue-500"
          />

          {loginError && <p className="mb-4 text-sm text-red-400">{loginError}</p>}

          <button
            type="submit"
            disabled={loggingIn}
            className="w-full rounded-lg bg-blue-600 py-2 text-sm font-medium text-white transition hover:bg-blue-500 disabled:opacity-50"
          >
            {loggingIn ? 'Ingresando...' : 'Ingresar'}
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100">
      <header className="flex items-center justify-between border-b border-gray-800 px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold">Enterprise SOC</h1>
          <p className="text-xs text-gray-500">Monitoreo de infraestructura en tiempo real</p>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <span
              className={`h-2 w-2 rounded-full ${
                status === 'connected'
                  ? 'bg-emerald-500'
                  : status === 'connecting'
                  ? 'bg-yellow-500'
                  : 'bg-red-500'
              }`}
            />
            {status === 'connected' ? 'Conectado' : status === 'connecting' ? 'Conectando...' : 'Desconectado'}
          </div>
          <button
            onClick={handleLogout}
            className="rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800"
          >
            Cerrar sesión
          </button>
        </div>
      </header>

      <section className="grid grid-cols-1 gap-4 px-6 py-6 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Servidores activos" value={serverList.length.toString()} />
        <StatCard
          label="CPU actual"
          value={
            selectedHistory.length
              ? `${selectedHistory[selectedHistory.length - 1].cpuUsage.toFixed(1)}%`
              : '—'
          }
        />
        <StatCard label="Alertas totales" value={alerts.length.toString()} />
        <StatCard label="Alertas críticas" value={criticalCount.toString()} accent={criticalCount > 0} />
      </section>

      <section className="grid grid-cols-1 gap-4 px-6 pb-6 lg:grid-cols-3">
        <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4 lg:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-200">CPU / RAM en tiempo real</h2>
            {serverList.length > 0 && (
              <select
                value={selectedServerId ?? ''}
                onChange={(e) => setSelectedServerId(e.target.value)}
                className="rounded-lg border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-200"
              >
                {serverList.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="h-72">
            {selectedHistory.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-gray-500">
                Esperando telemetría...
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={selectedHistory}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                  <XAxis dataKey="time" stroke="#6b7280" fontSize={11} />
                  <YAxis stroke="#6b7280" fontSize={11} domain={[0, 100]} unit="%" />
                  <Tooltip
                    contentStyle={{ background: '#111827', border: '1px solid #1f2937', fontSize: 12 }}
                    labelStyle={{ color: '#9ca3af' }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey="cpuUsage" name="CPU %" stroke="#3b82f6" strokeWidth={2} dot={false} />
                  <Line
                    type="monotone"
                    dataKey="memoryUsage"
                    name="RAM %"
                    stroke="#a855f7"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">
          <h2 className="mb-4 text-sm font-semibold text-gray-200">Servidores</h2>
          <div className="space-y-2">
            {serverList.length === 0 && <p className="text-sm text-gray-500">Sin datos aún</p>}
            {serverList.map((s) => (
              <div
                key={s.id}
                className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-950/50 px-3 py-2 text-xs"
              >
                <span className="font-medium text-gray-200">{s.name}</span>
                <span className="text-gray-400">
                  CPU {s.cpuUsage.toFixed(0)}% · RAM {s.memoryUsage.toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="px-6 pb-10">
        <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">
          <h2 className="mb-4 text-sm font-semibold text-gray-200">Alertas de seguridad</h2>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-gray-800 text-gray-500">
                  <th className="py-2 pr-4 font-medium">Hora</th>
                  <th className="py-2 pr-4 font-medium">Servidor</th>
                  <th className="py-2 pr-4 font-medium">Tipo</th>
                  <th className="py-2 pr-4 font-medium">Severidad</th>
                  <th className="py-2 pr-4 font-medium">Descripción</th>
                </tr>
              </thead>
              <tbody>
                {alerts.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-gray-500">
                      No hay alertas registradas todavía
                    </td>
                  </tr>
                )}
                {alerts.map((a) => (
                  <tr key={a.id} className="border-b border-gray-800/60">
                    <td className="py-2 pr-4 text-gray-400">
                      {new Date(a.createdAt).toLocaleTimeString('es-ES')}
                    </td>
                    <td className="py-2 pr-4 text-gray-300">{a.serverName ?? '—'}</td>
                    <td className="py-2 pr-4 text-gray-300">{a.type}</td>
                    <td className="py-2 pr-4">
                      <span className={`rounded-full border px-2 py-0.5 text-[11px] ${SEVERITY_STYLES[a.severity]}`}>
                        {a.severity}
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-gray-400">{a.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </main>
  );
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${accent ? 'text-red-400' : 'text-gray-100'}`}>{value}</p>
    </div>
  );
}
