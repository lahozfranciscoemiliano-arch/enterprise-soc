// Inventario de red: procesa lo que manda el agente del servidor con AD/DHCP
// (BSFS2) cada ~5 minutos -- POST /api/inventory -- y lo convierte en:
//   - equipos (PC/laptop) con su IP, MAC, si esta encendido y el ultimo
//     usuario del AD que inicio sesion,
//   - usuarios del AD (bloqueados, contraseña por vencer, inactivos),
//   - impresoras (estado, errores, toner, contador),
//   - mapa de IPs por ambito (libres, concedidas, reservadas, fijas),
//   - auditoria del directorio (bloqueos, cambios de grupos, altas/bajas),
// y en alertas preventivas (ambito DHCP por agotarse, conflicto de IP,
// impresora con problemas, cuenta bloqueada, fuerza bruta, alguien agregado
// a un grupo privilegiado).
const prisma = require('../prismaClient');
const { Prisma } = require('@prisma/client');
const { getSetting, setSettings } = require('./settings');
const { createAndDispatchEvent, resolveCleared } = require('./eventPipeline');
const { broadcast } = require('../websocket/socketServer');
const netGuard = require('./netGuard');

const PRIVILEGED_GROUPS = [
  'domain admins',
  'enterprise admins',
  'schema admins',
  'administrators',
  'administradores',
  'admins. del dominio',
  'admins. de empresas',
  'administradores de esquema',
  'account operators',
  'opers. de cuentas',
  'backup operators',
  'opers. de copia de seguridad',
  'server operators',
  'opers. de servidores',
  'dnsadmins',
  'group policy creator owners',
];
const SCOPE_HIGH_PCT = 85;
const SCOPE_CRITICAL_PCT = 95;
const FAILED_AUTH_THRESHOLD = 15; // fallos de un mismo usuario en un ciclo (~5 min)
const PRINTER_OFFLINE_GRACE_MS = 30 * 60 * 1000;
const PRINTER_BLOCKING_ERRORS = ['noPaper', 'noToner', 'doorOpen', 'jammed', 'offline', 'serviceRequested', 'markerSupplyMissing', 'inputTrayEmpty', 'outputFull'];
const PRINTER_WARNING_ERRORS = ['lowPaper', 'lowToner', 'outputNearFull', 'overduePreventMaint'];
const SUPPLY_LOW_PCT = 10;
const PRINTER_FORGET_MS = 3 * 86400000;
const ACTIVE_SESSION_MS = 12 * 3600000; // un TGT de Kerberos dura 10 h
const RECENT_ACTIVITY_MS = 15 * 60000;
let lastIpHost = new Map();

const PRINTER_ERROR_LABEL = {
  lowPaper: 'poco papel',
  noPaper: 'sin papel',
  lowToner: 'tóner bajo',
  noToner: 'sin tóner',
  doorOpen: 'tapa abierta',
  jammed: 'papel atascado',
  offline: 'fuera de línea',
  serviceRequested: 'requiere servicio técnico',
  inputTrayMissing: 'falta bandeja de entrada',
  outputTrayMissing: 'falta bandeja de salida',
  markerSupplyMissing: 'falta cartucho/tóner',
  outputNearFull: 'bandeja de salida casi llena',
  outputFull: 'bandeja de salida llena',
  inputTrayEmpty: 'bandeja de entrada vacía',
  overduePreventMaint: 'mantenimiento preventivo vencido',
};

