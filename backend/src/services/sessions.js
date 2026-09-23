const crypto = require('crypto');
const prisma = require('../prismaClient');

function msFromExpiresIn(expiresIn) {
  const match = /^(\d+)([smhd])$/.exec(String(expiresIn).trim());
  if (!match) return 8 * 60 * 60 * 1000; // default 8h si el formato no se reconoce
  const value = Number(match[1]);
  const unit = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 }[match[2]];
  return value * unit;
}

async function createSession({ userId, userAgent, ip }) {
  const jti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + msFromExpiresIn(process.env.JWT_EXPIRES_IN || '8h'));

  await prisma.session.create({
    data: { userId, jti, userAgent: userAgent?.slice(0, 300), ip: ip?.slice(0, 100), expiresAt },
  });

  return { jti, expiresAt };
}

async function isSessionValid(jti) {
  if (!jti) return false;
  const session = await prisma.session.findUnique({ where: { jti } });
  if (!session) return false;
  if (session.revokedAt) return false;
  if (session.expiresAt < new Date()) return false;
  return true;
}

async function revokeSession(jti) {
  await prisma.session.updateMany({
    where: { jti, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

async function revokeAllUserSessions(userId) {
  await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

module.exports = { createSession, isSessionValid, revokeSession, revokeAllUserSessions };
