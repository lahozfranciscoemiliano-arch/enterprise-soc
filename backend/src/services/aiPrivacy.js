// Capa de privacidad de la IA: TODO lo que sale hacia Gemini (Google) pasa
// por aca (services/gemini.js -> callGemini). La IA recibe el problema tecnico
// (tipo de alerta, metricas, servicio, disco) pero nunca datos que
// identifiquen personas ni la infraestructura interna:
//
//   - Usuarios del Active Directory (sAMAccountName, nombre, email), nombres
//     de PCs del dominio, usuarios DOMINIO\usuario o usuario@dominio.
//   - Direcciones IP (internas y publicas), MACs, rutas de red \\servidor\share.
//   - Contactos de las sucursales (nombres y telefonos del CMDB).
//   - Contrasenas, tokens, API keys o cadenas largas que parezcan secretos.
//
// Cada dato se reemplaza por un marcador estable dentro de la misma consulta
// ([USUARIO-1], [IP-INTERNA-2]...), asi la IA puede razonar ("la misma IP se
// repite") sin conocer el valor. Cuando vuelve la respuesta, los marcadores
// se reemplazan por los valores reales localmente: quien lee el triage ve la
// IP o el usuario real, pero Google nunca lo recibio. Los secretos no se
// restauran nunca.
const prisma = require('../prismaClient');

const TERMS_TTL_MS = 10 * 60 * 1000;
const MIN_TERM_LENGTH = 4;
let termsCache = { at: 0, terms: [] };

// Tipos de alerta que tratan de identidades del AD: no se mandan a la IA en
// absoluto (se usan solo las recomendaciones internas).
const AI_EXCLUDED_EVENT_TYPES = new Set(['AD_ACCOUNT_LOCKOUT', 'PRIVILEGED_GROUP_CHANGE']);

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function loadSensitiveTerms() {
  if (Date.now() - termsCache.at < TERMS_TTL_MS) return termsCache.terms;
  try {
    const [users, endpoints, servers, logons] = await Promise.all([
      prisma.directoryUser.findMany({ select: { sam: true, displayName: true, email: true } }),
      prisma.endpoint.findMany({ select: { hostname: true, dnsName: true } }),
      prisma.server.findMany({ select: { name: true, hostname: true, siteContactName: true, siteContactPhone: true } }),
      prisma.logonEvent.findMany({ distinct: ['username'], select: { username: true }, take: 5000 }),
    ]);
    // Los nombres de los SERVIDORES monitoreados si se mandan: son el
    // contexto minimo para que el diagnostico sirva (y no identifican gente).
    const serverNames = new Set(servers.flatMap((s) => [s.name, s.hostname]).filter(Boolean).map((n) => n.toLowerCase()));
    const terms = [];
    const add = (value, kind) => {
      const v = String(value ?? '').trim();
      if (v.length < MIN_TERM_LENGTH || serverNames.has(v.toLowerCase())) return;
      terms.push({ value: v, kind });
    };
    for (const u of users) {
      add(u.sam, 'USUARIO');
      add(u.displayName, 'USUARIO');
      add(u.email, 'EMAIL');
    }
    for (const l of logons) add(l.username, 'USUARIO');
    for (const e of endpoints) {
      add(e.hostname, 'EQUIPO');
      add(e.dnsName, 'EQUIPO');
    }
    for (const s of servers) {
      add(s.siteContactName, 'CONTACTO');
      add(s.siteContactPhone, 'TELEFONO');
    }
    // Los mas largos primero ("Juan Perez" antes que "Juan").
    const unique = [...new Map(terms.map((t) => [t.value.toLowerCase(), t])).values()].sort((a, b) => b.value.length - a.value.length);
    termsCache = { at: Date.now(), terms: unique };
  } catch (err) {
    console.error('No se pudo cargar el diccionario de datos sensibles para la IA', err.message);
  }
  return termsCache.terms;
}

function invalidateSensitiveTerms() {
  termsCache = { at: 0, terms: [] };
}

const PRIVATE_IP = /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/;

