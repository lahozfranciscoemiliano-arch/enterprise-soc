-- Monitoreo de aplicaciones de negocio (Monark, ALOHA) y micro-cortes.
ALTER TYPE "EventType" ADD VALUE 'APP_SERVICE_DOWN';
ALTER TYPE "EventType" ADD VALUE 'APP_PERFORMANCE';
ALTER TYPE "EventType" ADD VALUE 'NETWORK_MICROCUTS';

ALTER TABLE "security_events" ADD COLUMN "silent" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "servers" ADD COLUMN "appRoles" JSONB;

CREATE TABLE "app_instances" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "appKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "statusInfo" TEXT,
    "detected" JSONB NOT NULL,
    "metrics" JSONB,
    "sql" JSONB,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "app_instances_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "app_instances_serverId_appKey_key" ON "app_instances"("serverId", "appKey");

CREATE TABLE "app_samples" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "appKey" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cpu" DOUBLE PRECISION,
    "memMb" DOUBLE PRECISION,
    "latencyMs" DOUBLE PRECISION,
    "latencyMax" DOUBLE PRECISION,
    "sqlMs" DOUBLE PRECISION,
    "blocked" INTEGER,
    "servicesDown" INTEGER NOT NULL DEFAULT 0,
    "restarts" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "app_samples_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "app_samples_serverId_appKey_at_idx" ON "app_samples"("serverId", "appKey", "at");
CREATE INDEX "app_samples_at_idx" ON "app_samples"("at");

CREATE TABLE "probe_stats" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "probeKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "target" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "samples" INTEGER NOT NULL,
    "failures" INTEGER NOT NULL,
    "slow" INTEGER NOT NULL,
    "avgMs" DOUBLE PRECISION,
    "maxMs" DOUBLE PRECISION,
    "p95Ms" DOUBLE PRECISION,
    CONSTRAINT "probe_stats_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "probe_stats_serverId_probeKey_at_idx" ON "probe_stats"("serverId", "probeKey", "at");
CREATE INDEX "probe_stats_category_at_idx" ON "probe_stats"("category", "at");
CREATE INDEX "probe_stats_at_idx" ON "probe_stats"("at");

CREATE TABLE "micro_outages" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "probeKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "cause" TEXT NOT NULL,
    "target" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER,
    CONSTRAINT "micro_outages_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "micro_outages_serverId_probeKey_startedAt_key" ON "micro_outages"("serverId", "probeKey", "startedAt");
CREATE INDEX "micro_outages_startedAt_idx" ON "micro_outages"("startedAt");
CREATE INDEX "micro_outages_category_startedAt_idx" ON "micro_outages"("category", "startedAt");
