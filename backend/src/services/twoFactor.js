const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');

const ISSUER = 'Enterprise SOC';

function generateSecret(email) {
  const secret = authenticator.generateSecret();
  const otpauthUrl = authenticator.keyuri(email, ISSUER, secret);
  return { secret, otpauthUrl };
}

async function generateQrCodeDataUrl(otpauthUrl) {
  return QRCode.toDataURL(otpauthUrl);
}

function verifyToken(secret, token) {
  if (!secret || !token) return false;
  try {
    return authenticator.check(String(token).trim(), secret);
  } catch {
    return false;
  }
}

function generateBackupCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i += 1) {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 hex chars
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5, 10)}`);
  }
  return codes;
}

async function hashBackupCodes(codes) {
  return Promise.all(codes.map((code) => bcrypt.hash(code, 10)));
}

// Busca el codigo entre los hashes; devuelve el indice si coincide (para
// poder "consumirlo" borrandolo de la lista), o -1 si no coincide ninguno.
async function findBackupCodeIndex(code, hashedCodes) {
  const normalized = String(code).trim().toUpperCase();
  for (let i = 0; i < hashedCodes.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await bcrypt.compare(normalized, hashedCodes[i])) return i;
  }
  return -1;
}

module.exports = {
  generateSecret,
  generateQrCodeDataUrl,
  verifyToken,
  generateBackupCodes,
  hashBackupCodes,
  findBackupCodeIndex,
};