// Orden importa: primero lo que nunca se restaura (secretos), despues los
// patrones, y al final el diccionario del AD/inventario.
const SECRET_PATTERNS = [
  // clave=valor / clave: valor
  /\b(password|passwd|pwd|contrase(?:ñ|n)a|clave|secret|secreto|token|api[_-]?key|apikey|authorization|bearer)\b(\s*[:=]\s*|\s+)("[^"]*"|'[^']*'|\S+)/gi,
  // cadenas de conexion
  /\b(Server|Data Source)=[^;]+;[^\n]*?(Password|Pwd)=[^;\n]+/gi,
];
const LONG_TOKEN = /\b(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{32,}={0,2}/g;

class Redactor {
  constructor(terms = []) {
    this.terms = terms;
    this.toToken = new Map(); // valor real (normalizado) -> marcador
    this.toValue = new Map(); // marcador -> valor real
    this.counters = {};
    this.termRegex = null;
    if (terms.length > 0) {
      // Un solo regex con todos los terminos (limite razonable).
      const body = terms.slice(0, 8000).map((t) => escapeRegex(t.value)).join('|');
      this.termRegex = new RegExp(`(?<![\\w\\-.])(${body})(?![\\w\\-])`, 'gi');
      this.kindOf = new Map(terms.map((t) => [t.value.toLowerCase(), t.kind]));
    }
  }

  token(kind, value) {
    const key = `${kind}:${value.toLowerCase()}`;
    if (this.toToken.has(key)) return this.toToken.get(key);
    this.counters[kind] = (this.counters[kind] ?? 0) + 1;
    const token = `[${kind}-${this.counters[kind]}]`;
    this.toToken.set(key, token);
    this.toValue.set(token, value);
    return token;
  }

  redact(input) {
    if (typeof input !== 'string' || !input) return input;
    let text = input;
    for (const re of SECRET_PATTERNS) {
      text = text.replace(re, (m, k, sep) => (sep !== undefined ? `${k}${/[:=]/.test(sep) ? '=' : ' '}[OCULTO]` : '[CADENA-DE-CONEXION-OCULTA]'));
    }
    // Los UUID (ids internos de alertas) no son secretos y se necesitan tal cual.
    text = text.replace(LONG_TOKEN, (m) => (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(m) ? m : '[TOKEN-OCULTO]'));
    text = text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, (m) => this.token('EMAIL', m));
    text = text.replace(/\\\\[A-Za-z0-9._$-]+(\\[^\s"'<>|,;]*)?/g, (m) => this.token('RUTA-RED', m));
    // DOMINIO\usuario (no rutas de disco "C:\Windows\System32")
    text = text.replace(/(?<![\\/:.\w])([A-Z][A-Z0-9-]{1,30})\\([A-Z0-9._$-]{2,64})\b/gi, (m) => this.token('USUARIO', m));
    text = text.replace(/\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\/\d{1,2})?\b/g, (m) =>
      this.token(PRIVATE_IP.test(m) ? 'IP-INTERNA' : 'IP-PUBLICA', m)
    );
    text = text.replace(/\b(?:[0-9A-F]{2}[:-]){5}[0-9A-F]{2}\b/gi, (m) => this.token('MAC', m));
    text = text.replace(/\+\d{1,3}[\s-]?\(?\d{1,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}\b/g, (m) => this.token('TELEFONO', m));
    if (this.termRegex) {
      text = text.replace(this.termRegex, (m) => (m.startsWith('[') ? m : this.token(this.kindOf.get(m.toLowerCase()) ?? 'DATO', m)));
    }
    return text;
  }

  restore(output) {
    if (typeof output !== 'string' || this.toValue.size === 0) return output;
    return output.replace(/\[(?:[A-Z]+(?:-[A-Z]+)*)-\d+\]/g, (m) => this.toValue.get(m) ?? m);
  }
}

async function createRedactor() {
  return new Redactor(await loadSensitiveTerms());
}

// Metadata de una alerta: solo numeros, booleanos y algunos campos tecnicos
// conocidos. Nada de nombres de usuario, IPs o textos libres.
const SAFE_META_KEYS = new Set(['field', 'value', 'volume', 'mount', 'service', 'method', 'percent', 'threshold', 'lossPct', 'latencyMs', 'diskBadBlocks', 'diskErrors', 'failedLogons', 'unexpectedShutdowns', 'bugchecks', 'lowMemory', 'malwareDetections', 'patchAgeDays', 'pending', 'pendingCritical', 'daysToFull', 'freeBytes', 'occurrences']);
function safeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (!SAFE_META_KEYS.has(k)) continue;
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && v.length <= 60) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

module.exports = { Redactor, createRedactor, safeMetadata, invalidateSensitiveTerms, AI_EXCLUDED_EVENT_TYPES };
