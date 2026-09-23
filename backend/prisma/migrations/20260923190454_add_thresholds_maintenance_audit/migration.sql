-- AlterTable
ALTER TABLE "servers" ADD COLUMN     "cpuThresholdHigh" DOUBLE PRECISION,
ADD COLUMN     "cpuThresholdMedium" DOUBLE PRECISION,
ADD COLUMN     "diskThresholdHigh" DOUBLE PRECISION,
ADD COLUMN     "diskThresholdMedium" DOUBLE PRECISION,
ADD COLUMN     "maintenanceUntil" TIMESTAMP(3),
ADD COLUMN     "memThresholdHigh" DOUBLE PRECISION,
ADD COLUMN     "memThresholdMedium" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_userId_createdAt_idx" ON "audit_logs"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
