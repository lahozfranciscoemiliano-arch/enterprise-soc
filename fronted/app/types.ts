export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type HealthStatus = 'OK' | 'WARNING' | 'CRITICAL' | 'UNKNOWN';
export type BackupResult = 'SUCCESS' | 'WARNING' | 'FAILED' | 'NOT_CONFIGURED' | 'UNKNOWN';
export type EventStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';
export type TabId = 'general' | 'monitoreo' | 'topologia' | 'mapa' | 'backups' | 'logs' | 'fortinet' | 'guardia' | 'admin';
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
  aiTriage?: string | null;
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

export type BackupHistoryEntry = {
  id: string;
  serverId: string;
  result: BackupResult;
  method: string;
  lastBackupAt: string | null;
  targetPath: string | null;
  sizeBytes: number | null;
  vssServiceOk: boolean;
  detail: string | null;
  recordedAt: string;
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
  tags: string[];
  agentVersion: string | null;
  healthStatus: HealthStatus;
  cpuUsage: number | null;
  memoryUsage: number | null;
  diskUsage: number | null;
  recordedAt: string | null;
  thresholds: ServerThresholds;
  maintenanceUntil: string | null;
  inMaintenance: boolean;
  backup: BackupInfo | null;
  latitude: number | null;
  longitude: number | null;
  ispPrimaryName: string | null;
  ispPrimaryContact: string | null;
  ispSecondaryName: string | null;
  ispSecondaryContact: string | null;
  siteContactName: string | null;
  siteContactPhone: string | null;
  hasFortinet: boolean | null;
  siteNotes: string | null;
  syntheticCheckPort: number | null;
};

export type FortiEventType =
  | 'VPN_LOGIN'
  | 'VPN_LOGOUT'
  | 'ADMIN_LOGIN'
  | 'CONFIG_CHANGE'
  | 'IPS_ATTACK'
  | 'VIRUS_DETECTED'
  | 'INTERFACE_DOWN'
  | 'HA_FAILOVER'
  | 'TRAFFIC_ANOMALY'
  | 'FIREWALL_DENY'
  | 'OTHER';

export type FortiDevice = {
  id: string;
  name: string;
  host: string;
  method: 'API' | 'SYSLOG';
  lastSeenAt: string | null;
  createdAt: string;
};

export type FortiEvent = {
  id: string;
  type: FortiEventType;
  severity: Severity;
  description: string;
  sourceIp: string | null;
  destIp: string | null;
  deviceName: string;
  createdAt: string;
};

export type RemoteSessionInfo = {
  sessionId: string;
  token: string;
  targetPort: number;
  expiresAt: string;
};

export type RemoteSessionStatus = {
  id: string;
  status: 'PENDING' | 'ACTIVE' | 'CLOSED' | 'EXPIRED' | 'FAILED';
  startedAt: string | null;
  expiresAt: string;
};

export type AssistantChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type AssistantLogEntry = {
  id: string;
  prompt: string;
  response: string;
  userName: string;
  userEmail: string | null;
  createdAt: string;
};

export type SensitiveSetting = { configured: boolean; hint: string | null; source: 'db' | 'env' | null };
export type PlainSetting<T> = { value: T | null; source: 'db' | 'env' | null };

export type SystemSettings = {
  SMTP_HOST: PlainSetting<string>;
  SMTP_PORT: PlainSetting<number>;
  SMTP_SECURE: PlainSetting<boolean>;
  SMTP_USER: PlainSetting<string>;
  SMTP_PASS: SensitiveSetting;
  SMTP_FROM: PlainSetting<string>;
  ALERT_EMAIL_TO: PlainSetting<string>;
  SLACK_WEBHOOK_URL: SensitiveSetting;
  WEBHOOK_URL: SensitiveSetting;
  NOTIFY_MIN_SEVERITY: PlainSetting<Severity>;
  JWT_EXPIRES_IN: PlainSetting<string>;
  DEFAULT_CPU_HIGH: PlainSetting<number>;
  DEFAULT_CPU_MEDIUM: PlainSetting<number>;
  DEFAULT_MEM_HIGH: PlainSetting<number>;
  DEFAULT_MEM_MEDIUM: PlainSetting<number>;
  DEFAULT_DISK_HIGH: PlainSetting<number>;
  DEFAULT_DISK_MEDIUM: PlainSetting<number>;
  AGENT_ENROLLMENT_SECRET: SensitiveSetting;
  AGENT_LATEST_VERSION: PlainSetting<string>;
  FORTI_SYSLOG_ENABLED: PlainSetting<boolean>;
  FORTI_SYSLOG_PORT: PlainSetting<number>;
  ANTHROPIC_API_KEY: SensitiveSetting;
  ANTHROPIC_MODEL: PlainSetting<string>;
  REMOTE_ACCESS_ENABLED: PlainSetting<boolean>;
  TELEMETRY_RETENTION_DAYS: PlainSetting<number>;
  SECURITY_EVENT_RETENTION_DAYS: PlainSetting<number>;
  BACKUP_STATUS_RETENTION_DAYS: PlainSetting<number>;
  FORTI_EVENT_RETENTION_DAYS: PlainSetting<number>;
  AUDIT_LOG_RETENTION_DAYS: PlainSetting<number>;
  REPORT_ENABLED: PlainSetting<boolean>;
  REPORT_FREQUENCY: PlainSetting<'daily' | 'weekly'>;
  REPORT_HOUR: PlainSetting<number>;
  REPORT_EMAIL_TO: PlainSetting<string>;
  AGENT_STALE_THRESHOLD_SECONDS: PlainSetting<number>;
  TELEGRAM_BOT_TOKEN: SensitiveSetting;
  TELEGRAM_CHAT_ID: PlainSetting<string>;
};

export type Playbook = {
  key: string;
  title: string;
  content: string;
  updatedAt: string;
  updatedById: string | null;
};

export type HousekeepingRun = {
  startedAt: string;
  finishedAt: string;
  deleted: Record<string, number>;
  retention: Record<string, number>;
  error: string | null;
};

export type ReportMeta = {
  filename: string;
  sizeBytes: number;
  sizeLabel: string;
  createdAt: string;
};

export type HeartbeatRun = {
  checkedAt: string;
  markedOffline: { id: string; name: string }[];
  error: string | null;
};

export type SyntheticMonitorRun = {
  checkedAt: string;
  checked: number;
  unreachable: { id: string; name: string }[];
};

export type AnomalyBaselineStatus = {
  lastRefreshAt: string | null;
  serversWithBaseline: number;
};

export type FortiScreenshotEvent = {
  type: FortiEventType;
  severity: Severity;
  description: string;
  sourceIp: string | null;
  destIp: string | null;
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
