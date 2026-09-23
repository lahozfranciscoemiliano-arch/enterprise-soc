export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type HealthStatus = 'OK' | 'WARNING' | 'CRITICAL' | 'UNKNOWN';
export type BackupResult = 'SUCCESS' | 'WARNING' | 'FAILED' | 'NOT_CONFIGURED' | 'UNKNOWN';
export type EventStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';
export type TabId = 'general' | 'monitoreo' | 'topologia' | 'logs' | 'admin';
export type Role = 'ADMIN' | 'ANALYST' | 'VIEWER';

export type AdminUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  twoFactorEnabled: boolean;
  createdAt: string;
};

export type CurrentUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  twoFactorEnabled: boolean;
};

export type AuditLogEntry = {
  id: string;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  userName: string;
  userEmail: string | null;
  createdAt: string;
};

export type SecurityAlert = {
  id: string;
  type: string;
  severity: Severity;
  status: EventStatus;
  description: string;
  serverId?: string;
  serverName?: string;
  acknowledgedByName?: string | null;
  createdAt: string;
  resolvedAt?: string | null;
};

export type BackupInfo = {
  result: BackupResult;
  method: string;
  lastBackupAt: string | null;
  targetPath: string | null;
  sizeBytes: number | null;
  vssServiceOk: boolean;
  detail: string | null;
  recordedAt: string | null;
};

export type ServerThresholds = {
  cpuThresholdHigh: number | null;
  cpuThresholdMedium: number | null;
  memThresholdHigh: number | null;
  memThresholdMedium: number | null;
  diskThresholdHigh: number | null;
  diskThresholdMedium: number | null;
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
  thresholds: ServerThresholds;
  maintenanceUntil: string | null;
  inMaintenance: boolean;
  backup: BackupInfo | null;
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
  backupBreakdown: { SUCCESS: number; WARNING: number; FAILED: number; NOT_CONFIGURED: number; UNKNOWN: number };
};
