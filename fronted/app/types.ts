export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type HealthStatus = 'OK' | 'WARNING' | 'CRITICAL' | 'UNKNOWN';
export type BackupResult = 'SUCCESS' | 'WARNING' | 'FAILED' | 'NOT_CONFIGURED' | 'UNKNOWN';
export type EventStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';
export type TabId = 'general' | 'monitoreo' | 'red' | 'aplicaciones' | 'inventario' | 'topologia' | 'mapa' | 'backups' | 'logs' | 'fortinet' | 'guardia' | 'admin';
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
  /** Veces que se detecto la misma condicion mientras la alerta seguia activa (deduplicacion). */
  occurrences?: number;
  /** Ultima deteccion; igual a createdAt si occurrences = 1. */
  lastSeenAt?: string;
  /** La cerro el sistema porque la condicion se normalizo. */
  autoResolved?: boolean;
  /** Silenciada: no vuelve a notificar hasta esta fecha. */
  snoozedUntil?: string | null;
  /** Alerta silenciosa (monitoreo de aplicaciones): visible, sin notificar. */
  silent?: boolean;
  /** Recomendacion experta por tipo de alerta (pasos y prevencion). */
  recommendation?: { title: string; steps: string[]; prevention: string } | null;
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
  /** Duracion del ultimo backup exitoso (Visor de Eventos, agente >= 1.3.0). */
  durationSeconds?: number | null;
  /** Cantidad de backups exitosos que Windows conserva. */
  successfulRuns?: number | null;
  /** Todos los metodos de backup detectados en el equipo (agente >= 1.5.0). */
  jobs?: BackupJob[] | null;
  /** Detalle de Windows Server Backup (agente >= 1.7.0). */
  wsb?: WsbDetails | null;
};

export type WsbVolume = {
  name: string;
  transferredBytes: number | null;
  sizeOnDiskBytes: number | null;
  state?: string | null;
  hresult?: string | null;
};

export type WsbDetails = {
  finishedAt?: string | null;
  target?: string | null;
  backupType?: string | null;
  volumes?: WsbVolume[];
  transferredBytes?: number | null;
  versions?: number | null;
  nextBackupAt?: string | null;
  lastSuccessAt?: string | null;
  lastResultHR?: number | null;
  message?: string | null;
  policy?: {
    schedule?: string[];
    bmr?: boolean;
    systemState?: boolean;
    vssOption?: string;
    volumes?: string[];
    targets?: string[];
  } | null;
  lastJob?: {
    state?: string | null;
    startedAt?: string | null;
    endedAt?: string | null;
    durationSeconds?: number | null;
    hresult?: number | null;
    error?: string | null;
    failureLog?: string | null;
  } | null;
  lastFailure?: { at?: string | null; eventId?: number | null; hresult?: string | null; message?: string | null } | null;
};

export type BackupJob = {
  method: string;
  name: string;
  tool?: string | null;
  result: string;
  enabled?: boolean;
  /** Advertencia informativa: hay otro backup exitoso reciente, no afecta el estado. */
  advisory?: boolean;
  lastRunAt?: string | null;
  lastSuccessAt?: string | null;
  nextRunAt?: string | null;
  missedRuns?: number;
  runAs?: string | null;
  targetPath?: string | null;
  sizeBytes?: number | null;
  durationSeconds?: number | null;
  detail?: string | null;
  lastFile?: { file: string; modifiedAt: string; sizeBytes: number } | null;
  stats?: {
    logPath: string;
    finishedAt: string | null;
    filesTotal: number;
    filesCopied: number;
    filesSkipped: number;
    filesFailed: number;
    dirsFailed: number;
    bytesTotal: string;
    bytesCopied: string;
  } | null;
  databases?: { name: string; recovery: string; lastFull: string | null; lastDiff: string | null; lastLog: string | null }[];
};

