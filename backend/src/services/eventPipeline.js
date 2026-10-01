// Punto unico de creacion de SecurityEvent: centraliza lo que antes estaba
// repetido en cada lugar que dispara una alerta (telemetria, backups,
// heartbeat, anomalias, synthetic monitoring, chequeos preventivos). Crea el
// evento, lo transmite por WebSocket, dispara la notificacion externa
// (email/Slack/webhook/Telegram), y pide un triage a Gemini en segundo plano.
//
// Deduplicacion (estilo NOC): cada alerta tiene una dedupKey (por defecto
// "TIPO" o "TIPO:campo"). Mientras exista una alerta ABIERTA o RECONOCIDA
// para el mismo servidor + dedupKey, una nueva deteccion de la misma
// condicion NO crea otra alerta ni vuelve a notificar: actualiza la
// existente (occurrences + 1, lastSeenAt, descripcion con el valor actual).
// Solo se re-notifica si la severidad empeora. Cuando la condicion se
// normaliza, quien la detecto llama a autoResolveEvents() y la alerta se
// cierra sola. Si reaparece al rato (una metrica que oscila justo en el
// umbral), se reabre la misma alerta en vez de crear una nueva.
const prisma = require('../prismaClient');
const { broadcast, broadcastAlert, broadcastAlertUpdate } = require('../websocket/socketServer');
const { notifyAlert } = require('./notifications');
const { triageEvent } = require('./gemini');
const { getRecommendation } = require('./recommendations');

// Confirmacion (anti-fatiga): condiciones que suelen ser picos pasajeros
// (CPU/RAM, anomalias, red degradada, impresoras) solo generan alerta si se
// detectan en N chequeos seguidos. serverId|dedupKey -> detecciones seguidas.
const pendingConfirmations = new Map();

const SEVERITY_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
const ACTIVE_STATUSES = ['OPEN', 'ACKNOWLEDGED'];
// Una alerta auto-resuelta que vuelve a dispararse dentro de esta ventana se
// reabre (sin notificar de nuevo) en vez de crear una alerta nueva.
const REOPEN_WINDOW_MS = 30 * 60 * 1000;

function defaultDedupKey(type, metadata) {
  return metadata?.field ? `${type}:${metadata.field}` : type;
}

// Forma que consume el frontend (misma que GET /api/events).
function toClientEvent(event, serverName) {
  return {
    id: event.id,
    type: event.type,
    severity: event.severity,
    status: event.status,
    description: event.description,
    serverId: event.serverId,
    serverName: serverName ?? event.server?.name,
    acknowledgedByName: event.acknowledgedBy?.name ?? null,
    aiTriage: event.aiTriage,
    occurrences: event.occurrences,
    lastSeenAt: event.lastSeenAt,
    autoResolved: event.autoResolved,
    snoozedUntil: event.snoozedUntil ?? null,
    silent: event.silent ?? false,
    recommendation: getRecommendation(event.type),
    // Detalle estructurado para mostrar en la alerta (origen de los intentos
    // de inicio de sesion fallidos).
    details: event.type === 'LOGIN_FAILURE' ? event.metadata?.failedLogonDetail ?? null : null,
    createdAt: event.createdAt,
    resolvedAt: event.resolvedAt,
  };
}

function isSnoozed(event) {
  // Las alertas silenciosas se comportan como silenciadas para siempre.
  if (event?.silent) return true;
  return Boolean(event?.snoozedUntil && new Date(event.snoozedUntil) > new Date());
}

