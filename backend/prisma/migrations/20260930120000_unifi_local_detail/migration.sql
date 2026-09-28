-- Detalle local de UniFi leido por el agente de cada sucursal.
ALTER TABLE "unifi_sites" ADD COLUMN "siteKey" TEXT;
ALTER TABLE "unifi_sites" ADD COLUMN "lanIps" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "unifi_sites" ADD COLUMN "localSource" TEXT;
ALTER TABLE "unifi_sites" ADD COLUMN "localAt" TIMESTAMP(3);
ALTER TABLE "unifi_sites" ADD COLUMN "localError" TEXT;
ALTER TABLE "unifi_sites" ADD COLUMN "controllerUrl" TEXT;
ALTER TABLE "unifi_sites" ADD COLUMN "health" JSONB;

ALTER TABLE "unifi_devices" ADD COLUMN "siteId" TEXT;
ALTER TABLE "unifi_devices" ADD COLUMN "source" TEXT;
ALTER TABLE "unifi_devices" ADD COLUMN "details" JSONB;
CREATE INDEX "unifi_devices_siteId_idx" ON "unifi_devices"("siteId");
