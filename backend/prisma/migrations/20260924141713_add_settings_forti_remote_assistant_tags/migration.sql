-- CreateEnum
CREATE TYPE "FortiIngestMethod" AS ENUM ('API', 'SYSLOG');

-- CreateEnum
CREATE TYPE "FortiEventType" AS ENUM ('VPN_LOGIN', 'VPN_LOGOUT', 'ADMIN_LOGIN', 'CONFIG_CHANGE', 'IPS_ATTACK', 'VIRUS_DETECTED', 'INTERFACE_DOWN', 'HA_FAILOVER', 'TRAFFIC_ANOMALY', 'FIREWALL_DENY', 'OTHER');

-- CreateEnum
CREATE TYPE "RemoteSessionStatus" AS ENUM ('PENDING', 'ACTIVE', 'CLOSED', 'EXPIRED', 'FAILED');

-- AlterTable
ALTER TABLE "servers" ADD COLUMN     "agentVersion" TEXT,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "forti_devices" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "apiKeyHash" TEXT NOT NULL,
    "method" "FortiIngestMethod" NOT NULL DEFAULT 'API',
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "forti_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forti_events" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "type" "FortiEventType" NOT NULL,
    "severity" "EventSeverity" NOT NULL,
    "description" TEXT NOT NULL,
    "sourceIp" TEXT,
    "destIp" TEXT,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "forti_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "remote_sessions" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "targetPort" INTEGER NOT NULL DEFAULT 3389,
    "status" "RemoteSessionStatus" NOT NULL DEFAULT 'PENDING',
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "remote_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assistant_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "forti_devices_name_key" ON "forti_devices"("name");

-- CreateIndex
CREATE INDEX "forti_events_deviceId_createdAt_idx" ON "forti_events"("deviceId", "createdAt");

-- CreateIndex
CREATE INDEX "forti_events_severity_createdAt_idx" ON "forti_events"("severity", "createdAt");

-- CreateIndex
CREATE INDEX "remote_sessions_serverId_createdAt_idx" ON "remote_sessions"("serverId", "createdAt");

-- CreateIndex
CREATE INDEX "assistant_logs_userId_createdAt_idx" ON "assistant_logs"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "forti_events" ADD CONSTRAINT "forti_events_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "forti_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remote_sessions" ADD CONSTRAINT "remote_sessions_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remote_sessions" ADD CONSTRAINT "remote_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assistant_logs" ADD CONSTRAINT "assistant_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
