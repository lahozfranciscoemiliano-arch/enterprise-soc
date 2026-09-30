-- Busqueda de fabricante por MAC: cache de consultas en linea.
CREATE TABLE "mac_vendor_cache" (
    "prefix" TEXT NOT NULL,
    "vendor" TEXT,
    "address" TEXT,
    "country" TEXT,
    "block" TEXT,
    "source" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "mac_vendor_cache_pkey" PRIMARY KEY ("prefix")
);
