const { PrismaClient } = require('@prisma/client');

// Pool de conexiones a Postgres dimensionado para la VPS (DATABASE_POOL_SIZE
// lo calcula deploy/tune-vps.sh segun los nucleos). Sin definir, Prisma usa
// su default (nucleos * 2 + 1).
function databaseUrl() {
  const url = process.env.DATABASE_URL;
  const pool = Number(process.env.DATABASE_POOL_SIZE);
  if (!url || !pool || /[?&]connection_limit=/.test(url)) return undefined;
  return `${url}${url.includes('?') ? '&' : '?'}connection_limit=${pool}&pool_timeout=20`;
}

const url = databaseUrl();
const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  ...(url ? { datasources: { db: { url } } } : {}),
});

module.exports = prisma;