/** Una corrida de backup (no un chequeo): GET /api/servers/:id/backup-status. */
export type BackupHistoryEntry = {
  id: string;
  result: BackupResult;
  method: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationSeconds: number | null;
  sizeBytes: number | null;
  targetPath: string | null;
  detail: string | null;
  source: 'eventlog' | 'wbadmin' | 'check';
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
  ipAddress?: string | null;
  hostname?: string | null;
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
  // EXCLUDED = sin lectura de backups (VPS); MULTI = todos los metodos (ALOHA*); NATIVE = solo Windows Server Backup.
  backupMode?: 'EXCLUDED' | 'MULTI' | 'NATIVE';
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
  ispPrimaryPublicIp?: string | null;
  ispSecondaryPublicIp?: string | null;
  /** Ultimo estado de red medido por el agente (>= 1.3.0) desde el sitio. */
  network?: NetworkSummary | null;
};

export type ActiveIsp = 'primary' | 'secondary' | 'other' | 'unknown';

export type NetworkSummary = {
  internetUp: boolean | null;
  latencyMs: number | null;
  lossPct: number | null;
  dnsOk: boolean | null;
  dnsMs: number | null;
  gateway: string | null;
  gatewayLatencyMs: number | null;
  gatewayLossPct: number | null;
  publicIp: string | null;
  activeIsp: ActiveIsp;
  nics: { name: string; speedMbps: number | null; errors: number | null; drops: number | null }[];
  at: string | null;
};

/** Un punto agregado de GET /api/servers/:id/metrics. */
export type MetricPoint = {
  t: string;
  cpu: number | null;
  cpuMax: number | null;
  mem: number | null;
  memMax: number | null;
  disk: number | null;
  netIn: number | null;
  netOut: number | null;
  processes: number | null;
  latency: number | null;
  loss: number | null;
};

export type MetricRange = '1h' | '6h' | '24h' | '7d' | '30d';

/** Mensaje TELEMETRY del WebSocket (re-emitido en window como 'soc:telemetry'). */
export type LiveTelemetry = {
  serverId: string;
  serverName: string;
  cpuUsage: number;
  memoryUsage: number;
  diskUsage: number;
  networkIn?: number | null;
  networkOut?: number | null;
  processCount?: number | null;
  latencyMs?: number | null;
  lossPct?: number | null;
  recordedAt: string;
};

export type Diagnostics = {
  collectedAt?: string;
  uptimeSeconds?: number;
  lastBootAt?: string;
  os?: string;
  cpuCount?: number;
  memoryTotalBytes?: number;
  pagefilePercent?: number;
  volumes?: { mount: string; fs?: string; totalBytes?: number; freeBytes?: number; percent: number }[];
  physicalDisks?: { name: string; mediaType?: string; health: string; sizeBytes?: number | null; predictFailure?: boolean }[];
  rebootPending?: boolean;
  updates?: { lastInstalledAt: string | null; pending?: number | null; pendingCritical?: number | null; pendingCheckedAt?: string | null };
  stoppedServices?: { name: string; displayName: string }[];
  defender?: { antivirusEnabled: boolean; realTimeEnabled: boolean; signatureAgeDays: number | null; quickScanAgeDays?: number | null } | null;
  eventSignals?: Partial<Record<'diskErrors' | 'diskBadBlocks' | 'unexpectedShutdowns' | 'bugchecks' | 'lowMemory' | 'failedLogons' | 'malwareDetections', number>>;
  topProcesses?: { byCpu: { name: string; cpu: number; memBytes: number }[]; byMemory: { name: string; cpu: number; memBytes: number }[] };
};

export type DiskForecast =
  | { status: 'insufficient-data'; days: number }
  | { status: 'stable'; current: number; growthPerDay: number; r2: number }
  | { status: 'growing'; current: number; growthPerDay: number; daysTo95: number; daysToFull: number; fullAt: string; r2: number };

