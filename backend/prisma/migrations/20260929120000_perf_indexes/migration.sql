-- Indices para el trabajo 24/7: limpieza de telemetria vieja por fecha
-- (housekeeping) y conteos de alertas abiertas (dashboard, cada pocos segundos).
CREATE INDEX IF NOT EXISTS "telemetry_recordedAt_idx" ON "telemetry"("recordedAt");
CREATE INDEX IF NOT EXISTS "security_events_status_createdAt_idx" ON "security_events"("status", "createdAt");
