#!/usr/bin/env node
// Relay local para el acceso remoto de Enterprise SOC. Corre en tu propia
// maquina (no en el servidor al que te queres conectar): abre un puerto TCP
// local y lo conecta, via WebSocket, al tunel que ya armaron el backend y el
// agente del servidor de destino. Uso tipico:
//
//   cd tools
//   npm install
//   node remote-relay.js --backend wss://noc.tudominio.com --session <id> --token <token>
//   mstsc /v:localhost:13389
//
// El backend y el token te los da el dashboard al hacer clic en "Conectar
// por RDP" (Admin -> Servidores). El token es de un solo uso y expira en
// pocos minutos si no lo usas.

const net = require('net');
const WebSocket = require('ws');

function parseArgs() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    args[key] = argv[i + 1];
  }
  return args;
}

function fail(msg) {
  console.error(`Error: ${msg}`);
  console.error(
    '\nUso: node remote-relay.js --backend wss://tu-backend --session <id> --token <token> [--local-port 13389]'
  );
  process.exit(1);
}

const args = parseArgs();
if (!args.backend || !args.session || !args.token) {
  fail('faltan argumentos obligatorios (--backend, --session, --token)');
}

const localPort = Number(args['local-port'] || 13389);
const tunnelUrl = `${args.backend.replace(/\/$/, '')}/ws/tunnel/${args.session}?role=client&token=${args.token}`;

console.log(`Enterprise SOC - relay de acceso remoto`);
console.log(`Escuchando en 127.0.0.1:${localPort} ...`);
console.log(`(conectá tu cliente RDP/VNC ahí, ej.: mstsc /v:localhost:${localPort})`);

let used = false;

const server = net.createServer((socket) => {
  if (used) {
    // El token es de un solo uso; una segunda conexion no tiene con que
    // relayar. Se corta y listo, en vez de dejar el puerto abierto colgado.
    socket.destroy();
    return;
  }
  used = true;

  console.log('Conexión entrante, estableciendo túnel...');

  // El cliente RDP/VNC puede mandar sus primeros bytes apenas conecta, antes
  // de que el WebSocket termine el handshake con el backend (que es
  // asincronico, aunque sea localhost). Sin esto, esos primeros bytes se
  // pierden en silencio y el tunel queda colgado sin dar ningun error.
  socket.pause();
  const ws = new WebSocket(tunnelUrl);

  ws.on('open', () => {
    console.log('Túnel establecido. Podés usar tu cliente RDP/VNC normalmente.');
    socket.resume();
  });

  ws.on('message', (data) => {
    socket.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
  });

  socket.on('data', (data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  });

  const cleanup = (why) => {
    console.log(`Conexión cerrada (${why}).`);
    socket.destroy();
    server.close();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
      // Dar un instante a que salga el frame de cierre antes de terminar el
      // proceso; si no, a veces el backend tarda en notar la desconexion
      // porque el TCP se corta de golpe en vez de una salida prolija de WS.
      setTimeout(() => process.exit(0), 200);
    } else {
      process.exit(0);
    }
  };

  ws.on('close', () => cleanup('túnel cerrado'));
  ws.on('error', (err) => {
    console.error('Error en el túnel:', err.message);
    cleanup('error de túnel');
  });
  socket.on('close', () => cleanup('cliente RDP/VNC desconectado'));
  socket.on('error', () => cleanup('error de socket local'));
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    fail(`el puerto ${localPort} ya está en uso. Probá con --local-port otro-numero.`);
  }
  console.error('Error del servidor local:', err.message);
  process.exit(1);
});

server.listen(localPort, '127.0.0.1');
