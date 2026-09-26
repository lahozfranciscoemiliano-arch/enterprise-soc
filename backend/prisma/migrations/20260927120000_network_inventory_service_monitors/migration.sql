-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EventType" ADD VALUE 'DHCP_SCOPE_EXHAUSTED';
ALTER TYPE "EventType" ADD VALUE 'IP_CONFLICT';
ALTER TYPE "EventType" ADD VALUE 'PRINTER_ISSUE';
ALTER TYPE "EventType" ADD VALUE 'AD_ACCOUNT_LOCKOUT';
ALTER TYPE "EventType" ADD VALUE 'PRIVILEGED_GROUP_CHANGE';

-- AlterTable
ALTER TABLE "servers" ADD COLUMN     "inventoryAt" TIMESTAMP(3),
ADD COLUMN     "inventorySummary" JSONB;

-- CreateTable
CREATE TABLE "dhcp_scopes" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "mask" TEXT NOT NULL,
    "startRange" TEXT NOT NULL,
    "endRange" TEXT NOT NULL,
    "state" TEXT,
    "leaseHours" DOUBLE PRECISION,
    "inUse" INTEGER NOT NULL DEFAULT 0,
    "free" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "percentInUse" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "addresses" JSONB NOT NULL,
    "serverId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dhcp_scopes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "endpoints" (
    "id" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "dnsName" TEXT,
    "os" TEXT,
    "osVersion" TEXT,
    "enabled" BOOLEAN,
    "description" TEXT,
    "ou" TEXT,
    "inAd" BOOLEAN NOT NULL DEFAULT false,
    "adLastLogonAt" TIMESTAMP(3),
    "createdInAdAt" TIMESTAMP(3),
    "ipAddress" TEXT,
    "macAddress" TEXT,
    "online" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenOnlineAt" TIMESTAMP(3),
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUser" TEXT,
    "lastUserAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "printers" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "model" TEXT,
    "serial" TEXT,
    "location" TEXT,
    "status" TEXT,
    "deviceStatus" TEXT,
    "errors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "supplies" JSONB,
    "pageCount" INTEGER,
    "queues" JSONB,
    "snmp" BOOLEAN NOT NULL DEFAULT true,
    "online" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenOnlineAt" TIMESTAMP(3),
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "printers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "directory_users" (
    "sam" TEXT NOT NULL,
    "displayName" TEXT,
    "department" TEXT,
    "title" TEXT,
    "email" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lockedOut" BOOLEAN NOT NULL DEFAULT false,
    "neverExpires" BOOLEAN NOT NULL DEFAULT false,
    "passwordLastSet" TIMESTAMP(3),
    "passwordExpiresAt" TIMESTAMP(3),
    "lastLogonAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "directory_users_pkey" PRIMARY KEY ("sam")
);

-- CreateTable
CREATE TABLE "logon_events" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "hostname" TEXT,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "logon_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "directory_events" (
    "id" TEXT NOT NULL,
    "eventId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "target" TEXT,
    "actor" TEXT,
    "group" TEXT,
    "callerHost" TEXT,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "directory_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_checks" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "intervalSeconds" INTEGER NOT NULL DEFAULT 60,
    "timeoutMs" INTEGER NOT NULL DEFAULT 8000,
    "expectedStatus" INTEGER,
    "keyword" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "lastLatencyMs" INTEGER,
    "lastCheckedAt" TIMESTAMP(3),
    "lastChangeAt" TIMESTAMP(3),
    "lastError" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "certExpiresAt" TIMESTAMP(3),
    "certWarnedDays" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_check_results" (
    "id" TEXT NOT NULL,
    "checkId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "up" BOOLEAN NOT NULL,
    "latencyMs" INTEGER,

    CONSTRAINT "service_check_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "endpoints_hostname_key" ON "endpoints"("hostname");

-- CreateIndex
CREATE INDEX "endpoints_ipAddress_idx" ON "endpoints"("ipAddress");

-- CreateIndex
CREATE INDEX "logon_events_at_idx" ON "logon_events"("at");

-- CreateIndex
CREATE INDEX "logon_events_hostname_at_idx" ON "logon_events"("hostname", "at");

-- CreateIndex
CREATE UNIQUE INDEX "logon_events_username_ipAddress_at_key" ON "logon_events"("username", "ipAddress", "at");

-- CreateIndex
CREATE INDEX "directory_events_at_idx" ON "directory_events"("at");

-- CreateIndex
CREATE UNIQUE INDEX "directory_events_eventId_target_at_key" ON "directory_events"("eventId", "target", "at");

-- CreateIndex
CREATE INDEX "service_check_results_checkId_at_idx" ON "service_check_results"("checkId", "at");

-- AddForeignKey
ALTER TABLE "service_check_results" ADD CONSTRAINT "service_check_results_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "service_checks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

