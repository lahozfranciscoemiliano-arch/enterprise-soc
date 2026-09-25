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

// Contenido inicial de los playbooks de resolucion (Admin -> Playbooks). Las
// claves son los valores de los enums EventType y FortiEventType (no se
// solapan entre si, ver comentario en schema.prisma sobre el modelo
// Playbook). Solo se crean si no existen -- si un ADMIN ya edito el
// contenido, correr el seed de nuevo no lo pisa.
const DEFAULT_PLAYBOOKS = [
  {
    key: 'CPU_THRESHOLD',
    title: 'Uso de CPU elevado',
    content:
      '1. Verificar en el Administrador de tareas que proceso esta consumiendo CPU.\n' +
      '2. Si es un proceso conocido (backup, antivirus, actualizacion de Windows), esperar a que termine.\n' +
      '3. Si es un proceso desconocido, investigar antes de matarlo (puede ser el propio POS/Aloha).\n' +
      '4. Si persiste mas de 15 minutos, contactar al responsable del sitio.\n' +
      '5. Si es recurrente en el mismo servidor, considerar subir el umbral especifico de ese servidor (Admin -> Servidores -> Configurar) si es un comportamiento normal, o programar una ventana de mantenimiento si se va a intervenir.',
  },
  {
    key: 'MEMORY_THRESHOLD',
    title: 'Uso de RAM elevado',
    content:
      '1. Revisar que proceso esta reteniendo memoria (Administrador de tareas -> ordenar por memoria).\n' +
      '2. Un aumento gradual sin bajar nunca suele ser un memory leak: anotar el proceso y version.\n' +
      '3. Si el servidor no responde bien, coordinar un reinicio en horario de bajo trafico.\n' +
      '4. Si es recurrente, evaluar si el servidor necesita mas RAM o si hay que actualizar la aplicacion responsable.',
  },
  {
    key: 'DISK_THRESHOLD',
    title: 'Disco casi lleno',
    content:
      '1. Identificar que carpeta esta creciendo (logs, backups locales, temporales de Windows Update).\n' +
      '2. Liberar espacio: limpiar logs viejos, vaciar la papelera, correr el Liberador de espacio en disco.\n' +
      '3. Revisar si hay backups locales viejos que ya se subieron a otro destino y se pueden borrar.\n' +
      '4. Si el disco sigue subiendo sin causa clara, revisar el estado del backup (puede estar fallando y acumulando shadow copies de VSS).\n' +
      '5. Si es estructural (el disco quedo chico para el uso real), coordinar una ampliacion.',
  },
  {
    key: 'LOGIN_FAILURE',
    title: 'Fallos de inicio de sesión',
    content:
      '1. Confirmar si los intentos son de un usuario legitimo que olvido la contraseña (llamar para confirmar).\n' +
      '2. Si son muchos intentos en poco tiempo desde distintos usuarios o un origen desconocido, tratar como posible fuerza bruta.\n' +
      '3. Revisar el Visor de Eventos (Seguridad, ID 4625) para el origen exacto.\n' +
      '4. Si es sospechoso, bloquear la cuenta/origen y avisar al equipo de seguridad antes de seguir investigando.',
  },
  {
    key: 'UNAUTHORIZED_ACCESS',
    title: 'Acceso no autorizado',
    content:
      '1. Tratar como incidente de seguridad activo hasta descartar lo contrario -- no minimizar.\n' +
      '2. Identificar la cuenta y el origen (IP) involucrados.\n' +
      '3. Si la cuenta esta comprometida: forzar cambio de contraseña y cerrar sus sesiones activas (Admin -> Usuarios).\n' +
      '4. Documentar en Auditoria que se hizo y cuando.\n' +
      '5. Escalar a la gerencia si hay indicios de acceso a datos sensibles.',
  },
  {
    key: 'MALWARE_DETECTED',
    title: 'Malware detectado',
    content:
      '1. Aislar el servidor de la red si es posible (desconectar cable / deshabilitar NIC) sin apagarlo.\n' +
      '2. No borrar nada todavia: preservar evidencia (logs, muestra del archivo si el antivirus lo permite).\n' +
      '3. Correr un analisis completo con el antivirus instalado.\n' +
      '4. Si el malware se removio limpio, reconectar y monitorear de cerca 24-48hs.\n' +
      '5. Si hay dudas de que se removio completo, restaurar desde el ultimo backup limpio conocido.\n' +
      '6. Revisar si hubo movimiento lateral a otros servidores del mismo sitio.',
  },
  {
    key: 'PORT_SCAN',
    title: 'Escaneo de puertos detectado',
    content:
      '1. Identificar el origen del escaneo (IP interna conocida vs. externa desconocida).\n' +
      '2. Si es interno y conocido (herramienta de IT, auditoria programada), confirmar y cerrar.\n' +
      '3. Si es externo o desconocido, bloquear el origen en el Fortinet del sitio si esta disponible.\n' +
      '4. Revisar que no haya puertos innecesarios expuestos en ese servidor.',
  },
  {
    key: 'BACKUP_FAILED',
    title: 'Backup falló',
    content:
      '1. Revisar el detalle del error en la ficha del servidor (Monitoreo -> ver detalle -> Backup).\n' +
      '2. Confirmar que el servicio VSS este corriendo (services.msc -> Volume Shadow Copy).\n' +
      '3. Verificar espacio libre en el destino del backup.\n' +
      '4. Si el destino es un disco externo/red, confirmar que este conectado y accesible.\n' +
      '5. Reintentar el backup manualmente y confirmar que termine OK.\n' +
      '6. Si vuelve a fallar, escalar -- un servidor sin backup funcionando es una prioridad alta, no queda para "despues".',
  },
  {
    key: 'BACKUP_WARNING',
    title: 'Backup con advertencias',
    content:
      '1. Revisar el detalle: suele ser el servicio VSS detenido aunque el backup en si haya corrido.\n' +
      '2. Iniciar el servicio VSS si esta detenido y dejarlo en Automatico.\n' +
      '3. Confirmar en el proximo ciclo que la advertencia desaparecio.\n' +
      '4. Si se repite en el mismo servidor, investigar por que el servicio se detiene solo.',
  },
  {
    key: 'CUSTOM',
    title: 'Alerta personalizada',
    content:
      '1. Leer la descripcion completa del evento para entender que la disparo.\n' +
      '2. Si viene de un contenedor Docker caido en el propio VPS del NOC (host-monitor.sh), correr "docker compose ps" y revisar los logs del contenedor con "docker compose logs <servicio>".\n' +
      '3. Si no es clara la causa, consultar al asistente (boton 🤖) con el detalle de la alerta.',
  },
  {
    key: 'IPS_ATTACK',
    title: 'Ataque detectado por IPS (Fortinet)',
    content:
      '1. Revisar el evento completo en la pestaña Fortinet: IP origen, firma, severidad.\n' +
      '2. Confirmar si el trafico bloqueado corresponde a un ataque real o a un falso positivo de una app legitima.\n' +
      '3. Si es un ataque real y persistente desde la misma IP, bloquearla explicitamente en el Fortinet.\n' +
      '4. Documentar el origen y la firma para referencia futura.',
  },
  {
    key: 'VIRUS_DETECTED',
    title: 'Virus detectado por Fortinet',
    content:
      '1. Identificar que host interno intento descargar o transmitir el archivo detectado.\n' +
      '2. Aplicar el playbook de "Malware detectado" en ese servidor.\n' +
      '3. Confirmar que el Fortinet bloqueo la transferencia (no solo la detecto).',
  },
  {
    key: 'HA_FAILOVER',
    title: 'Failover de alta disponibilidad (Fortinet)',
    content:
      '1. Confirmar cual de los dos Fortinet (si hay HA configurado) quedo como primario.\n' +
      '2. Revisar el motivo del failover en la consola del Fortinet (perdida de link, reinicio, falla de hardware).\n' +
      '3. Si el dispositivo que quedo como secundario no vuelve a estar disponible, coordinar revision fisica en el sitio.',
  },
  {
    key: 'INTERFACE_DOWN',
    title: 'Interfaz de red caída (Fortinet)',
    content:
      '1. Identificar que interfaz cayo y a que conexion corresponde (de las 2 dedicadas del sitio).\n' +
      '2. Si el sitio tiene doble WAN, confirmar que el trafico paso a la conexion restante sin corte total.\n' +
      '3. Contactar al proveedor de internet de esa conexion especifica para reportar la caida.\n' +
      '4. Si ambas conexiones del sitio estan afectadas, escalar como incidente critico (el sitio queda aislado).',
  },
];

async function seedPlaybooks() {
  let created = 0;
  for (const playbook of DEFAULT_PLAYBOOKS) {
    const existing = await prisma.playbook.findUnique({ where: { key: playbook.key } });
    if (existing) continue;
    await prisma.playbook.create({ data: playbook });
    created += 1;
  }
  console.log(`Playbooks: ${created} creado(s), ${DEFAULT_PLAYBOOKS.length - created} ya existian.\n`);
}

async function main() {
  console.log('=== Seed Enterprise SOC ===\n');
  await seedAdminUser();
  await seedServer();
  await seedPlaybooks();
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
