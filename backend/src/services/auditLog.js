const prisma = require('../prismaClient');

// No debe interrumpir nunca la operacion principal: si falla el guardado de
// auditoria, se loguea el error pero la request que la disparo sigue su curso.
async function logAudit({ userId, action, targetType, targetId, metadata }) {
  try {
    await prisma.auditLog.create({
      data: { userId, action, targetType, targetId, metadata },
    });
  } catch (err) {
    console.error('Error guardando entrada de auditoría', err);
  }
}

module.exports = { logAudit };