// --- Utilidades de IP ------------------------------------------------------
function ipToInt(ip) {
  const p = String(ip).split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

function intToIp(n) {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function maskToPrefix(mask) {
  const n = ipToInt(mask);
  if (n === null) return null;
  return n.toString(2).replace(/0+$/, '').length;
}

// Hosts utilizables de una subred (sin red ni broadcast).
function subnetHosts(networkIp, prefix) {
  const base = ipToInt(networkIp);
  if (base === null || prefix === null || prefix < 16 || prefix > 30) return [];
  const size = 2 ** (32 - prefix);
  const net = (base & (~(size - 1) >>> 0)) >>> 0;
  const hosts = [];
  for (let i = 1; i < size - 1; i += 1) hosts.push(net + i);
  return hosts;
}

function shortHost(name) {
  if (!name) return null;
  return String(name).split('.')[0].trim().toUpperCase() || null;
}

function normalizeMac(mac) {
  if (!mac) return null;
  const hex = String(mac).toLowerCase().replace(/[^0-9a-f]/g, '');
  return hex.length === 12 ? hex.match(/../g).join(':') : null;
}

// Rangos consecutivos: [.100,.101,.102,.110] -> ".100-.102, .110"
function compressRanges(ips) {
  const nums = ips.map(ipToInt).filter((n) => n !== null).sort((a, b) => a - b);
  const out = [];
  let start = null;
  let prev = null;
  for (const n of nums) {
    if (start === null) {
      start = n;
    } else if (n !== prev + 1) {
      out.push(start === prev ? intToIp(start) : `${intToIp(start)} - ${intToIp(prev)}`);
      start = n;
    }
    prev = n;
  }
  if (start !== null) out.push(start === prev ? intToIp(start) : `${intToIp(start)} - ${intToIp(prev)}`);
  return out;
}

// --- Mapa de IPs ---------------------------------------------------------
// Estado de cada IP de la subred:
//   lease      concedida por DHCP a un equipo
//   reserved   reserva DHCP
//   static     responde en la red pero el DHCP no la entrego (IP fija)
//   conflict   el DHCP la marco "Declined" (otro equipo ya la usaba)
//   free       libre dentro del rango que reparte el DHCP
//   free-static libre FUERA del rango DHCP / en una exclusion: sirve para
//              asignar una IP fija nueva (impresora, reloj, camara...)
function buildAddressMap(scope, alive, hostUsers) {
  const prefix = maskToPrefix(scope.mask);
  const hosts = subnetHosts(scope.scopeId, prefix);
  const start = ipToInt(scope.start);
  const end = ipToInt(scope.end);
  const exclusions = (scope.exclusions ?? []).map((e) => [ipToInt(e.start), ipToInt(e.end)]);
  const leases = new Map();
  for (const l of scope.leases ?? []) leases.set(l.ip, l);
  const reservations = new Map();
  for (const r of scope.reservations ?? []) reservations.set(r.ip, r);

  return hosts.map((n) => {
    const ip = intToIp(n);
    const lease = leases.get(ip);
    const reservation = reservations.get(ip);
    const live = alive[ip];
    const inRange = n >= start && n <= end;
    const excluded = exclusions.some(([a, b]) => n >= a && n <= b);
    const leaseState = String(lease?.state ?? '');
    const host = shortHost(lease?.host) ?? reservation?.name ?? null;

    let status;
    if (leaseState === 'Declined') status = 'conflict';
    else if (reservation) status = 'reserved';
    else if (lease && leaseState.startsWith('Active')) status = 'lease';
    else if (live) status = 'static';
    else if (inRange && !excluded) status = 'free';
    else status = 'free-static';

    const entry = { ip, s: status };
    if (host) entry.h = host;
    const mac = normalizeMac(lease?.mac ?? reservation?.mac ?? live?.mac);
    if (mac) entry.m = mac;
    if (live) entry.a = 1;
    if (host && hostUsers.get(host)) entry.u = hostUsers.get(host);
    if (lease?.expires) entry.e = lease.expires;
    return entry;
  });
}

function countStatuses(addresses) {
  const counts = { lease: 0, reserved: 0, static: 0, conflict: 0, free: 0, 'free-static': 0, alive: 0 };
  for (const a of addresses) {
    counts[a.s] += 1;
    if (a.a) counts.alive += 1;
  }
  return counts;
}

// --- Sesiones del dominio ----------------------------------------------------
async function lastUserByHost() {
  return prisma.$queryRaw`
    SELECT DISTINCT ON (hostname) hostname, username, at
    FROM logon_events
    WHERE hostname IS NOT NULL AND at >= NOW() - INTERVAL '30 days'
    ORDER BY hostname, at DESC
  `;
}

async function recentActivityIps() {
  const rows = await prisma.$queryRaw`
    SELECT DISTINCT "ipAddress" FROM logon_events WHERE at >= ${new Date(Date.now() - RECENT_ACTIVITY_MS)}
  `;
  return new Set(rows.map((r) => r.ipAddress));
}

// IP -> equipo: DHCP (ultimo inventario) o la IP registrada del equipo.
async function hostForIps(ips) {
  const out = new Map();
  for (const ip of ips) if (lastIpHost.has(ip)) out.set(ip, lastIpHost.get(ip));
  const missing = ips.filter((ip) => !out.has(ip));
  if (missing.length) {
    const eps = await prisma.endpoint.findMany({ where: { ipAddress: { in: missing } }, select: { hostname: true, ipAddress: true } });
    for (const e of eps) out.set(e.ipAddress, e.hostname);
  }
  return out;
}

// Inicios de sesion y actividad que mandan los controladores de dominio
// cada minuto: se guardan y se actualiza al instante el usuario y el estado
// "encendido" de cada equipo.
async function ingestLogons(logons, { refreshEndpoints = true } = {}) {
  const valid = logons.filter((l) => l.user && l.ip && l.at && !Number.isNaN(new Date(l.at).getTime()));
  if (valid.length === 0) return { stored: 0, endpoints: 0 };
  const ipHosts = await hostForIps([...new Set(valid.map((l) => l.ip))]);
  const rows = valid.map((l) => ({
    username: String(l.user).toLowerCase(),
    ipAddress: l.ip,
    hostname: ipHosts.get(l.ip) ?? null,
    kind: l.kind === 'activity' ? 'activity' : 'logon',
    at: new Date(l.at),
  }));
  const { count } = await prisma.logonEvent.createMany({ data: rows, skipDuplicates: true });
  if (!refreshEndpoints) return { stored: count, endpoints: 0 };

  // Ultimo usuario de cada equipo afectado.
  const latest = new Map();
  for (const r of rows) {
    if (!r.hostname) continue;
    const cur = latest.get(r.hostname);
    if (!cur || r.at > cur.at) latest.set(r.hostname, r);
  }
  let updated = 0;
  const now = new Date();
  for (const [hostname, r] of latest) {
    // eslint-disable-next-line no-await-in-loop
    const ep = await prisma.endpoint.findUnique({ where: { hostname } });
    if (!ep) continue;
    const data = {};
    if (!ep.lastUserAt || r.at >= ep.lastUserAt) {
      data.lastUser = r.username;
      data.lastUserAt = r.at;
    }
    if (now - r.at < RECENT_ACTIVITY_MS) {
      if (!ep.online) {
        data.online = true;
        data.statusChangedAt = now;
      }
      data.lastSeenOnlineAt = now;
      if (ep.ipAddress !== r.ipAddress) data.ipAddress = r.ipAddress;
    }
    if (Object.keys(data).length === 0) continue;
    // eslint-disable-next-line no-await-in-loop
    await prisma.endpoint.update({ where: { hostname }, data });
    updated += 1;
  }
  if (updated > 0) broadcast({ type: 'INVENTORY_UPDATE', at: now.toISOString(), partial: 'logons' });
  return { stored: count, endpoints: updated };
}

// Sesion activa probable: equipo encendido y su ultimo usuario inicio o uso
// la sesion hace menos de 12 h.
function activeSessionOf(e) {
  if (!e.online || !e.lastUser || !e.lastUserAt) return null;
  return Date.now() - new Date(e.lastUserAt).getTime() < ACTIVE_SESSION_MS ? e.lastUser : null;
}

// --- Procesamiento principal -------------------------------------------------
async function processInventory(server, payload) {
  const now = new Date();
  const roles = payload.roles ?? {};
  const alive = payload.sweep?.alive ?? {};
  const scopes = Array.isArray(payload.scopes) ? payload.scopes : [];
  const computers = Array.isArray(payload.computers) ? payload.computers : [];
  const users = Array.isArray(payload.users) ? payload.users : [];
  const logons = Array.isArray(payload.logons) ? payload.logons : [];
  const directoryEvents = Array.isArray(payload.directoryEvents) ? payload.directoryEvents : [];
  const printers = Array.isArray(payload.printers) ? payload.printers : [];

  // IP -> nombre de equipo, segun el DHCP (concesiones y reservas).
  const ipHost = new Map();
  const hostLease = new Map(); // HOST -> { ip, mac }
  for (const scope of scopes) {
    for (const r of scope.reservations ?? []) if (r.name) ipHost.set(r.ip, shortHost(r.name));
    for (const l of scope.leases ?? []) {
      const h = shortHost(l.host);
      if (!h || !String(l.state ?? '').startsWith('Active')) continue;
      ipHost.set(l.ip, h);
      hostLease.set(h, { ip: l.ip, mac: normalizeMac(l.mac) });
    }
  }

  // Nombres por DNS inverso de IPs activas sin concesion DHCP.
  for (const [ip, name] of Object.entries(payload.reverseNames ?? {})) {
    const h = shortHost(name);
    if (h && !ipHost.has(ip)) ipHost.set(ip, h);
  }
  // IP por DNS del dominio (equipos con IP fija o que el DHCP no registra).
  for (const c of computers) {
    const h = shortHost(c.name);
    if (h && c.ip && !hostLease.has(h) && (ipHost.get(c.ip) ?? h) === h) {
      ipHost.set(c.ip, h);
      hostLease.set(h, { ip: c.ip, mac: normalizeMac(alive[c.ip]?.mac) });
    }
  }
  lastIpHost = ipHost;

  // 1. Inicios de sesion (agentes viejos los mandan en el inventario).
  if (logons.length > 0) await ingestLogons(logons, { refreshEndpoints: false });

  // Ultimo usuario por equipo y actividad reciente por IP.
  const lastByHost = await lastUserByHost();
  const hostUsers = new Map(lastByHost.map((r) => [r.hostname, r.username]));
  const hostUserAt = new Map(lastByHost.map((r) => [r.hostname, r.at]));
  const recentIps = await recentActivityIps();

  // 2. Equipos del AD.
  if (computers.length > 0) {
    const seen = [];
    for (const c of computers) {
      const hostname = shortHost(c.name);
      if (!hostname) continue;
      seen.push(hostname);
      const lease = hostLease.get(hostname);
      const ip = lease?.ip ?? null;
      // Encendido: responde en el barrido (ping/puertos/ARP) o tuvo actividad
      // de sesion en el dominio en los ultimos minutos.
      const online = Boolean(ip && (alive[ip] || recentIps.has(ip)));
      // eslint-disable-next-line no-await-in-loop
      const prev = await prisma.endpoint.findUnique({ where: { hostname } });
      const data = {
        dnsName: c.dns ?? null,
        os: c.os ?? null,
        osVersion: c.osVersion ?? null,
        enabled: c.enabled ?? null,
        description: c.description ?? null,
        ou: c.ou ?? null,
        inAd: true,
        adLastLogonAt: c.lastLogon ? new Date(c.lastLogon) : null,
        createdInAdAt: c.created ? new Date(c.created) : null,
        ipAddress: ip ?? prev?.ipAddress ?? null,
        macAddress: lease?.mac ?? normalizeMac(alive[ip]?.mac) ?? prev?.macAddress ?? null,
        online,
        lastSeenOnlineAt: online ? now : prev?.lastSeenOnlineAt ?? null,
        statusChangedAt: !prev || prev.online !== online ? now : prev.statusChangedAt,
        lastUser: hostUsers.get(hostname) ?? prev?.lastUser ?? null,
        lastUserAt: hostUserAt.get(hostname) ?? prev?.lastUserAt ?? null,
      };
      // eslint-disable-next-line no-await-in-loop
      await prisma.endpoint.upsert({ where: { hostname }, create: { hostname, ...data }, update: data });
    }
    // Equipos que ya no estan en el AD (dados de baja).
    await prisma.endpoint.deleteMany({ where: { inAd: true, hostname: { notIn: seen } } });
  }

  // 3. Usuarios del AD.
  if (users.length > 0) {
    const sams = [];
    for (const u of users) {
      if (!u.sam) continue;
      const sam = String(u.sam).toLowerCase();
      sams.push(sam);
      const data = {
        displayName: u.displayName ?? null,
        department: u.department ?? null,
        title: u.title ?? null,
        email: u.email ?? null,
        enabled: Boolean(u.enabled),
        lockedOut: Boolean(u.lockedOut),
        neverExpires: Boolean(u.neverExpires),
        passwordLastSet: u.passwordLastSet ? new Date(u.passwordLastSet) : null,
        passwordExpiresAt: u.passwordExpiresAt ? new Date(u.passwordExpiresAt) : null,
        lastLogonAt: u.lastLogon ? new Date(u.lastLogon) : null,
      };
      // eslint-disable-next-line no-await-in-loop
      await prisma.directoryUser.upsert({ where: { sam }, create: { sam, ...data }, update: data });
    }
    await prisma.directoryUser.deleteMany({ where: { sam: { notIn: sams } } });
  }

  // 4. Auditoria del directorio.
  if (directoryEvents.length > 0) {
    await prisma.directoryEvent.createMany({
      data: directoryEvents
        .filter((e) => e.at && e.eventId)
        .map((e) => ({
          eventId: e.eventId,
          kind: e.kind,
          target: e.target ?? null,
          actor: e.actor ?? null,
          group: e.group ?? null,
          callerHost: e.callerHost ?? null,
          at: new Date(e.at),
        })),
      skipDuplicates: true,
    });
  }

  // 5. Impresoras. Se identifican por MAC (o numero de serie): si una
  // impresora cambio de IP, la entrada de la IP vieja se borra en vez de
  // quedar duplicada y "sin respuesta".
  const seenPrinters = new Set();
  const existingPrinters = await prisma.printer.findMany();
  const removedPrinters = new Set();
  for (const p of printers) {
    if (!p.ip) continue;
    seenPrinters.add(p.ip);
    const mac = normalizeMac(p.mac ?? alive[p.ip]?.mac);
    const online = Boolean(p.printerStatus) || Boolean(alive[p.ip]) || Boolean(p.reachable);
    const prev = existingPrinters.find((x) => x.id === p.ip);
    if (online && (mac || p.serial)) {
      const moved = existingPrinters.filter(
        (x) => x.id !== p.ip && !removedPrinters.has(x.id) && ((mac && x.macAddress === mac) || (p.serial && x.serial && x.serial === p.serial))
      );
      for (const old of moved) {
        removedPrinters.add(old.id);
        // eslint-disable-next-line no-await-in-loop
        await prisma.printer.delete({ where: { id: old.id } }).catch(() => {});
        // eslint-disable-next-line no-await-in-loop
        await resolveCleared(server.id, [`PRINTER:${old.id}`], [], server.name);
        console.log(`Inventario: impresora ${old.name ?? old.id} cambió de IP ${old.id} -> ${p.ip}; se borra la entrada vieja`);
      }
    }
    // La IP ahora la usa OTRO equipo (otra MAC): la impresora vieja ya no esta ahi.
    if (prev && prev.macAddress && mac && prev.macAddress !== mac && !p.printerStatus) {
      removedPrinters.add(prev.id);
      // eslint-disable-next-line no-await-in-loop
      await prisma.printer.delete({ where: { id: prev.id } }).catch(() => {});
      continue;
    }
    const data = {
      macAddress: mac ?? prev?.macAddress ?? null,
      name: p.queues?.[0]?.name ?? p.sysName ?? prev?.name ?? null,
      model: p.model ?? prev?.model ?? null,
      serial: p.serial ?? prev?.serial ?? null,
      location: p.location ?? prev?.location ?? null,
      status: p.printerStatus ?? (online ? 'unknown' : 'offline'),
      deviceStatus: p.deviceStatus ?? null,
      errors: Array.isArray(p.errors) ? p.errors : [],
      supplies: Array.isArray(p.supplies) && p.supplies.length > 0 ? p.supplies : prev?.supplies ?? null,
      pageCount: p.pageCount ?? prev?.pageCount ?? null,
      queues: p.queues ?? null,
      snmp: p.snmp !== false,
      online,
      lastSeenOnlineAt: online ? now : prev?.lastSeenOnlineAt ?? null,
      statusChangedAt: !prev || prev.online !== online ? now : prev.statusChangedAt,
    };
    // eslint-disable-next-line no-await-in-loop
    await prisma.printer.upsert({ where: { id: p.ip }, create: { id: p.ip, ...data }, update: data });
  }
  // Impresoras conocidas que esta vez no respondieron.
  const missing = await prisma.printer.findMany({ where: { id: { notIn: [...seenPrinters] }, online: true } });
  for (const p of missing) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.printer.update({ where: { id: p.id }, data: { online: false, status: 'offline', statusChangedAt: now } });
  }
  // Sin responder hace mas de 3 dias y sin ninguna cola que la use: fue dada
  // de baja o cambio de IP sin poder identificarla. Se quita del inventario.
  const gone = await prisma.printer.deleteMany({
    where: { online: false, id: { notIn: [...seenPrinters] }, statusChangedAt: { lt: new Date(Date.now() - PRINTER_FORGET_MS) } },
  });
  if (gone.count > 0) console.log(`Inventario: ${gone.count} impresora(s) sin respuesta hace mas de 3 dias quitadas`);

  // 6. Mapa de IPs por ambito (+ subredes fijas sin DHCP).
  const scopeRows = [];
  for (const scope of scopes) {
    const addresses = buildAddressMap(scope, alive, hostUsers);
    scopeRows.push({
      id: scope.scopeId,
      name: scope.name ?? null,
      mask: scope.mask,
      startRange: scope.start,
      endRange: scope.end,
      state: scope.state ?? null,
      leaseHours: scope.leaseHours ?? null,
      inUse: scope.inUse ?? 0,
      free: scope.free ?? 0,
      reserved: scope.reserved ?? 0,
      percentInUse: scope.percentInUse ?? 0,
      addresses,
      serverId: server.id,
    });
  }
  for (const subnet of payload.extraSubnets ?? []) {
    const [net, bits] = String(subnet).split('/');
    const prefix = Number(bits);
    const hosts = subnetHosts(net, prefix);
    if (hosts.length === 0 || scopeRows.some((r) => r.id === intToIp(hosts[0] - 1))) continue;
    const mask = intToIp((0xffffffff << (32 - prefix)) >>> 0);
    const pseudo = { scopeId: intToIp(hosts[0] - 1), mask, start: '0.0.0.0', end: '0.0.0.0' };
    const addresses = buildAddressMap(pseudo, alive, hostUsers);
    const used = addresses.filter((a) => a.a).length;
    scopeRows.push({
      id: pseudo.scopeId,
      name: `Subred sin DHCP (${subnet})`,
      mask,
      startRange: intToIp(hosts[0]),
      endRange: intToIp(hosts[hosts.length - 1]),
      state: 'Static',
      leaseHours: null,
      inUse: used,
      free: addresses.length - used,
      reserved: 0,
      percentInUse: Math.round((used / addresses.length) * 1000) / 10,
      addresses,
      serverId: server.id,
    });
  }
  for (const row of scopeRows) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.dhcpScope.upsert({ where: { id: row.id }, create: row, update: row });
  }
  if (roles.dhcp && scopes.length > 0) {
    await prisma.dhcpScope.deleteMany({ where: { serverId: server.id, id: { notIn: scopeRows.map((r) => r.id) } } });
  }

  // 7. Estado del inventario en el servidor que lo reporta.
  const summary = {
    collectedAt: payload.collectedAt ?? now.toISOString(),
    hostname: payload.hostname ?? null,
    roles,
    errors: payload.errors ?? [],
    durationSeconds: payload.durationSeconds ?? null,
    scanned: payload.sweep?.scanned ?? 0,
    alive: Object.keys(alive).length,
    scopes: scopeRows.length,
    computers: computers.length,
    users: users.length,
    printers: printers.length,
  };
  await prisma.server.update({ where: { id: server.id }, data: { inventoryAt: now, inventorySummary: summary } });

  // Guardian de red: MACs nunca vistas (DHCP + barrido).
  const seenDevices = [];
  for (const scope of scopes) {
    for (const l of scope.leases ?? []) {
      if (String(l.state ?? '').startsWith('Active')) seenDevices.push({ mac: l.mac, ip: l.ip, hostname: shortHost(l.host), source: 'dhcp' });
    }
  }
  const leaseMacByIp = new Map(seenDevices.map((d) => [d.ip, normalizeMac(d.mac)]));
  for (const [ip, a] of Object.entries(alive)) {
    if (!a?.mac) continue;
    // El nombre de la concesion solo vale si es la misma MAC (si no, es otro equipo usando esa IP).
    const sameAsLease = !leaseMacByIp.has(ip) || leaseMacByIp.get(ip) === normalizeMac(a.mac);
    seenDevices.push({ mac: a.mac, ip, hostname: sameAsLease ? ipHost.get(ip) ?? null : null, source: 'arp' });
  }
  try {
    await netGuard.observeDevices(server, seenDevices);
  } catch (err) {
    console.error('Guardian de red: error registrando equipos', err.message);
  }

  await evaluateInventoryAlerts(server, { roles, scopes, scopeRows, users, directoryEvents, failedAuth: payload.failedAuth ?? [], ipHost, alive });

  broadcast({ type: 'INVENTORY_UPDATE', at: now.toISOString(), serverId: server.id });
  return summary;
}

