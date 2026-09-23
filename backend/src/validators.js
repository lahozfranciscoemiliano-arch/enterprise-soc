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
};
