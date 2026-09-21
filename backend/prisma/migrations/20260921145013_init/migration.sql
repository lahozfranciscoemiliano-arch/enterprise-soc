-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'ANALYST', 'VIEWER');

-- CreateEnum
CREATE TYPE "ServerStatus" AS ENUM ('ONLINE', 'OFFLINE', 'DEGRADED');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('CPU_THRESHOLD', 'MEMORY_THRESHOLD', 'DISK_THRESHOLD', 'LOGIN_FAILURE', 'UNAUTHORIZED_ACCESS', 'MALWARE_DETECTED', 'PORT_SCAN', 'CUSTOM');

-- CreateEnum
CREATE TYPE "EventSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'VIEWER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "servers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "apiKeyHash" TEXT NOT NULL,
    "status" "ServerStatus" NOT NULL DEFAULT 'OFFLINE',
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "servers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telemetry" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "cpuUsage" DOUBLE PRECISION NOT NULL,
    "memoryUsage" DOUBLE PRECISION NOT NULL,
    "diskUsage" DOUBLE PRECISION NOT NULL,
    "networkIn" DOUBLE PRECISION,
    "networkOut" DOUBLE PRECISION,
    "processCount" INTEGER,
    "metadata" JSONB,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telemetry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_events" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "type" "EventType" NOT NULL,
    "severity" "EventSeverity" NOT NULL,
    "status" "EventStatus" NOT NULL DEFAULT 'OPEN',
    "description" TEXT NOT NULL,
    "sourceIp" TEXT,
    "metadata" JSONB,
    "acknowledgedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "servers_name_key" ON "servers"("name");

-- CreateIndex
CREATE INDEX "telemetry_serverId_recordedAt_idx" ON "telemetry"("serverId", "recordedAt");

-- CreateIndex
CREATE INDEX "security_events_serverId_createdAt_idx" ON "security_events"("serverId", "createdAt");

-- CreateIndex
CREATE INDEX "security_events_severity_status_idx" ON "security_events"("severity", "status");

-- AddForeignKey
ALTER TABLE "telemetry" ADD CONSTRAINT "telemetry_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
