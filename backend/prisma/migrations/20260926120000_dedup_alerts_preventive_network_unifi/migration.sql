-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EventType" ADD VALUE 'DISK_FORECAST';
ALTER TYPE "EventType" ADD VALUE 'DISK_FAILURE_PREDICTED';
ALTER TYPE "EventType" ADD VALUE 'SERVICE_DOWN';
ALTER TYPE "EventType" ADD VALUE 'REBOOT_PENDING';
ALTER TYPE "EventType" ADD VALUE 'PATCHES_OUTDATED';
ALTER TYPE "EventType" ADD VALUE 'NETWORK_DEGRADED';
ALTER TYPE "EventType" ADD VALUE 'ISP_FAILOVER';
ALTER TYPE "EventType" ADD VALUE 'INTERNET_OUTAGE';

-- AlterTable
ALTER TABLE "servers" ADD COLUMN     "diagnostics" JSONB,
ADD COLUMN     "diagnosticsAt" TIMESTAMP(3),
ADD COLUMN     "ispPrimaryPublicIp" TEXT,
ADD COLUMN     "ispSecondaryPublicIp" TEXT,
ADD COLUMN     "network" JSONB,
ADD COLUMN     "networkAt" TIMESTAMP(3),
ADD COLUMN     "publicIp" TEXT;

-- AlterTable
ALTER TABLE "security_events" ADD COLUMN     "autoResolved" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "dedupKey" TEXT,
ADD COLUMN     "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "occurrences" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "unifi_devices" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "model" TEXT,
    "deviceType" TEXT NOT NULL DEFAULT 'other',
    "ipAddress" TEXT,
    "status" TEXT NOT NULL,
    "siteName" TEXT,
    "firmwareVersion" TEXT,
    "firmwareStatus" TEXT,
    "startupTime" TIMESTAMP(3),
    "lastSeenOnlineAt" TIMESTAMP(3),
    "clients" INTEGER,
    "uptimeSeconds" INTEGER,
    "hostName" TEXT,
    "notifiedOffline" BOOLEAN NOT NULL DEFAULT false,
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unifi_devices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "security_events_serverId_dedupKey_status_idx" ON "security_events"("serverId", "dedupKey", "status");


-- ---------------------------------------------------------------------------
-- Limpieza de datos (una sola vez): hasta ahora cada chequeo que seguia en
-- falla creaba una alerta nueva (una por minuto con CPU alto sostenido) y
-- cada chequeo de backup guardaba una fila nueva aunque no hubiera cambiado
-- nada. Se consolidan esos duplicados al nuevo esquema.
-- ---------------------------------------------------------------------------

-- 1. Clave de deduplicacion y ultima vez vista para las alertas existentes.
UPDATE "security_events"
SET "lastSeenAt" = "createdAt",
    "dedupKey" = CASE
      WHEN "metadata" ? 'unhealthyContainers' THEN 'CUSTOM:containers'
      WHEN "metadata" ->> 'field' IS NOT NULL THEN "type"::text || ':' || ("metadata" ->> 'field')
      ELSE "type"::text
    END;

-- 2. Alertas activas (OPEN/ACKNOWLEDGED) repetidas para la misma condicion:
--    queda una sola (la mas reciente, que es la que tiene el estado y la
--    descripcion actuales), con la fecha de la primera ocurrencia y la
--    cantidad de repeticiones. Las alertas ya resueltas no se tocan.
WITH ranked AS (
  SELECT "id",
         ROW_NUMBER() OVER w AS rn,
         COUNT(*) OVER (PARTITION BY "serverId", "dedupKey") AS cnt,
         MIN("createdAt") OVER (PARTITION BY "serverId", "dedupKey") AS first_at,
         MAX("createdAt") OVER (PARTITION BY "serverId", "dedupKey") AS last_at
  FROM "security_events"
  WHERE "status" IN ('OPEN', 'ACKNOWLEDGED')
  WINDOW w AS (PARTITION BY "serverId", "dedupKey" ORDER BY "createdAt" DESC)
)
UPDATE "security_events" e
SET "occurrences" = r.cnt, "createdAt" = r.first_at, "lastSeenAt" = r.last_at
FROM ranked r
WHERE e."id" = r."id" AND r.rn = 1 AND r.cnt > 1;

DELETE FROM "security_events"
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id",
           -- La que se conserva es la que el UPDATE anterior dejo con
           -- occurrences/lastSeenAt maximos (su createdAt ya es el primero).
           ROW_NUMBER() OVER (
             PARTITION BY "serverId", "dedupKey"
             ORDER BY "occurrences" DESC, "lastSeenAt" DESC, "id"
           ) AS rn
    FROM "security_events"
    WHERE "status" IN ('OPEN', 'ACKNOWLEDGED')
  ) t
  WHERE t.rn > 1
);

-- 3. Backups: una fila por corrida real (mismo servidor + resultado + fecha
--    del backup), conservando el ultimo chequeo de cada una.
DELETE FROM "backup_status"
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id",
           ROW_NUMBER() OVER (
             PARTITION BY "serverId", "result", "lastBackupAt"
             ORDER BY "recordedAt" DESC
           ) AS rn
    FROM "backup_status"
  ) t
  WHERE t.rn > 1
);
