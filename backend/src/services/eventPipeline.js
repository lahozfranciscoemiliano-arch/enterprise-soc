// Punto unico de creacion de SecurityEvent: centraliza lo que antes estaba
// repetido en cada lugar que dispara una alerta (telemetria, backups,
// heartbeat, y ahora tambien anomalias y synthetic monitoring). Crea el
// evento, lo transmite por WebSocket, dispara la notificacion externa
// (email/Slack/webhook/Telegram), y pide un triage a Claude en segundo
// plano -- todo en un solo lugar, para que una funcionalidad nueva que
// dispare alertas no tenga que reimplementar las cuatro cosas.
const prisma = require('../prismaClient');
const { broadcastAlert } = require('../websocket/socketServer');
const { notifyAlert } = require('./notifications');
const { triageEvent } = require('./claude');

async function createAndDispatchEvent({ serverId, serverName, type, severity, description, metadata }) {
  const event = await prisma.securityEvent.create({
    data: { serverId, type, severity, description, metadata },
  });

  const enriched = { ...event, serverName };
  broadcastAlert(enriched);
  notifyAlert(enriched).catch(() => {});
  triageEvent({ eventId: event.id, serverName, type, severity, description }).catch(() => {});

  return event;
}

module.exports = { createAndDispatchEvent };
