// Digest proactivo: en vez de esperar a que alguien abra el dashboard y
// note el patron, el propio sistema avisa cuando un servidor viene
// acumulando alertas -- "van 3 alertas de disco esta semana en el mismo
// servidor" es justo el tipo de señal que se pierde entre alertas
// individuales, cada una por separado no necesariamente HIGH/CRITICAL.
const prisma = require('../prismaClient');
const { notifyGeneric } = require('./notifications');
const { draftProactiveNote } = require('./gemini');

const REPEAT_THRESHOLD = 3; // alertas en la ventana para considerarlo un patron
const WINDOW_HOURS = 24;
const COOLDOWN_HOURS = 20; // no repetir el mismo aviso en cada corrida de 6hs si el patron sigue

// Cooldown en memoria (no en base): si el backend se reinicia, en el peor
// caso se manda un digest de mas -- preferible a una tabla nueva solo para
// esto. serverId -> Date del ultimo digest mandado.
const lastDigestSentAt = new Map();

async function runProactiveDigest() {
  const since = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000);

  const events = await prisma.securityEvent.findMany({
    where: { createdAt: { gte: since } },
    include: { server: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  });

  const byServer = new Map(); // serverId -> { name, events: [] }
  for (const e of events) {
    if (!e.server) continue;
    if (!byServer.has(e.serverId)) byServer.set(e.serverId, { name: e.server.name, events: [] });
    byServer.get(e.serverId).events.push(e);
  }

  const now = Date.now();
  let sent = 0;

  for (const [serverId, { name, events: serverEvents }] of byServer) {
    if (serverEvents.length < REPEAT_THRESHOLD) continue;

    const lastSent = lastDigestSentAt.get(serverId);
    if (lastSent && now - lastSent < COOLDOWN_HOURS * 60 * 60 * 1000) continue;

    // eslint-disable-next-line no-await-in-loop
    const note = await draftProactiveNote(name, serverEvents);
    const fallbackNote = `${serverEvents.length} alertas en las últimas ${WINDOW_HOURS}hs -- revisar si es un problema recurrente.`;

    // eslint-disable-next-line no-await-in-loop
    await notifyGeneric({
      severity: 'HIGH',
      subject: `Patrón detectado: ${name} (${serverEvents.length} alertas en 24hs)`,
      text: note || fallbackNote,
      source: 'proactive-digest',
      metadata: { serverId, serverName: name, eventCount: serverEvents.length },
    });

    lastDigestSentAt.set(serverId, now);
    sent += 1;
  }

  if (sent > 0) console.log(`Digest proactivo: ${sent} aviso(s) enviado(s)`);
  return { checkedServers: byServer.size, sent };
}

const DIGEST_INTERVAL_MS = 6 * 60 * 60 * 1000;

function scheduleProactiveDigest() {
  setTimeout(() => {
    runProactiveDigest().catch((err) => console.error('Error en el digest proactivo', err));
    setInterval(() => {
      runProactiveDigest().catch((err) => console.error('Error en el digest proactivo', err));
    }, DIGEST_INTERVAL_MS);
  }, 5 * 60 * 1000);
}

module.exports = { runProactiveDigest, scheduleProactiveDigest };
