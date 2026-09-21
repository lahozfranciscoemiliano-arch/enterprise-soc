const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const prisma = new PrismaClient();

async function seedAdminUser() {
  const email = process.env.SEED_ADMIN_EMAIL || 'admin@enterprise-soc.local';

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`Usuario '${email}' ya existe, no se modifica su contraseña.\n`);
    return;
  }

  const password = process.env.SEED_ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  const passwordHash = await bcrypt.hash(password, 12);

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      name: process.env.SEED_ADMIN_NAME || 'Administrador',
      role: 'ADMIN',
    },
  });

  console.log('Usuario administrador creado (login del dashboard):');
  console.log(`  email:    ${user.email}`);
  console.log(`  password: ${password}`);
  console.log('  Guarda esta contraseña ahora: no se puede recuperar después, solo se guarda su hash.\n');
}

async function seedServer() {
  const name = process.env.SEED_SERVER_NAME || 'web-server-01';

  const existing = await prisma.server.findUnique({ where: { name } });
  if (existing) {
    console.log(`Servidor '${name}' ya existe (id: ${existing.id}), no se genera una nueva API key.`);
    console.log('Para rotarla, borra el registro o corre el seed con otro SEED_SERVER_NAME.\n');
    return;
  }

  const apiKey = process.env.SEED_SERVER_API_KEY || crypto.randomBytes(32).toString('hex');
  const apiKeyHash = await bcrypt.hash(apiKey, 12);

  const server = await prisma.server.create({
    data: {
      name,
      hostname: process.env.SEED_SERVER_HOSTNAME || name,
      ipAddress: process.env.SEED_SERVER_IP || '127.0.0.1',
      apiKeyHash,
      status: 'OFFLINE',
    },
  });

  console.log('Servidor registrado (credenciales para el agente Python):');
  console.log(`  SERVER_ID: ${server.id}`);
  console.log(`  API_KEY:   ${apiKey}`);
  console.log('  Copia estos valores al .env del agente (SERVER_ID y API_KEY).');
  console.log('  Guarda la API key ahora: no se puede recuperar después, solo se guarda su hash.\n');
}

async function main() {
  console.log('=== Seed Enterprise SOC ===\n');
  await seedAdminUser();
  await seedServer();
  console.log('Seed finalizado.');
}

main()
  .catch((err) => {
    console.error('Error al ejecutar el seed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
