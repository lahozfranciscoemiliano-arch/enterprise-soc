const { z } = require('zod');

const telemetrySchema = z
  .object({
    cpuUsage: z.number().min(0).max(100),
    memoryUsage: z.number().min(0).max(100),
    diskUsage: z.number().min(0).max(100),
    networkIn: z.number().min(0).optional(),
    networkOut: z.number().min(0).optional(),
    processCount: z.number().int().min(0).optional(),
    metadata: z.record(z.any()).optional(),
    recordedAt: z.string().datetime().optional(),
    agentVersion: z.string().max(50).optional(),
  })
  .strict();

const loginSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(8).max(200),
  })
  .strict();

const backupStatusSchema = z
  .object({
    result: z.enum(['SUCCESS', 'WARNING', 'FAILED', 'NOT_CONFIGURED', 'UNKNOWN']),
    method: z.string().min(1).max(100),
    lastBackupAt: z.string().datetime().optional(),
    targetPath: z.string().max(500).optional(),
    sizeBytes: z.number().min(0).optional(),
    vssServiceOk: z.boolean(),
    detail: z.string().max(1000).optional(),
    metadata: z.record(z.any()).optional(),
    recordedAt: z.string().datetime().optional(),
  })
  .strict();

const createUserSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(8).max(200),
    name: z.string().min(1).max(200),
    role: z.enum(['ADMIN', 'ANALYST', 'VIEWER']).default('VIEWER'),
  })
  .strict();

const createServerSchema = z
  .object({
    name: z.string().min(1).max(200),
    hostname: z.string().min(1).max(255),
    ipAddress: z.string().min(1).max(100),
    // Opcional: permite que install-agent.ps1/host-monitor.sh etiqueten el
    // servidor (ej. "infra-vps") ya en el alta, sin un paso manual aparte en
    // Admin -> Servidores -> Configurar.
    tags: z.array(z.string().min(1).max(50)).max(20).optional(),
  })
  .strict();

const updateEventStatusSchema = z
  .object({
    status: z.enum(['ACKNOWLEDGED', 'RESOLVED']),
  })
  .strict();

const updateThresholdsSchema = z
  .object({
    cpuThresholdHigh: z.number().min(0).max(100).nullable().optional(),
    cpuThresholdMedium: z.number().min(0).max(100).nullable().optional(),
    memThresholdHigh: z.number().min(0).max(100).nullable().optional(),
    memThresholdMedium: z.number().min(0).max(100).nullable().optional(),
    diskThresholdHigh: z.number().min(0).max(100).nullable().optional(),
    diskThresholdMedium: z.number().min(0).max(100).nullable().optional(),
  })
  .strict();

const updateMaintenanceSchema = z
  .object({
    // null/ausente = terminar el mantenimiento ahora
    maintenanceUntil: z.string().datetime().nullable().optional(),
  })
  .strict();

const login2faSchema = z
  .object({
    tempToken: z.string().min(10),
    code: z.string().min(4).max(12),
  })
  .strict();

const twoFactorCodeSchema = z
  .object({
    code: z.string().min(4).max(12),
  })
  .strict();

const disable2faSchema = z
  .object({
    password: z.string().min(8).max(200),
    code: z.string().min(4).max(12),
  })
  .strict();

// Todos opcionales (PATCH parcial); un string vacio en un campo sensible se
// interpreta como "no cambiar" (ver settings.js).
const settingsSchema = z
  .object({
    SMTP_HOST: z.string().max(255).optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    SMTP_SECURE: z.boolean().optional(),
    SMTP_USER: z.string().max(255).optional(),
    SMTP_PASS: z.string().max(500).optional(),
    SMTP_FROM: z.string().max(255).optional(),
    ALERT_EMAIL_TO: z.string().max(1000).optional(),
    SLACK_WEBHOOK_URL: z.string().max(500).optional(),
    WEBHOOK_URL: z.string().max(500).optional(),
    NOTIFY_MIN_SEVERITY: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
    JWT_EXPIRES_IN: z.string().max(20).optional(),
    DEFAULT_CPU_HIGH: z.coerce.number().min(0).max(100).optional(),
    DEFAULT_CPU_MEDIUM: z.coerce.number().min(0).max(100).optional(),
    DEFAULT_MEM_HIGH: z.coerce.number().min(0).max(100).optional(),
    DEFAULT_MEM_MEDIUM: z.coerce.number().min(0).max(100).optional(),
    DEFAULT_DISK_HIGH: z.coerce.number().min(0).max(100).optional(),
    DEFAULT_DISK_MEDIUM: z.coerce.number().min(0).max(100).optional(),
    AGENT_ENROLLMENT_SECRET: z.string().max(200).optional(),
    AGENT_LATEST_VERSION: z.string().max(50).optional(),
    FORTI_SYSLOG_ENABLED: z.boolean().optional(),
    FORTI_SYSLOG_PORT: z.coerce.number().int().min(1).max(65535).optional(),
    ANTHROPIC_API_KEY: z.string().max(500).optional(),
    ANTHROPIC_MODEL: z.string().max(100).optional(),
    REMOTE_ACCESS_ENABLED: z.boolean().optional(),
    TELEMETRY_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).optional(),
    SECURITY_EVENT_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).optional(),
    BACKUP_STATUS_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).optional(),
    FORTI_EVENT_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).optional(),
    AUDIT_LOG_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).optional(),
    REPORT_ENABLED: z.boolean().optional(),
    REPORT_FREQUENCY: z.enum(['daily', 'weekly']).optional(),
    REPORT_HOUR: z.coerce.number().int().min(0).max(23).optional(),
    REPORT_EMAIL_TO: z.string().max(1000).optional(),
    AGENT_STALE_THRESHOLD_SECONDS: z.coerce.number().int().min(60).max(86400).optional(),
    TELEGRAM_BOT_TOKEN: z.string().max(200).optional(),
    TELEGRAM_CHAT_ID: z.string().max(100).optional(),
  })
  .strict();