// --- Alertas -----------------------------------------------------------------
async function evaluateInventoryAlerts(server, ctx) {
  const alerts = [];
  const managed = [];
  const base = { serverId: server.id, serverName: server.name };

  // Ambitos DHCP por agotarse.
  for (const scope of ctx.scopes) {
    const key = `DHCP_SCOPE:${scope.scopeId}`;
    managed.push(key);
    const pct = Number(scope.percentInUse ?? 0);
    if (pct >= SCOPE_HIGH_PCT || (scope.free === 0 && scope.inUse > 0)) {
      alerts.push({
        type: 'DHCP_SCOPE_EXHAUSTED',
        severity: pct >= SCOPE_CRITICAL_PCT || scope.free === 0 ? 'CRITICAL' : 'HIGH',
        description: `Ámbito DHCP ${scope.name ?? scope.scopeId} (${scope.scopeId}) al ${pct}% — quedan ${scope.free} IP(s) libres. Cuando se agote, los equipos nuevos se quedan sin red: ampliar el rango, bajar la duración de la concesión o liberar reservas.`,
        metadata: { scopeId: scope.scopeId, percentInUse: pct, free: scope.free },
        dedupKey: key,
      });
    }
  }

  // Conflictos de IP (concesiones "Declined").
  const openConflicts = await prisma.securityEvent.findMany({
    where: { serverId: server.id, type: 'IP_CONFLICT', status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
    select: { dedupKey: true },
  });
  managed.push(...openConflicts.map((e) => e.dedupKey));
  for (const row of ctx.scopeRows) {
    for (const a of row.addresses) {
      if (a.s !== 'conflict') continue;
      const key = `IP_CONFLICT:${a.ip}`;
      managed.push(key);
      alerts.push({
        type: 'IP_CONFLICT',
        severity: 'MEDIUM',
        description: `Conflicto de IP en ${a.ip}: el DHCP la marcó como rechazada porque otro equipo ya la estaba usando${a.m ? ` (MAC ${a.m})` : ''}. Revisar si hay una IP fija mal configurada dentro del rango DHCP.`,
        metadata: { ip: a.ip, mac: a.m ?? null },
        dedupKey: key,
      });
    }
  }

  // IP duplicada: el DHCP dice una MAC y en la red responde otra.
  const openDup = await prisma.securityEvent.findMany({
    where: { serverId: server.id, dedupKey: { startsWith: 'IP_DUP:' }, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
    select: { dedupKey: true },
  });
  managed.push(...openDup.map((e) => e.dedupKey));
  for (const a of await netGuard.duplicateIpAlerts(ctx.scopes, ctx.alive ?? {})) {
    managed.push(a.dedupKey);
    alerts.push(a);
  }

  // Impresoras.
  const printers = await prisma.printer.findMany();
  for (const p of printers) {
    const key = `PRINTER:${p.id}`;
    managed.push(key);
    const label = `${p.name ?? p.model ?? 'Impresora'} (${p.id})`;
    const blocking = p.errors.filter((e) => PRINTER_BLOCKING_ERRORS.includes(e));
    const warnings = p.errors.filter((e) => PRINTER_WARNING_ERRORS.includes(e));
    const lowSupplies = (Array.isArray(p.supplies) ? p.supplies : []).filter((s) => s.percent !== null && s.percent <= SUPPLY_LOW_PCT);
    const offlineLong = !p.online && Date.now() - new Date(p.statusChangedAt).getTime() >= PRINTER_OFFLINE_GRACE_MS;

    if (offlineLong || blocking.length > 0) {
      alerts.push({
        type: 'PRINTER_ISSUE',
        severity: 'MEDIUM',
        description: offlineLong
          ? `${label}: no responde en la red desde hace ${Math.round((Date.now() - new Date(p.statusChangedAt).getTime()) / 60000)} min.`
          : `${label}: ${blocking.map((e) => PRINTER_ERROR_LABEL[e] ?? e).join(', ')}.`,
        metadata: { printer: p.id, errors: p.errors },
        dedupKey: key,
      });
    } else if (warnings.length > 0 || lowSupplies.length > 0) {
      alerts.push({
        type: 'PRINTER_ISSUE',
        severity: 'LOW',
        description: `${label}: ${[
          ...warnings.map((e) => PRINTER_ERROR_LABEL[e] ?? e),
          ...lowSupplies.map((s) => `${s.name} al ${s.percent}%`),
        ].join(', ')}. Conviene pedir el repuesto antes de que se corte.`,
        metadata: { printer: p.id, errors: p.errors, lowSupplies },
        dedupKey: key,
      });
    }
  }

  // Cuentas bloqueadas (se resuelve sola cuando el AD la muestra desbloqueada).
  if (ctx.roles.ad) {
    const locked = new Set(ctx.users.filter((u) => u.lockedOut).map((u) => String(u.sam).toLowerCase()));
    const openLockouts = await prisma.securityEvent.findMany({
      where: { serverId: server.id, type: 'AD_ACCOUNT_LOCKOUT', status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
      select: { dedupKey: true },
    });
    for (const e of openLockouts) {
      const user = e.dedupKey?.split(':')[1];
      if (ctx.users.length > 0 && user && !locked.has(user)) managed.push(e.dedupKey);
    }
    for (const ev of ctx.directoryEvents.filter((e) => e.kind === 'lockout' && e.target)) {
      const user = String(ev.target).toLowerCase();
      alerts.push({
        type: 'AD_ACCOUNT_LOCKOUT',
        severity: 'MEDIUM',
        description: `Cuenta "${ev.target}" bloqueada por intentos fallidos${ev.callerHost ? ` desde el equipo ${ev.callerHost}` : ''}. Si el usuario no fue, puede ser una contraseña vieja guardada (celular, unidad de red, servicio) o un intento de acceso.`,
        metadata: { user: ev.target, callerHost: ev.callerHost, at: ev.at },
        dedupKey: `AD_LOCKOUT:${user}`,
      });
    }

    // Fuerza bruta: muchos fallos de un mismo usuario en un ciclo.
    const openBrute = await prisma.securityEvent.findMany({
      where: { serverId: server.id, dedupKey: { startsWith: 'LOGIN_FAILURE:ad:' }, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
      select: { dedupKey: true },
    });
    managed.push(...openBrute.map((e) => e.dedupKey));
    const byUser = new Map();
    for (const f of ctx.failedAuth) {
      const cur = byUser.get(f.user) ?? { count: 0, sources: new Set() };
      cur.count += f.count;
      if (f.ip) cur.sources.add(ctx.ipHost.get(f.ip) ? `${ctx.ipHost.get(f.ip)} (${f.ip})` : f.ip);
      byUser.set(f.user, cur);
    }
    for (const [user, info] of byUser) {
      if (info.count < FAILED_AUTH_THRESHOLD) continue;
      const key = `LOGIN_FAILURE:ad:${user}`;
      managed.push(key);
      alerts.push({
        type: 'LOGIN_FAILURE',
        severity: info.count >= FAILED_AUTH_THRESHOLD * 5 ? 'CRITICAL' : 'HIGH',
        description: `${info.count} intentos de inicio de sesión fallidos para "${user}" en los últimos minutos${info.sources.size ? ` desde ${[...info.sources].slice(0, 5).join(', ')}` : ''}. Posible ataque de contraseña o credencial vieja guardada.`,
        metadata: { user, count: info.count, sources: [...info.sources] },
        dedupKey: key,
      });
    }

    // Cambios en grupos privilegiados: cada uno es un evento propio.
    for (const ev of ctx.directoryEvents.filter((e) => e.kind === 'group_member_added' && e.group)) {
      if (!PRIVILEGED_GROUPS.includes(String(ev.group).toLowerCase())) continue;
      alerts.push({
        type: 'PRIVILEGED_GROUP_CHANGE',
        severity: 'CRITICAL',
        description: `"${ev.target}" fue agregado al grupo privilegiado "${ev.group}" por ${ev.actor ?? 'desconocido'}. Si no es un cambio planificado, tratarlo como incidente de seguridad.`,
        metadata: ev,
        dedupKey: `PRIVILEGED_GROUP_CHANGE:${ev.group}:${ev.target}:${ev.at}`,
      });
    }
  }

  // Impresoras: se confirma en 2 inventarios seguidos (~10 min): un atasco
  // que alguien resolvio enseguida no llega a ser alerta.
  await Promise.all(alerts.map((a) => createAndDispatchEvent({ ...base, ...a, confirmations: a.confirmations ?? (a.type === 'PRINTER_ISSUE' ? 2 : 1) })));
  await resolveCleared(
    server.id,
    [...new Set(managed.filter(Boolean))],
    alerts.map((a) => a.dedupKey),
    server.name
  );
}

// --- Un solo recolector ------------------------------------------------------
// Varios servidores pueden tener el rol de AD (controladores de dominio
// secundarios) o de impresion; si todos hicieran inventario, cada impresora,
// ambito y cuenta bloqueada se alertaria una vez por servidor. Solo se acepta
// el del recolector configurado (Admin -> Configuracion -> Monitoreo
// preventivo), o si no hay uno, el primer servidor con DHCP que reporte.
const INVENTORY_ALERT_TYPES = ['PRINTER_ISSUE', 'DHCP_SCOPE_EXHAUSTED', 'IP_CONFLICT', 'AD_ACCOUNT_LOCKOUT', 'PRIVILEGED_GROUP_CHANGE', 'UNKNOWN_DEVICE'];

async function isInventoryCollector(server, payload) {
  const configured = (await getSetting('INVENTORY_COLLECTOR'))?.trim();
  if (configured) return configured.toLowerCase() === server.name.toLowerCase();
  if (payload.roles?.dhcp) {
    await setSettings({ INVENTORY_COLLECTOR: server.name });
    console.log(`Inventario de red: ${server.name} queda como recolector (primer servidor con DHCP)`);
    return true;
  }
  return false;
}

// Borra lo que generaron los servidores que no son el recolector (alertas
// duplicadas, ambitos, estado de inventario).
async function purgeNonCollectorData(collectorId) {
  const [events, , others] = await Promise.all([
    prisma.securityEvent.deleteMany({
      where: {
        serverId: { not: collectorId },
        OR: [{ type: { in: INVENTORY_ALERT_TYPES } }, { dedupKey: { startsWith: 'LOGIN_FAILURE:ad:' } }],
      },
    }),
    prisma.dhcpScope.deleteMany({ where: { serverId: { not: collectorId } } }),
    prisma.server.updateMany({
      where: { id: { not: collectorId }, inventoryAt: { not: null } },
      data: { inventoryAt: null, inventorySummary: Prisma.DbNull },
    }),
  ]);
  if (events.count > 0) console.log(`Inventario de red: ${events.count} alerta(s) duplicada(s) de otros servidores eliminadas`);
  // Habia otros recolectores: sus impresoras pueden no ser alcanzables desde
  // el recolector y quedarian como "sin respuesta" para siempre. Se vacia la
  // lista; el recolector la vuelve a armar en su proximo ciclo.
  if (others.count > 0) await prisma.printer.deleteMany({});
}

module.exports = {
  ingestLogons,
  activeSessionOf,
  normalizeMac,
  shortHost,
  isInventoryCollector,
  purgeNonCollectorData,
  processInventory,
  buildAddressMap,
  compressRanges,
  countStatuses,
  subnetHosts,
  maskToPrefix,
  PRINTER_ERROR_LABEL,
};