export type ServerDetails = {
  id: string;
  name: string;
  hostname: string;
  ipAddress: string;
  agentVersion: string | null;
  diagnostics: Diagnostics | null;
  diagnosticsAt: string | null;
  network: NetworkSummary | null;
  isp: { primaryName: string | null; primaryPublicIp: string | null; secondaryName: string | null; secondaryPublicIp: string | null };
  diskForecast: DiskForecast | null;
  activeAlerts: SecurityAlert[];
};

export type UnifiDevice = {
  id: string;
  name: string;
  model: string | null;
  deviceType: 'ap' | 'switch' | 'gateway' | 'other';
  ipAddress: string | null;
  status: string;
  siteName: string | null;
  hostName: string | null;
  firmwareVersion: string | null;
  firmwareStatus: string | null;
  clients: number | null;
  uptimeSeconds: number | null;
  lastSeenOnlineAt: string | null;
  statusChangedAt: string;
  lastSyncAt: string;
  siteId?: string | null;
  source?: string | null;
  details?: UnifiDeviceDetails | null;
};

export type UnifiDeviceDetails = {
  mac?: string;
  serial?: string | null;
  typeCode?: string | null;
  satisfaction?: number | null;
  cpu?: number | null;
  mem?: number | null;
  userClients?: number | null;
  guestClients?: number | null;
  upgradeTo?: string | null;
  lastSeenAt?: string | null;
  tempC?: number | null;
  uplink?: { type: string | null; device: string | null; port: number | null; speed: number | null; fullDuplex: boolean | null } | null;
  radios?: { band: string; channel: number | null; clients: number | null; satisfaction: number | null; utilization: number | null; txPower: number | null }[];
  ports?: { total: number; up: number; poeWatts: number | null } | null;
};

export type UnifiHealth = Record<
  string,
  {
    status: string | null;
    users: number | null;
    guests: number | null;
    aps: number | null;
    switches: number | null;
    disconnected: number | null;
    wanIp: string | null;
    isp: string | null;
    latencyMs: number | null;
    downMbps: number | null;
    upMbps: number | null;
    uptimeSeconds: number | null;
  }
>;

export type UnifiRun = {
  at: string;
  mode: 'off' | 'cloud' | 'local';
  devices: number;
  online: number;
  offline: number;
  sites?: number;
  sitesOffline?: number;
  detail?: 'sites' | 'devices';
  error: string | null;
} | null;

/** Resumen por sitio de Site Manager (controladores Network Server autoalojados). */
export type UnifiSiteRow = {
  id: string;
  hostId: string;
  hostName: string;
  hostType: string | null;
  siteName: string | null;
  hostOnline: boolean | null;
  version: string | null;
  updateAvailable: boolean | null;
  totalDevices: number;
  offlineDevices: number;
  wifiDevices: number;
  offlineWifi: number;
  wiredDevices: number;
  offlineWired: number;
  gatewayDevices: number;
  offlineGateways: number;
  wifiClients: number;
  wiredClients: number;
  guestClients: number;
  pendingUpdates: number;
  criticalAlerts: number;
  ispName: string | null;
  wanUptime: number | null;
  txRetry: number | null;
  devicesDownSince: string | null;
  hostOfflineSince: string | null;
  lastSyncAt: string;
  lanIps?: string[];
  localSource?: string | null;
  localAt?: string | null;
  localError?: string | null;
  controllerUrl?: string | null;
  health?: UnifiHealth | null;
};

