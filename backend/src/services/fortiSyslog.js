const dgram = require('dgram');
const prisma = require('../prismaClient');
const { getSetting } = require('./settings');
const { parseFortiSyslogLine, classifyFortiFields, ingestFortiEvent } = require('./fortinet');

let socket = null;

// Recibe syslog UDP directo de los FortiGate que se configuren para mandar
// logs a la IP del backend. Cada linea se matchea contra un FortiDevice
// registrado por su IP de origen (host); si no hay ninguno registrado con
// esa IP, se descarta (para no crear eventos "huerfanos" de origenes no
// autorizados). Metodo alternativo a la ingesta por API (ver POST
// /api/forti/events) para cuando el FortiGate no puede hacer un POST HTTP
// pero si mandar syslog.
async function startFortiSyslogListener() {
  const enabled = await getSetting('FORTI_SYSLOG_ENABLED');
  if (!enabled) return null;

  const port = (await getSetting('FORTI_SYSLOG_PORT')) || 5514;

  socket = dgram.createSocket('udp4');

  // Limite simple de paquetes/segundo: syslog UDP no tiene autenticacion
  // propia (a diferencia de la ingesta por API con su propia API key), asi
  // que un flood de paquetes -- con o sin IP de origen falsificada -- no
  // deberia poder traducirse 1:1 en una consulta a la base por paquete.
  const MAX_PACKETS_PER_SECOND = 50;
  let packetsThisSecond = 0;
  setInterval(() => {
    packetsThisSecond = 0;
  }, 1000);

  socket.on('message', async (msg, rinfo) => {
    packetsThisSecond += 1;
    if (packetsThisSecond > MAX_PACKETS_PER_SECOND) return;

    try {
      const line = msg.toString('utf8');
      const fields = parseFortiSyslogLine(line);
      if (!fields) return;

      const device = await prisma.fortiDevice.findFirst({ where: { host: rinfo.address } });
      if (!device) return; // IP no registrada como FortiDevice: se ignora

      const normalized = classifyFortiFields(fields);
      await ingestFortiEvent(device, normalized, fields);
    } catch (err) {
      console.error('Error procesando syslog de FortiGate', err);
    }
  });

  socket.on('error', (err) => {
    console.error('Error en el listener de syslog FortiGate', err);
  });

  await new Promise((resolve) => socket.bind(port, resolve));
  console.log(`Listener de syslog FortiGate escuchando UDP/${port}`);
  return socket;
}

function stopFortiSyslogListener() {
  if (socket) {
    socket.close();
    socket = null;
  }
}

module.exports = { startFortiSyslogListener, stopFortiSyslogListener };