// silent: la alerta se registra y se ve en el NOC (WebSocket, listados) pero
// NUNCA se notifica por email/Slack/Telegram, ni al crearse ni si empeora.
async function createAndDispatchEvent({ serverId, serverName, type, severity, description, metadata, dedupKey, confirmations = 1, silent = false }) {
  const key = dedupKey ?? defaultDedupKey(type, metadata);
  const now = new Date();

  const active = await prisma.securityEvent.findFirst({
    where: { serverId, dedupKey: key, status: { in: ACTIVE_STATUSES } },
    orderBy: { createdAt: 'desc' },
  });

  // Una alerta nueva de una condicion "ruidosa" espera a confirmarse.
  if (!active && confirmations > 1) {
    const pendingKey = `${serverId}|${key}`;
    const seen = (pendingConfirmations.get(pendingKey) ?? 0) + 1;
    if (seen < confirmations) {
      pendingConfirmations.set(pendingKey, seen);
      return { event: null, isNew: false, escalated: false, pending: true };
    }
    pendingConfirmations.delete(pendingKey);
  }

  if (active) {
    const escalated = (SEVERITY_RANK[severity] ?? 0) > (SEVERITY_RANK[active.severity] ?? 0);
    const updated = await prisma.securityEvent.update({
      where: { id: active.id },
      data: {
        occurrences: { increment: 1 },
        lastSeenAt: now,
        description,
        metadata,
        // La severidad solo sube mientras la alerta esta abierta (un CPU que
        // baja de 96% a 91% sigue siendo el mismo incidente CRITICAL).
        ...(escalated ? { severity, status: 'OPEN' } : {}),
      },
      include: { acknowledgedBy: { select: { name: true } } },
    });
    const enriched = toClientEvent(updated, serverName);
    broadcastAlertUpdate(enriched);
    if (escalated && !isSnoozed(updated)) notifyAlert({ ...enriched, description: `Empeoró: ${description}` }).catch(() => {});
    return { event: updated, isNew: false, escalated };
  }

  const recentlyResolved = await prisma.securityEvent.findFirst({
    where: {
      serverId,
      dedupKey: key,
      status: 'RESOLVED',
      autoResolved: true,
      resolvedAt: { gte: new Date(now.getTime() - REOPEN_WINDOW_MS) },
    },
    orderBy: { resolvedAt: 'desc' },
  });

  if (recentlyResolved) {
    const escalated = (SEVERITY_RANK[severity] ?? 0) > (SEVERITY_RANK[recentlyResolved.severity] ?? 0);
    const reopened = await prisma.securityEvent.update({
      where: { id: recentlyResolved.id },
      data: {
        status: 'OPEN',
        resolvedAt: null,
        autoResolved: false,
        acknowledgedById: null,
        occurrences: { increment: 1 },
        lastSeenAt: now,
        description,
        metadata,
        ...(escalated ? { severity } : {}),
      },
    });
    const enriched = toClientEvent(reopened, serverName);
    broadcastAlertUpdate(enriched);
    if (escalated && !isSnoozed(reopened)) notifyAlert(enriched).catch(() => {});
    return { event: reopened, isNew: false, escalated };
  }

  const event = await prisma.securityEvent.create({
    data: { serverId, type, severity, description, metadata, dedupKey: key, lastSeenAt: now, silent },
  });

  const enriched = toClientEvent(event, serverName);
  broadcastAlert(enriched);
  if (!silent) notifyAlert(enriched).catch(() => {});
  triageEvent({ eventId: event.id, serverName, type, severity, description }).catch(() => {});

  return { event, isNew: true, escalated: false };
}

// Cierra las alertas activas del servidor cuya dedupKey este en `keys` (la
// condicion ya se normalizo). Pensado para llamarse en cada chequeo con la
// lista de condiciones que ESE chequeo controla y que ahora estan bien -- es
// barato: una sola query cuando no hay nada abierto.
async function autoResolveEvents(serverId, keys, serverName) {
  if (!keys || keys.length === 0) return 0;
  // La condicion se normalizo: se descartan las confirmaciones a medias.
  for (const k of keys) pendingConfirmations.delete(`${serverId}|${k}`);

  const open = await prisma.securityEvent.findMany({
    where: { serverId, dedupKey: { in: keys }, status: { in: ACTIVE_STATUSES } },
    include: { acknowledgedBy: { select: { name: true } } },
  });
  if (open.length === 0) return 0;

  const resolvedAt = new Date();
  await prisma.securityEvent.updateMany({
    where: { id: { in: open.map((e) => e.id) } },
    data: { status: 'RESOLVED', resolvedAt, autoResolved: true },
  });

  for (const e of open) {
    broadcastAlertUpdate(toClientEvent({ ...e, status: 'RESOLVED', resolvedAt, autoResolved: true }, serverName));
  }
  // Tickets abiertos de esas alertas: queda anotado que se normalizo sola.
  const tickets = await prisma.ticket.findMany({
    where: { eventId: { in: open.map((e) => e.id) }, status: { in: ['OPEN', 'IN_PROGRESS', 'WAITING'] } },
    select: { id: true },
  });
  if (tickets.length) {
    await prisma.ticketComment.createMany({
      data: tickets.map((t) => ({ ticketId: t.id, userName: 'Sistema', kind: 'system', body: 'La alerta vinculada se normalizó sola (el NOC dejó de detectar la condición). Revisar si se puede cerrar el ticket.' })),
    });
    broadcast({ type: 'TICKET_UPDATE', ticket: { id: tickets[0].id } });
  }
  return open.length;
}

// Resuelve todas las condiciones de `managedKeys` que NO esten en
// `activeKeys` -- el patron comun de cada chequeo periodico.
function resolveCleared(serverId, managedKeys, activeKeys, serverName) {
  const active = new Set(activeKeys);
  return autoResolveEvents(
    serverId,
    managedKeys.filter((k) => !active.has(k)),
    serverName
  );
}

module.exports = { createAndDispatchEvent, autoResolveEvents, resolveCleared, defaultDedupKey, toClientEvent };
