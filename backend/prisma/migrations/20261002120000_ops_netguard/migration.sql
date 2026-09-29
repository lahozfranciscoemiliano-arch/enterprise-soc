-- Guardian de red, prueba de velocidad, tickets, base de conocimiento,
-- remediaciones con PIN, impresoras por MAC y clientes UniFi.
ALTER TYPE "EventType" ADD VALUE 'ROGUE_DHCP';
ALTER TYPE "EventType" ADD VALUE 'GATEWAY_CONFLICT';
ALTER TYPE "EventType" ADD VALUE 'UNKNOWN_DEVICE';
ALTER TYPE "EventType" ADD VALUE 'SPEEDTEST_LOW';

ALTER TABLE "users" ADD COLUMN "pinHash" TEXT;
ALTER TABLE "users" ADD COLUMN "pinFailedCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "pinLockedUntil" TIMESTAMP(3);

ALTER TABLE "servers" ADD COLUMN "contractedDownMbps" DOUBLE PRECISION;
ALTER TABLE "servers" ADD COLUMN "contractedUpMbps" DOUBLE PRECISION;

ALTER TABLE "printers" ADD COLUMN "macAddress" TEXT;
ALTER TABLE "unifi_sites" ADD COLUMN "clients" JSONB;

CREATE TABLE "net_devices" (
    "mac" TEXT NOT NULL,
    "ip" TEXT,
    "hostname" TEXT,
    "vendor" TEXT,
    "source" TEXT,
    "randomized" BOOLEAN NOT NULL DEFAULT false,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "net_devices_pkey" PRIMARY KEY ("mac")
);
CREATE INDEX "net_devices_ip_idx" ON "net_devices"("ip");
CREATE INDEX "net_devices_firstSeenAt_idx" ON "net_devices"("firstSeenAt");

CREATE TABLE "net_gateway_state" (
    "serverId" TEXT NOT NULL,
    "gatewayIp" TEXT NOT NULL,
    "baselineMac" TEXT,
    "currentMac" TEXT,
    "history" JSONB,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "net_gateway_state_pkey" PRIMARY KEY ("serverId")
);

CREATE TABLE "dhcp_offers" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "dhcpServer" TEXT NOT NULL,
    "mac" TEXT,
    "router" TEXT,
    "offeredIp" TEXT,
    "dns" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "authorized" BOOLEAN NOT NULL DEFAULT true,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "dhcp_offers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "dhcp_offers_serverId_dhcpServer_key" ON "dhcp_offers"("serverId", "dhcpServer");

CREATE TABLE "speed_tests" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "serverName" TEXT NOT NULL,
    "publicIp" TEXT,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "error" TEXT,
    "downloadMbps" DOUBLE PRECISION,
    "uploadMbps" DOUBLE PRECISION,
    "latencyMs" DOUBLE PRECISION,
    "jitterMs" DOUBLE PRECISION,
    "contractedDownMbps" DOUBLE PRECISION,
    "contractedUpMbps" DOUBLE PRECISION,
    "manual" BOOLEAN NOT NULL DEFAULT false,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "speed_tests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "speed_tests_serverId_at_idx" ON "speed_tests"("serverId", "at");
CREATE INDEX "speed_tests_at_idx" ON "speed_tests"("at");

CREATE TABLE "tickets" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "eventId" TEXT,
    "eventType" TEXT,
    "serverId" TEXT,
    "serverName" TEXT,
    "assigneeId" TEXT,
    "assigneeName" TEXT,
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT NOT NULL,
    "resolution" TEXT,
    "firstResponseAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "tickets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "tickets_number_key" ON "tickets"("number");
CREATE INDEX "tickets_status_createdAt_idx" ON "tickets"("status", "createdAt");
CREATE INDEX "tickets_assigneeId_status_idx" ON "tickets"("assigneeId", "status");
CREATE INDEX "tickets_eventId_idx" ON "tickets"("eventId");

CREATE TABLE "ticket_comments" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "userId" TEXT,
    "userName" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'comment',
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_comments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ticket_comments_ticketId_createdAt_idx" ON "ticket_comments"("ticketId", "createdAt");
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "knowledge_articles" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "problem" TEXT NOT NULL,
    "solution" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "alertType" TEXT,
    "sourceTicketId" TEXT,
    "createdByName" TEXT NOT NULL,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "knowledge_articles_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "knowledge_articles_alertType_idx" ON "knowledge_articles"("alertType");

CREATE TABLE "remediation_actions" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "serverName" TEXT NOT NULL,
    "eventId" TEXT,
    "ticketId" TEXT,
    "action" TEXT NOT NULL,
    "params" JSONB,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "requestedByName" TEXT NOT NULL,
    "output" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "remediation_actions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "remediation_actions_serverId_status_idx" ON "remediation_actions"("serverId", "status");
CREATE INDEX "remediation_actions_createdAt_idx" ON "remediation_actions"("createdAt");

ALTER TABLE "logon_events" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'logon';
