// Defensa en profundidad contra CSRF ademas de la cookie SameSite=Strict:
// si el navegador manda un header Origin (lo hace en toda request de
// escritura desde JS) y no coincide con un origen permitido, se rechaza.
// Clientes que no son navegadores (el agente Python, curl) no mandan este
// header, asi que no se ven afectados.
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function csrfGuard(req, res, next) {
  if (!UNSAFE_METHODS.has(req.method)) return next();

  const origin = req.header('origin');
  if (!origin) return next();

  const allowedOrigins = (process.env.CORS_ORIGIN || '').split(',').filter(Boolean);
  if (allowedOrigins.includes(origin)) return next();

  return res.status(403).json({ error: 'Origen de la solicitud no permitido' });
}

module.exports = { csrfGuard };
