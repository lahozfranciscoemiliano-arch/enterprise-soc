-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EventType" ADD VALUE 'AGENT_OFFLINE';
ALTER TYPE "EventType" ADD VALUE 'ANOMALY_DETECTED';
ALTER TYPE "EventType" ADD VALUE 'NETWORK_UNREACHABLE';

-- AlterTable
ALTER TABLE "security_events" ADD COLUMN     "aiTriage" TEXT;

-- AlterTable
ALTER TABLE "servers" ADD COLUMN     "hasFortinet" BOOLEAN,
ADD COLUMN     "ispPrimaryContact" TEXT,
ADD COLUMN     "ispPrimaryName" TEXT,
ADD COLUMN     "ispSecondaryContact" TEXT,
ADD COLUMN     "ispSecondaryName" TEXT,
ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "longitude" DOUBLE PRECISION,
ADD COLUMN     "siteContactName" TEXT,
ADD COLUMN     "siteContactPhone" TEXT,
ADD COLUMN     "siteNotes" TEXT,
ADD COLUMN     "syntheticCheckPort" INTEGER;
