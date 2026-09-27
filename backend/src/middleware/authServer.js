const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const prisma = require('../prismaClient');

// Cache de API keys ya verificadas. Cada agente pega cada 60 s (telemetria,
// backups, inventario) y bcrypt es CPU pura en JavaScript: con decenas de
// servidores, comparar el hash en cada request bloqueaba el event loop y
// demoraba todo el NOC. Se guarda solo un SHA-256 de la key (nunca la key) y
// el hash de la base con el que se valido: si la key se rota, el hash cambia
// y la entrada deja de servir sola.
const CACHE_TTL_MS = 15 * 60 * 1000;
const verified = new Map(); // serverId -> { apiKeyHash, digest, expiresAt }

function digestOf(apiKey) {
  return crypto.createHash('sha256').update(apiKey).digest();
}

function cachedOk(server, digest) {
  const entry = verified.get(server.id);
  if (!entry || entry.expiresAt < Date.now() || entry.apiKeyHash !== server.apiKeyHash) return false;
  return crypto.timingSafeEqual(entry.digest, digest);
}

async function authServer(req, res, next) {
  const serverId = req.header('x-server-id');
  const apiKey = req.header('x-api-key');

  if (!serverId || !apiKey) {
    return res.status(401).json({ error: 'Faltan credenciales del servidor' });
  }

  try {
    const server = await prisma.server.findUnique({ where: { id: serverId } });

    if (!server) {
      return res.status(401).json({ error: 'Credenciales de servidor inválidas' });
    }

    const digest = digestOf(apiKey);
    if (!cachedOk(server, digest)) {
      const valid = await bcrypt.compare(apiKey, server.apiKeyHash);
      if (!valid) {
        return res.status(401).json({ error: 'Credenciales de servidor inválidas' });
      }
      verified.set(server.id, { apiKeyHash: server.apiKeyHash, digest, expiresAt: Date.now() + CACHE_TTL_MS });
    }

    req.server = server;
    return next();
  } catch (err) {
    console.error('Error en authServer', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

module.exports = authServer;
