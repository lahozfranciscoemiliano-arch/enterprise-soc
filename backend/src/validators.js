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

module.exports = { telemetrySchema, loginSchema };