export type NetworkOverview = {
  sites: {
    serverId: string;
    serverName: string;
    status: string;
    lastSeenAt: string | null;
    ispPrimaryName: string | null;
    ispSecondaryName: string | null;
    ispPrimaryPublicIp: string | null;
    ispSecondaryPublicIp: string | null;
    network: NetworkSummary | null;
  }[];
  unifi: { lastRun: UnifiRun; devices: UnifiDevice[]; sites?: UnifiSiteRow[]; agents?: { serverId: string; name: string; https: boolean }[] };
  recentEvents: SecurityAlert[];
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
  GEMINI_API_KEY: SensitiveSetting;
  GEMINI_MODEL: PlainSetting<string>;
  CRITICAL_SERVICES: PlainSetting<string>;
  NOTIFY_QUIET_HOURS: PlainSetting<string>;
  NOTIFY_BATCH_MINUTES: PlainSetting<number>;
  INVENTORY_COLLECTOR: PlainSetting<string>;
  APP_SHARE_TARGETS: PlainSetting<string>;
  BACKUP_MULTI_METHOD_PREFIXES: PlainSetting<string>;
  BACKUP_EXCLUDED_SERVERS: PlainSetting<string>;
  PATCH_MAX_AGE_DAYS: PlainSetting<number>;
  UNIFI_MODE: PlainSetting<string>;
  UNIFI_API_KEY: SensitiveSetting;
  UNIFI_CONTROLLER_URL: PlainSetting<string>;
  UNIFI_VERIFY_TLS: PlainSetting<boolean>;
  UNIFI_LOCAL_ENABLED: PlainSetting<boolean>;
  UNIFI_LOCAL_USERNAME: PlainSetting<string>;
  UNIFI_LOCAL_PASSWORD: SensitiveSetting;
  UNIFI_LOCAL_CONTROLLERS: PlainSetting<string>;
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
  backupServers?: number;
};

// ---------------------------------------------------------------------------
// Inventario de red (agente del servidor con AD/DHCP)
// ---------------------------------------------------------------------------
export type InventorySummary = {
  reporters: {
    id: string;
    name: string;
    inventoryAt: string;
    inventorySummary: {
      collectedAt: string;
      hostname: string | null;
      roles: { dhcp?: boolean; ad?: boolean; printServer?: boolean };
      errors: string[];
      durationSeconds: number | null;
      scanned: number;
      alive: number;
    } | null;
  }[];
  endpoints: { total: number; online: number; stale: number };
  printers: { total: number; online: number; withIssues: number; lowSupplies: number };
  users: { enabled: number; locked: number; passwordExpiringSoon: number };
  ips: { scopes: number; freeDhcp: number; freeStatic: number; conflicts: number; maxScopeUsage: number };
};

export type InventoryEndpoint = {
  id: string;
  hostname: string;
  dnsName: string | null;
  os: string | null;
  osVersion: string | null;
  enabled: boolean | null;
  description: string | null;
  ou: string | null;
  inAd: boolean;
  adLastLogonAt: string | null;
  ipAddress: string | null;
  macAddress: string | null;
  online: boolean;
  lastSeenOnlineAt: string | null;
  statusChangedAt: string;
  lastUser: string | null;
  lastUserAt: string | null;
};

export type LogonRecord = { id: string; username: string; ipAddress: string; hostname: string | null; at: string };

export type DirectoryUserRow = {
  sam: string;
  displayName: string | null;
  department: string | null;
  title: string | null;
  email: string | null;
  enabled: boolean;
  lockedOut: boolean;
  neverExpires: boolean;
  passwordLastSet: string | null;
  passwordExpiresAt: string | null;
  lastLogonAt: string | null;
  lastHost: string | null;
  lastHostIp: string | null;
  lastHostAt: string | null;
};

export type PrinterRow = {
  id: string;
  name: string | null;
  model: string | null;
  serial: string | null;
  location: string | null;
  status: string | null;
  deviceStatus: string | null;
  errors: string[];
  supplies: { name: string; percent: number | null }[] | null;
  pageCount: number | null;
  queues: { name: string; status: string | null; jobs: number | null; shared?: boolean }[] | null;
  snmp: boolean;
  online: boolean;
  lastSeenOnlineAt: string | null;
  statusChangedAt: string;
};

export type IpStatus = 'lease' | 'reserved' | 'static' | 'conflict' | 'free' | 'free-static';

export type IpEntry = { ip: string; s: IpStatus; h?: string; m?: string; u?: string; a?: 1; e?: string };

