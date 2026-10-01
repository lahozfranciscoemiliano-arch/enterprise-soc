-- Parque de servidores: ficha técnica y foto propia.
ALTER TABLE "servers" ADD COLUMN "assetInfo" JSONB;

CREATE TABLE "server_photos" (
    "serverId" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "server_photos_pkey" PRIMARY KEY ("serverId")
);
