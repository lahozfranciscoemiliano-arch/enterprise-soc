const bcrypt = require('bcryptjs');
const prisma = require('../prismaClient');

async function authFortiDevice(req, res, next) {
  const deviceId = req.header('x-device-id');
  const apiKey = req.header('x-api-key');

  if (!deviceId || !apiKey) {
    return res.status(401).json({ error: 'Faltan credenciales del dispositivo' });
  }

  try {
    const device = await prisma.fortiDevice.findUnique({ where: { id: deviceId } });

    if (!device) {
      return res.status(401).json({ error: 'Credenciales de dispositivo inválidas' });
    }

    const valid = await bcrypt.compare(apiKey, device.apiKeyHash);

    if (!valid) {
      return res.status(401).json({ error: 'Credenciales de dispositivo inválidas' });
    }

    req.fortiDevice = device;
    return next();
  } catch (err) {
    console.error('Error en authFortiDevice', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}

module.exports = authFortiDevice;
