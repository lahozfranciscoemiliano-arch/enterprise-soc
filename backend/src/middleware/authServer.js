const bcrypt = require('bcryptjs');
const prisma = require('../prismaClient');

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

    const valid = await bcrypt.compare(apiKey, server.apiKeyHash);

    if (!valid) {
      return res.status(401).json({ error: 'Credenciales de servidor inválidas' });
    }

    req.server = server;
    return next();
  } catch (err) {
    console.error('Error en authServer', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

module.exports = authServer;
