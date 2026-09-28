// Ultima telemetria / ultimo estado de backup por servidor.
//
// NO usar `include: { telemetry: { orderBy, take: 1 } }` de Prisma para
// varios servidores: Prisma genera un SELECT sin LIMIT (trae TODA la
// telemetria historica de todos los servidores, ~600.000 filas con su JSON
// en 30 dias) y recorta en memoria. Eso tenia la CPU de la VPS al 90-99%.
// Aca se usa un LATERAL ... LIMIT 1 que resuelve el indice
// (serverId, recordedAt) en microsegundos por servidor.
const prisma = require('../prismaClient');

async function latestTelemetryMap(serverIds) {
  if (!serverIds.length) return new Map();
  const rows = await prisma.$queryRaw`
    SELECT t.* FROM unnest(${serverIds}::text[]) AS s(id)
    CROSS JOIN LATERAL (
      SELECT * FROM telemetry WHERE "serverId" = s.id ORDER BY "recordedAt" DESC LIMIT 1
    ) t`;
  return new Map(rows.map((r) => [r.serverId, r]));
}

async function latestBackupMap(serverIds) {
  if (!serverIds.length) return new Map();
  const rows = await prisma.$queryRaw`
    SELECT b.* FROM unnest(${serverIds}::text[]) AS s(id)
    CROSS JOIN LATERAL (
      SELECT * FROM backup_status WHERE "serverId" = s.id ORDER BY "recordedAt" DESC LIMIT 1
    ) b`;
  return new Map(rows.map((r) => [r.serverId, r]));
}

// Servidores con `telemetry: [ultima]` y `backups: [ultimo]`, la misma forma
// que devolvia el include de Prisma (el resto del codigo no cambia).
async function withLatest(servers, { telemetry = true, backups = true } = {}) {
  const ids = servers.map((s) => s.id);
  const [tMap, bMap] = await Promise.all([
    telemetry ? latestTelemetryMap(ids) : new Map(),
    backups ? latestBackupMap(ids) : new Map(),
  ]);
  return servers.map((s) => ({
    ...s,
    ...(telemetry ? { telemetry: tMap.has(s.id) ? [tMap.get(s.id)] : [] } : {}),
    ...(backups ? { backups: bMap.has(s.id) ? [bMap.get(s.id)] : [] } : {}),
  }));
}

module.exports = { latestTelemetryMap, latestBackupMap, withLatest };