const playbookSchema = z
  .object({
    title: z.string().min(1).max(200),
    content: z.string().min(1).max(20000),
  })
  .strict();

const naturalLanguageFilterSchema = z
  .object({
    query: z.string().min(1).max(300),
    events: z
      .array(
        z
          .object({
            id: z.string(),
            serverName: z.string().nullable().optional(),
            type: z.string(),
            severity: z.string(),
            status: z.string(),
            createdAt: z.string(),
            description: z.string(),
          })
          .strict()
      )
      .max(300),
  })
  .strict();

const fortiScreenshotSchema = z
  .object({
    imageBase64: z.string().min(100).max(8_000_000),
    mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  })
  .strict();

const ingestReviewedFortiEventsSchema = z
  .object({
    events: z
      .array(
        z
          .object({
            type: z.enum([
              'VPN_LOGIN', 'VPN_LOGOUT', 'ADMIN_LOGIN', 'CONFIG_CHANGE', 'IPS_ATTACK',
              'VIRUS_DETECTED', 'INTERFACE_DOWN', 'HA_FAILOVER', 'TRAFFIC_ANOMALY',
              'FIREWALL_DENY', 'OTHER',
            ]),
            severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
            description: z.string().min(1).max(1000),
            sourceIp: z.string().max(100).nullable().optional(),
            destIp: z.string().max(100).nullable().optional(),
          })
          .strict()
      )
      .min(1)
      .max(50),
  })
  .strict();

const siteInfoSchema = z
  .object({
    latitude: z.number().min(-90).max(90).nullable().optional(),
    longitude: z.number().min(-180).max(180).nullable().optional(),
    ispPrimaryName: z.string().max(200).nullable().optional(),
    ispPrimaryContact: z.string().max(200).nullable().optional(),
    ispSecondaryName: z.string().max(200).nullable().optional(),
    ispSecondaryContact: z.string().max(200).nullable().optional(),
    siteContactName: z.string().max(200).nullable().optional(),
    siteContactPhone: z.string().max(100).nullable().optional(),
    hasFortinet: z.boolean().nullable().optional(),
    siteNotes: z.string().max(2000).nullable().optional(),
    syntheticCheckPort: z.number().int().min(1).max(65535).nullable().optional(),
  })
  .strict();

const createFortiDeviceSchema = z
  .object({
    name: z.string().min(1).max(200),
    host: z.string().min(1).max(255),
    method: z.enum(['API', 'SYSLOG']).default('API'),
  })
  .strict();

const fortiEventIngestSchema = z
  .object({
    type: z.enum([
      'VPN_LOGIN',
      'VPN_LOGOUT',
      'ADMIN_LOGIN',
      'CONFIG_CHANGE',
      'IPS_ATTACK',
      'VIRUS_DETECTED',
      'INTERFACE_DOWN',
      'HA_FAILOVER',
      'TRAFFIC_ANOMALY',
      'FIREWALL_DENY',
      'OTHER',
    ]),
    severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
    description: z.string().min(1).max(1000),
    sourceIp: z.string().max(100).optional(),
    destIp: z.string().max(100).optional(),
    raw: z.record(z.any()).optional(),
  })
  .strict();

const updateServerTagsSchema = z
  .object({
    tags: z.array(z.string().min(1).max(50)).max(20),
  })
  .strict();

const assistantChatSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant']),
            content: z.string().min(1).max(4000),
          })
          .strict()
      )
      .min(1)
      .max(30),
  })
  .strict();

const createRemoteSessionSchema = z
  .object({
    targetPort: z.number().int().min(1).max(65535).default(3389),
  })
  .strict();

module.exports = {
  telemetrySchema,
  loginSchema,
  backupStatusSchema,
  createUserSchema,
  createServerSchema,
  updateEventStatusSchema,
  updateThresholdsSchema,
  updateMaintenanceSchema,
  login2faSchema,
  twoFactorCodeSchema,
  disable2faSchema,
  settingsSchema,
  createFortiDeviceSchema,
  fortiEventIngestSchema,
  updateServerTagsSchema,
  assistantChatSchema,
  createRemoteSessionSchema,
  playbookSchema,
  naturalLanguageFilterSchema,
  fortiScreenshotSchema,
  ingestReviewedFortiEventsSchema,
  siteInfoSchema,
};
