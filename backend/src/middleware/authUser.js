const jwt = require('jsonwebtoken');
const { isSessionValid } = require('../services/sessions');

const SESSION_COOKIE_NAME = 'soc_session';

async function authUser(req, res, next) {
  const token = req.cookies?.[SESSION_COOKIE_NAME];

  if (!token) {
    return res.status(401).json({ error: 'No autenticado' });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }

  // Los tokens de sesion real siempre llevan un jti; los tokens temporales
  // de 2FA (emitidos entre password OK y codigo TOTP) no lo llevan, asi que
  // quedan automaticamente fuera de cualquier endpoint protegido por esto.
  if (!payload.jti) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }

  const valid = await isSessionValid(payload.jti);
  if (!valid) {
    return res.status(401).json({ error: 'La sesión fue cerrada o expiró' });
  }

  req.user = payload;
  return next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'No autorizado para esta acción' });
    }
    return next();
  };
}

module.exports = { authUser, requireRole, SESSION_COOKIE_NAME };
