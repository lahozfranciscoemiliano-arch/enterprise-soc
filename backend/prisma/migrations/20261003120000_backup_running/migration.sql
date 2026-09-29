-- Backup en curso: se informa "En proceso" en vez de un resultado.
ALTER TYPE "BackupResult" ADD VALUE 'RUNNING';

-- Prueba de velocidad con Speedtest by Ookla.
ALTER TABLE "speed_tests" ADD COLUMN "packetLoss" DOUBLE PRECISION;
ALTER TABLE "speed_tests" ADD COLUMN "provider" TEXT;
ALTER TABLE "speed_tests" ADD COLUMN "isp" TEXT;
ALTER TABLE "speed_tests" ADD COLUMN "testServer" TEXT;
ALTER TABLE "speed_tests" ADD COLUMN "resultUrl" TEXT;

-- Mapa de IPs por gateway: redes de cada sede barridas por su agente.
ALTER TABLE "dhcp_scopes" ADD COLUMN "gateway" TEXT;
ALTER TABLE "dhcp_scopes" ADD COLUMN "source" TEXT;
