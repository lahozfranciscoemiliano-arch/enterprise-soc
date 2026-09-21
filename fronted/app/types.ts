export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type HealthStatus = 'OK' | 'WARNING' | 'CRITICAL' | 'UNKNOWN';
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';
export type TabId = 'general' | 'monitoreo' | 'topologia' | 'logs';

export type SecurityAlert = {
  id: string;
  type: string;
  severity: Severity;
  description: string;
  serverId?: string;
  serverName?: string;
  createdAt: string;
};

export type ServerSummary = {
  id: string;
  name: string;
  status: string;
  lastSeenAt: string | null;
  healthStatus: HealthStatus;
  cpuUsage: number | null;
  memoryUsage: number | null;
  diskUsage: number | null;
  recordedAt: string | null;
};

export type TelemetryPoint = {
  time: string;
  cpuUsage: number;
  memoryUsage: number;
  diskUsage: number;
};

export type DashboardSummary = {
  totalServers: number;
  healthyServers: number;
  slaPercentage: number;
  telemetryToday: number;
  openAlerts: number;
  criticalAlerts: number;
  healthBreakdown: { OK: number; WARNING: number; CRITICAL: number; UNKNOWN: number };
};
