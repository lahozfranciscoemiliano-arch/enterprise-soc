// Mudanza del NOC a otra VPS: un ADMIN (con su PIN) programa la direccion
// nueva y cada agente (1.19.0+) la recibe con sus tareas. El agente NO se
// cambia a ciegas: primero comprueba desde su propia red que la direccion
// nueva es este NOC y que ya lo reconoce (misma base restaurada), y recien
// se muda cuando:
//   - la direccion actual y la nueva llegan al MISMO backend (puente Nginx o
//     DNS ya cambiado), o
//   - la VPS actual dejo de responder (corte) y la nueva lo reconoce.
// Mientras tanto informa en que estado esta (no llega, falta restaurar la
// base, lista...), y eso se ve en Admin -> Servidores antes del corte.
const crypto = require('crypto');
const prisma = require('../prismaClient');

const SETTING_KEY = 'AGENT_MOVE';
const MOVE_TTL_MS = 7 * 24 * 3600 * 1000;
const MIN_AGENT_VERSION = '1.19.0';

// Cambia en cada arranque del backend: dos direcciones que devuelven el mismo
// id llegan al mismo proceso. No identifica al equipo ni revela nada.
const INSTANCE_ID = crypto.randomUUID();

// Ultimo estado informado por cada agente (en memoria: se repone solo en
// menos de un minuto despues de un reinicio).
const reports = new Map();

let cached = null;
let cachedAt = 0;

/** "http://1.2.3.4:80/" -> "http://1.2.3.4". Solo origen http(s), sin usuario, ruta ni query. */
function normalizeUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? '').trim());
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(u.protocol)) return null;
  if (u.username || u.password || (u.pathname && u.pathname !== '/') || u.search || u.hash) return null;
  return `${u.protocol}//${u.host}`.toLowerCase();
}

function versionAtLeast(version, min) {
  const a = String(version ?? '').split('.').map(Number);
  const b = min.split('.').map(Number);
  if (a.some(Number.isNaN) || a.length < 2) return false;
  for (let i = 0; i < b.length; i += 1) {
    if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) > b[i];
  }
  return true;
}

async function getMove() {
  if (cached !== null && Date.now() - cachedAt < 15_000) return cached || null;
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  let move = null;
  try {
    move = row?.value ? JSON.parse(row.value) : null;
  } catch {
    move = null;
  }
  if (move && new Date(move.expiresAt) < new Date()) move = { ...move, expired: true };
  cached = move ?? false;
  cachedAt = Date.now();
  return move;
}

async function setMove({ url, user }) {
  const value = { url, setAt: new Date().toISOString(), setBy: user.name || user.email, setById: user.id, expiresAt: new Date(Date.now() + MOVE_TTL_MS).toISOString() };
  await prisma.setting.upsert({ where: { key: SETTING_KEY }, update: { value: JSON.stringify(value) }, create: { key: SETTING_KEY, value: JSON.stringify(value) } });
  cached = null;
  reports.clear();
  return value;
}

async function clearMove() {
  await prisma.setting.deleteMany({ where: { key: SETTING_KEY } });
  cached = null;
  reports.clear();
}

/** Lo que se agrega a la respuesta de /api/agent/tasks. */
async function planFor() {
  const move = await getMove();
  return { instanceId: INSTANCE_ID, move: move && !move.expired ? { url: move.url, expiresAt: move.expiresAt } : null };
}

const STATES = new Set(['unreachable', 'not-soc', 'unknown-agent', 'ready', 'error']);

function recordReport(server, body) {
  const b = body && typeof body === 'object' ? body : {};
  const move = b.move && typeof b.move === 'object' ? b.move : {};
  reports.set(server.id, {
    version: typeof b.version === 'string' ? b.version.slice(0, 20) : null,
    backendUrl: normalizeUrl(b.backendUrl),
    moveTo: normalizeUrl(move.to),
    state: STATES.has(move.state) ? move.state : null,
    detail: typeof move.detail === 'string' ? move.detail.slice(0, 300) : null,
    at: new Date().toISOString(),
  });
}

async function status() {
  const move = await getMove();
  const servers = await prisma.server.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, name: true, status: true, lastSeenAt: true, agentVersion: true, tags: true },
  });
  return {
    move,
    instanceId: INSTANCE_ID,
    minAgentVersion: MIN_AGENT_VERSION,
    agents: servers.map((s) => {
      const r = reports.get(s.id) ?? null;
      const hostMonitor = (s.tags ?? []).includes('infra-vps') || String(s.agentVersion ?? '').startsWith('host-');
      const version = r?.version ?? s.agentVersion;
      return {
        id: s.id,
        name: s.name,
        status: s.status,
        lastSeenAt: s.lastSeenAt,
        agentVersion: version,
        supported: versionAtLeast(version, MIN_AGENT_VERSION),
        // La propia VPS se muda con el stack (su monitor usa 127.0.0.1).
        hostMonitor,
        via: r?.backendUrl ?? null,
        moveTo: r?.moveTo ?? null,
        state: r?.state ?? null,
        detail: r?.detail ?? null,
        reportedAt: r?.at ?? null,
      };
    }),
  };
}

module.exports = { INSTANCE_ID, MIN_AGENT_VERSION, normalizeUrl, versionAtLeast, getMove, setMove, clearMove, planFor, recordReport, status };