export type DhcpScopeRow = {
  id: string;
  name: string | null;
  mask: string;
  startRange: string;
  endRange: string;
  state: string | null;
  leaseHours: number | null;
  inUse: number;
  free: number;
  reserved: number;
  percentInUse: number;
  addresses: IpEntry[];
  counts: Record<IpStatus | 'alive', number>;
  freeRanges: string[];
  freeStaticRanges: string[];
  updatedAt: string;
};

export type DirectoryEventRow = {
  id: string;
  eventId: number;
  kind: string;
  target: string | null;
  actor: string | null;
  group: string | null;
  callerHost: string | null;
  at: string;
};

export type ServiceCheckRow = {
  id: string;
  name: string;
  type: 'http' | 'tcp';
  target: string;
  intervalSeconds: number;
  timeoutMs: number;
  expectedStatus: number | null;
  keyword: string | null;
  enabled: boolean;
  status: 'up' | 'down' | 'unknown';
  lastLatencyMs: number | null;
  lastCheckedAt: string | null;
  lastChangeAt: string | null;
  lastError: string | null;
  certExpiresAt: string | null;
  uptime24h: number | null;
  uptime7d: number | null;
  uptime30d: number | null;
  avgLatency24h: number | null;
  recent: { at: string; up: boolean; latencyMs: number | null }[];
};

// ---------------------------------------------------------------------------
// Aplicaciones de negocio (Monark, ALOHA) y micro-cortes
// ---------------------------------------------------------------------------
export type AppService = { name: string; displayName?: string | null; startType?: string | null; status?: string | null };
export type AppSqlInstance = {
  instance: string;
  queryMs: number | null;
  error?: string | null;
  databases: { name: string; sizeMb: number; sessions: number; blocked: number; longestMs: number }[];
};
export type AppTrendPoint = { t: string; cpu: number | null; lat: number | null; latMax: number | null; sql: number | null; down: number; restarts: number };
export type AppInstanceRow = {
  id: string;
  serverId: string;
  serverName: string;
  serverStatus: string | null;
  appKey: 'MONARK' | 'ALOHA';
  label: string;
  status: 'ok' | 'degraded' | 'down';
  statusInfo: string | null;
  lastSeenAt: string;
  detected: {
    services: AppService[];
    processNames: string[];
    installed: { name: string; version: string | null }[];
    databases: { instance: string; name: string }[];
    shares: string[];
    ports: number[];
  };
  metrics: {
    cpuAvg: number | null;
    cpuMax: number | null;
    memMb: number | null;
    latencyAvg: number | null;
    latencyMax: number | null;
    portFailures: number;
    restarts: number;
    servicesDown: string[];
    servicesRunning: number;
    servicesTotal: number;
  } | null;
  sql: { at: string; instances: AppSqlInstance[] } | null;
  trend: AppTrendPoint[];
};
export type ProbeOrigin = {
  serverId: string;
  serverName: string;
  availability: number | null;
  slowPct: number | null;
  avgMs: number | null;
  maxMs: number | null;
  microcuts: number;
  downSeconds: number;
  lastAt: string;
};
export type ProbeTargetRow = { key: string; label: string; category: 'SMB' | 'AD'; origins: ProbeOrigin[]; microcuts: number; availability: number | null };
export type MicroOutageRow = {
  id: string;
  serverId: string;
  serverName: string;
  probeKey: string;
  label: string;
  category: 'SMB' | 'AD' | 'APP';
  cause: string;
  target: string | null;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
};
export type AppsOverview = {
  instances: AppInstanceRow[];
  targets: ProbeTargetRow[];
  ongoing: MicroOutageRow[];
  fileServers: { id: string; name: string; dc: boolean; shares: string[] }[];
};
export type MicrocutAnalysis = {
  days: number;
  total: number;
  totalSeconds: number;
  ongoing: number;
  byHour: { hour: number; SMB: number; AD: number; APP: number }[];
  byDay: { day: string; SMB: number; AD: number; APP: number; seconds: number }[];
  insights: string[];
  events: MicroOutageRow[];
};
