-- CreateEnum
CREATE TYPE "BackupResult" AS ENUM ('SUCCESS', 'WARNING', 'FAILED', 'NOT_CONFIGURED', 'UNKNOWN');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EventType" ADD VALUE 'BACKUP_FAILED';
ALTER TYPE "EventType" ADD VALUE 'BACKUP_WARNING';

-- CreateTable
CREATE TABLE "backup_status" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "result" "BackupResult" NOT NULL,
    "method" TEXT NOT NULL,
    "lastBackupAt" TIMESTAMP(3),
    "targetPath" TEXT,
    "sizeBytes" DOUBLE PRECISION,
    "vssServiceOk" BOOLEAN NOT NULL DEFAULT false,
    "detail" TEXT,
    "metadata" JSONB,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backup_status_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "backup_status_serverId_recordedAt_idx" ON "backup_status"("serverId", "recordedAt");

-- AddForeignKey
ALTER TABLE "backup_status" ADD CONSTRAINT "backup_status_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
