// Guardian de red: detecta y explica los problemas de red "de capa 2" que
// dejan sin internet a una sucursal y son dificiles de encontrar a mano,
// como el NVR que se conecto con su propia IP/DHCP y tiro el WiFi:
//
//   - DHCP no autorizado: cada agente manda un DHCPDISCOVER cada 5 min; toda
//     oferta de un servidor que no es el del dominio, el gateway del sitio o
//     uno aprobado es un DHCP falso (reparte IPs y un gateway equivocado).
//   - Gateway suplantado / IP duplicada: cada agente informa la MAC de su
//     gateway cada minuto. Si cambia o alterna entre dos MAC, otro equipo
//     tiene configurada la IP del gateway.
//   - IP duplicada en la LAN: el DHCP dice que una IP es de la MAC A pero en
//     la red responde la MAC B.
//   - Equipo desconocido: una MAC que nunca se vio en la red (DHCP o barrido).
//
// Cada alerta dice QUE equipo es (MAC, fabricante, IP, nombre) y DONDE esta
// conectado (switch + puerto o AP de UniFi) para poder actuar enseguida.
const prisma = require('../prismaClient');
const { getSetting, setSettings } = require('./settings');
const { createAndDispatchEvent, autoResolveEvents } = require('./eventPipeline');

const ACTIVE = ['OPEN', 'ACKNOWLEDGED'];
const GATEWAY_HISTORY = 20;
const FLAP_WINDOW_MS = 15 * 60000;
const DHCP_STALE_MS = 20 * 60000;
const NEW_DEVICE_BURST = 15;

// --- Fabricante por MAC (OUI) -------------------------------------------------
// Lista corta embebida (camaras/NVR, red, impresoras, PCs) + la lista oficial
// de la IEEE descargada en segundo plano (se reintenta una vez por dia).
const BUILTIN_OUI = {
  '4c:bd:8f': 'Hikvision', 'c0:56:e3': 'Hikvision', '44:19:b6': 'Hikvision', 'bc:ad:28': 'Hikvision', '54:c4:15': 'Hikvision',
  '28:57:be': 'Hikvision', 'a4:14:37': 'Hikvision', 'e0:50:8b': 'Dahua', '3c:ef:8c': 'Dahua', '90:02:a9': 'Dahua', 'bc:32:5f': 'Dahua',
  '38:af:29': 'Dahua', '9c:8e:cd': 'Amcrest', 'ec:71:db': 'Reolink', '00:12:12': 'Hikvision/Plus', '00:40:8c': 'Axis',
  'ac:cc:8e': 'Axis', 'b8:a4:4f': 'Axis', '24:5a:4c': 'Ubiquiti', '74:83:c2': 'Ubiquiti', 'f0:9f:c2': 'Ubiquiti', '78:8a:20': 'Ubiquiti',
  'e0:63:da': 'Ubiquiti', 'fc:ec:da': 'Ubiquiti', '80:2a:a8': 'Ubiquiti', '68:d7:9a': 'Ubiquiti', 'd0:21:f9': 'Ubiquiti',
  '00:09:0f': 'Fortinet', '70:4c:a5': 'Fortinet', '90:6c:ac': 'Fortinet', 'e8:1c:ba': 'Fortinet', '04:d5:90': 'Fortinet',
  '50:c7:bf': 'TP-Link', 'c0:25:e9': 'TP-Link', '98:da:c4': 'TP-Link', '60:32:b1': 'TP-Link', 'ec:08:6b': 'TP-Link',
  '00:1b:11': 'D-Link', 'c8:d3:a3': 'D-Link', '00:0c:42': 'MikroTik', '48:8f:5a': 'MikroTik', '64:d1:54': 'MikroTik',
  '00:1a:4b': 'HP', '3c:d9:2b': 'HP', '9c:b6:54': 'HP', 'a0:d3:c1': 'HP', '00:26:73': 'Ricoh', '00:80:77': 'Brother',
  '30:05:5c': 'Brother', '00:1b:a9': 'Brother', '64:eb:8c': 'Epson', 'ac:18:26': 'Epson', '00:26:ab': 'Epson', '00:17:c8': 'Kyocera',
  '00:c0:ee': 'Kyocera', '00:21:b7': 'Lexmark', 'f4:8e:38': 'Dell', '18:db:f2': 'Dell', 'b8:ca:3a': 'Dell', 'd4:be:d9': 'Dell',
  '54:bf:64': 'Dell', '6c:4b:90': 'Lenovo', '98:fa:9b': 'Lenovo', 'e8:6a:64': 'Lenovo', '00:50:56': 'VMware', '00:15:5d': 'Microsoft Hyper-V',
  '08:00:27': 'VirtualBox', 'f4:6b:8c': 'Hon Hai/Foxconn', '18:c0:4d': 'Giga-Byte', 'fc:34:97': 'ASUSTek', 'd8:43:ae': 'Micro-Star (MSI)',
  '48:4d:7e': 'Dell', '8c:ec:4b': 'Dell', '40:8d:5c': 'Giga-Byte', '50:9a:4c': 'Dell', '04:7c:16': 'Micro-Star (MSI)', 'f4:b5:20': 'Biostar',
};
const ouiMap = new Map(Object.entries(BUILTIN_OUI));
const macLookup = require('./macLookup');

// Compatibilidad: la carga de la IEEE ahora la hace macLookup.js.
function loadIeeeOui() {
  macLookup.loadRegistries();
}

function normMac(mac) {
  if (!mac) return null;
  const hex = String(mac).toLowerCase().replace(/[^0-9a-f]/g, '');
  return hex.length === 12 ? hex.match(/../g).join(':') : null;
}

// Bit "administrada localmente": los celulares y Windows con "direcciones
// aleatorias" usan una MAC distinta por red.
function isRandomized(mac) {
  const m = normMac(mac);
  return Boolean(m) && (parseInt(m.slice(0, 2), 16) & 0x02) === 0x02;
}

function vendorOf(mac) {
  const m = normMac(mac);
  if (!m) return null;
  if (isRandomized(m)) return 'MAC aleatoria (celular / privacidad)';
  return macLookup.quickLookup(m)?.vendor ?? ouiMap.get(m.slice(0, 8)) ?? null;
}

// --- Donde esta conectado un equipo --------------------------------------------
async function locateMac(mac) {
  const m = normMac(mac);
  if (!m) return null;
  const [sites, device, endpoint, printer] = await Promise.all([
    prisma.unifiSite.findMany({ where: { clients: { not: null } }, select: { id: true, hostName: true, siteName: true, clients: true } }),
    prisma.netDevice.findUnique({ where: { mac: m } }),
    prisma.endpoint.findFirst({ where: { macAddress: m }, select: { hostname: true, ipAddress: true, lastUser: true } }),
    prisma.printer.findFirst({ where: { macAddress: m }, select: { id: true, name: true } }),
  ]);
  const out = {
    mac: m,
    vendor: vendorOf(m),
    ip: device?.ip ?? endpoint?.ipAddress ?? null,
    hostname: device?.hostname ?? endpoint?.hostname ?? printer?.name ?? null,
    firstSeenAt: device?.firstSeenAt ?? null,
    lastUser: endpoint?.lastUser ?? null,
    kind: printer ? 'impresora' : endpoint ? 'equipo del dominio' : null,
    site: null,
    switchName: null,
    switchPort: null,
    apName: null,
    essid: null,
    wired: null,
  };
  for (const s of sites) {
    const c = (Array.isArray(s.clients) ? s.clients : []).find((x) => normMac(x.mac) === m);
    if (!c) continue;
    out.site = s.siteName || s.hostName;
    out.ip = out.ip ?? c.ip ?? null;
    out.hostname = out.hostname ?? c.hostname ?? c.name ?? null;
    out.wired = c.is_wired ?? null;
    out.essid = c.essid ?? null;
    out.switchPort = c.sw_port ?? null;
    const [sw, ap] = await Promise.all([
      c.sw_mac ? prisma.unifiDevice.findUnique({ where: { id: normMac(c.sw_mac) }, select: { name: true } }) : null,
      c.ap_mac ? prisma.unifiDevice.findUnique({ where: { id: normMac(c.ap_mac) }, select: { name: true } }) : null,
    ]);
    out.switchName = sw?.name ?? (c.sw_mac ? normMac(c.sw_mac) : null);
    out.apName = ap?.name ?? (c.ap_mac ? normMac(c.ap_mac) : null);
    break;
  }
  return out;
}

function describeLocation(loc) {
  if (!loc) return '';
  const parts = [];
  if (loc.vendor) parts.push(`fabricante ${loc.vendor}`);
  if (loc.hostname) parts.push(`nombre "${loc.hostname}"`);
  if (loc.ip) parts.push(`IP ${loc.ip}`);
  if (loc.kind) parts.push(loc.kind);
  let where = '';
  if (loc.switchName) where = ` Conectado al switch "${loc.switchName}"${loc.switchPort ? ` puerto ${loc.switchPort}` : ''}${loc.site ? ` (${loc.site})` : ''}.`;
  else if (loc.apName) where = ` Conectado por WiFi al AP "${loc.apName}"${loc.essid ? ` (red ${loc.essid})` : ''}${loc.site ? ` en ${loc.site}` : ''}.`;
  return `${parts.length ? ` (${parts.join(', ')})` : ''}.${where}`;
}

// --- DHCP autorizados ------------------------------------------------------------
async function authorizedDhcpServers() {
  const configured = String((await getSetting('NETGUARD_DHCP_SERVERS')) ?? '')
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const servers = await prisma.server.findMany({ select: { ipAddress: true, inventorySummary: true, appRoles: true } });
  const dhcp = servers.filter((s) => s.inventorySummary?.roles?.dhcp).map((s) => s.ipAddress);
  return new Set([...configured, ...dhcp]);
}

async function openEventFor(dedupKey) {
  return prisma.securityEvent.findFirst({ where: { dedupKey, status: { in: ACTIVE } }, select: { id: true, serverId: true } });
}

// --- Reporte de un agente ---------------------------------------------------------
async function ingestReport(server, report) {
  const now = new Date();
  const results = { gateway: null, dhcp: null };

  // 1. MAC del gateway.
  const gw = report.gateway;
  const gwMac = normMac(gw?.mac);
  if (gw?.ip && gwMac) {
    const state = await prisma.netGatewayState.findUnique({ where: { serverId: server.id } });
    if (!state || state.gatewayIp !== gw.ip) {
      await prisma.netGatewayState.upsert({
        where: { serverId: server.id },
        create: { serverId: server.id, gatewayIp: gw.ip, baselineMac: gwMac, currentMac: gwMac, history: [{ mac: gwMac, at: now }] },
        update: { gatewayIp: gw.ip, baselineMac: gwMac, currentMac: gwMac, history: [{ mac: gwMac, at: now }], changedAt: now },
      });
    } else {
      const history = Array.isArray(state.history) ? state.history : [];
      if (state.currentMac !== gwMac) history.push({ mac: gwMac, at: now });
      const trimmed = history.slice(-GATEWAY_HISTORY);
      await prisma.netGatewayState.update({
        where: { serverId: server.id },
        data: { currentMac: gwMac, history: trimmed, ...(state.currentMac !== gwMac ? { changedAt: now } : {}) },
      });
      results.gateway = await evaluateGateway(server, { ...state, currentMac: gwMac, history: trimmed }, now);
    }
  }

  // 2. Ofertas DHCP.
  if (report.dhcp?.ok) {
    const authorized = await authorizedDhcpServers();
    if (gw?.ip) authorized.add(gw.ip);
    for (const o of report.dhcp.offers ?? []) {
      if (!o.server) continue;
      const mac = normMac(o.mac);
      const isAuth = authorized.has(o.server) || authorized.has(o.from);
      await prisma.dhcpOffer.upsert({
        where: { serverId_dhcpServer: { serverId: server.id, dhcpServer: o.server } },
        create: { serverId: server.id, dhcpServer: o.server, mac, router: o.router ?? null, offeredIp: o.offeredIp ?? null, dns: (o.dns ?? []).filter(Boolean), authorized: isAuth },
        update: { mac, router: o.router ?? null, offeredIp: o.offeredIp ?? null, dns: (o.dns ?? []).filter(Boolean), authorized: isAuth, lastSeenAt: now },
      });
      if (isAuth) continue;
      const key = `ROGUE_DHCP:${o.server}`;
      const open = await openEventFor(key);
      if (open && open.serverId !== server.id) continue; // ya lo alerto otro agente de la misma red
      const loc = await locateMac(mac);
      await createAndDispatchEvent({
        serverId: server.id,
        serverName: server.name,
        type: 'ROGUE_DHCP',
        severity: 'CRITICAL',
        description:
          `Servidor DHCP NO AUTORIZADO en la red de ${server.name}: ${o.server}${mac ? ` (MAC ${mac})` : ''}${describeLocation(loc)} ` +
          `Está repartiendo IPs (ofreció ${o.offeredIp ?? '—'}) con gateway ${o.router ?? '—'}${o.dns?.length ? ` y DNS ${o.dns.filter(Boolean).join(', ')}` : ''}: ` +
          'los equipos que tomen esa IP se quedan sin internet o sin dominio. Desconectar ese equipo o apagarle el servicio DHCP. ' +
          'Si es un DHCP legítimo, aprobarlo en Inventario → Seguridad de red.',
        metadata: { dhcpServer: o.server, mac, router: o.router, offeredIp: o.offeredIp, dns: o.dns, location: loc },
        dedupKey: key,
      });
      results.dhcp = 'rogue';
    }
  }
  // DHCP falsos que ya nadie ve hace 20 min: se resuelven.
  await resolveStaleDhcp(now);
  return results;
}

async function evaluateGateway(server, state, now) {
  const key = `GATEWAY_CONFLICT:${state.gatewayIp}`;
  const history = state.history ?? [];
  const recent = history.filter((h) => now - new Date(h.at) < FLAP_WINDOW_MS);
  const macsRecent = [...new Set(recent.map((h) => h.mac))];
  const flapping = recent.length >= 3 && macsRecent.length >= 2;
  const changed = state.baselineMac && state.currentMac !== state.baselineMac;

  if (!changed && !flapping) {
    if (now - new Date(state.changedAt) > 5 * 60000) await autoResolveEvents(server.id, [key], server.name);
    return 'ok';
  }
  const other = macsRecent.find((m) => m !== state.baselineMac) ?? state.currentMac;
  const [locOther, locBase] = await Promise.all([locateMac(other), locateMac(state.baselineMac)]);
  const description = flapping
    ? `IP DUPLICADA DEL GATEWAY ${state.gatewayIp} en la red de ${server.name}: responden dos equipos distintos y se alternan ` +
      `(${state.baselineMac}${locBase?.vendor ? ` ${locBase.vendor}` : ''} = gateway habitual, y ${other}${describeLocation(locOther)}) ` +
      'Todo el tráfico que va al equipo equivocado se pierde: cortes de internet/WiFi intermitentes. Buscar y desconectar el equipo con la MAC que no es la del gateway, o corregirle la IP fija.'
    : `El gateway ${state.gatewayIp} de ${server.name} CAMBIÓ DE MAC: antes ${state.baselineMac}${locBase?.vendor ? ` (${locBase.vendor})` : ''}, ahora ${state.currentMac}${describeLocation(locOther)} ` +
      'Si no se reemplazó el firewall/router, otro equipo tomó la IP del gateway (IP fija mal puesta o ataque ARP). Si fue un cambio planificado, aceptar la nueva MAC en Inventario → Seguridad de red.';
  await createAndDispatchEvent({
    serverId: server.id,
    serverName: server.name,
    type: 'GATEWAY_CONFLICT',
    severity: 'CRITICAL',
    description,
    metadata: { gatewayIp: state.gatewayIp, baselineMac: state.baselineMac, currentMac: state.currentMac, otherMac: other, flapping, location: locOther },
    dedupKey: key,
    confirmations: flapping ? 1 : 2,
  });
  return flapping ? 'flapping' : 'changed';
}

async function resolveStaleDhcp(now) {
  const open = await prisma.securityEvent.findMany({ where: { type: 'ROGUE_DHCP', status: { in: ACTIVE } }, select: { serverId: true, dedupKey: true } });
  for (const e of open) {
    const ip = e.dedupKey?.split(':')[1];
    if (!ip) continue;
    const offer = await prisma.dhcpOffer.findFirst({ where: { dhcpServer: ip, authorized: false }, orderBy: { lastSeenAt: 'desc' } });
    if (!offer || now - offer.lastSeenAt > DHCP_STALE_MS) await autoResolveEvents(e.serverId, [e.dedupKey], null);
  }
}

// --- Equipos vistos por el inventario ---------------------------------------------
// entries: [{mac, ip, hostname, source}] (concesiones DHCP + barrido ARP).
async function observeDevices(server, entries) {
  const now = new Date();
  const byMac = new Map();
  for (const e of entries) {
    const mac = normMac(e.mac);
    if (!mac || mac === 'ff:ff:ff:ff:ff:ff' || mac === '00:00:00:00:00:00') continue;
    const cur = byMac.get(mac) ?? {};
    byMac.set(mac, { mac, ip: e.ip ?? cur.ip ?? null, hostname: e.hostname ?? cur.hostname ?? null, source: cur.source ?? e.source });
  }
  if (byMac.size === 0) return { new: 0 };
  const macs = [...byMac.keys()];
  const known = new Set((await prisma.netDevice.findMany({ where: { mac: { in: macs } }, select: { mac: true } })).map((d) => d.mac));
  const firstRun = (await prisma.netDevice.count()) === 0;

  // Los conocidos: se actualiza IP/nombre/visto.
  for (const d of byMac.values()) {
    if (!known.has(d.mac)) continue;
    // eslint-disable-next-line no-await-in-loop
    await prisma.netDevice.update({
      where: { mac: d.mac },
      data: { lastSeenAt: now, ...(d.ip ? { ip: d.ip } : {}), ...(d.hostname ? { hostname: d.hostname } : {}) },
    });
  }
  const fresh = [...byMac.values()].filter((d) => !known.has(d.mac));
  if (fresh.length === 0) return { new: 0 };
  await prisma.netDevice.createMany({
    data: fresh.map((d) => ({
      mac: d.mac,
      ip: d.ip,
      hostname: d.hostname,
      vendor: vendorOf(d.mac),
      source: d.source ?? null,
      randomized: isRandomized(d.mac),
      approved: firstRun, // la primera vez se toma todo lo que hay como conocido
      firstSeenAt: now,
      lastSeenAt: now,
    })),
    skipDuplicates: true,
  });
  if (firstRun) {
    console.log(`Guardian de red: línea base inicial con ${fresh.length} equipo(s) conocidos`);
    return { new: 0, baseline: fresh.length };
  }
  if ((await getSetting('NETGUARD_UNKNOWN_DEVICE_ALERTS')) === false) return { new: fresh.length };

  // Los celulares con MAC aleatoria se registran pero no alertan.
  const alertable = fresh.filter((d) => !isRandomized(d.mac));
  if (alertable.length > NEW_DEVICE_BURST) {
    await createAndDispatchEvent({
      serverId: server.id,
      serverName: server.name,
      type: 'UNKNOWN_DEVICE',
      severity: 'HIGH',
      description: `${alertable.length} equipos nunca vistos aparecieron de golpe en la red (ej.: ${alertable
        .slice(0, 5)
        .map((d) => `${d.ip ?? '?'} ${d.mac}${vendorOf(d.mac) ? ` ${vendorOf(d.mac)}` : ''}`)
        .join('; ')}). Puede ser un switch/AP nuevo, un DHCP falso o un escaneo. Revisar en Inventario → Seguridad de red.`,
      metadata: { count: alertable.length, macs: alertable.slice(0, 50).map((d) => d.mac) },
      dedupKey: `UNKNOWN_DEVICE:burst:${now.toISOString().slice(0, 13)}`,
    });
    return { new: fresh.length };
  }
  for (const d of alertable) {
    // eslint-disable-next-line no-await-in-loop
    const loc = await locateMac(d.mac);
    // eslint-disable-next-line no-await-in-loop
    await createAndDispatchEvent({
      serverId: server.id,
      serverName: server.name,
      type: 'UNKNOWN_DEVICE',
      severity: 'MEDIUM',
      description: `Equipo NUNCA VISTO en la red: MAC ${d.mac}${describeLocation({ ...loc, ip: d.ip ?? loc?.ip, hostname: d.hostname ?? loc?.hostname })} ` +
        'Si es un equipo nuevo autorizado, aprobarlo en Inventario → Seguridad de red; si nadie lo reconoce, ubicarlo y desconectarlo.',
      metadata: { mac: d.mac, ip: d.ip, hostname: d.hostname, vendor: vendorOf(d.mac), location: loc },
      dedupKey: `UNKNOWN_DEVICE:${d.mac}`,
    });
  }
  return { new: fresh.length };
}

// IP duplicada en la LAN: la concesion DHCP dice MAC A y en la red responde
// MAC B. Devuelve alertas para evaluateInventoryAlerts (managed IP_DUP:*).
async function duplicateIpAlerts(scopes, alive) {
  const alerts = [];
  for (const scope of scopes) {
    for (const l of scope.leases ?? []) {
      if (!String(l.state ?? '').startsWith('Active')) continue;
      const leaseMac = normMac(l.mac);
      const liveMac = normMac(alive[l.ip]?.mac);
      if (!leaseMac || !liveMac || leaseMac === liveMac) continue;
      // eslint-disable-next-line no-await-in-loop
      const loc = await locateMac(liveMac);
      alerts.push({
        type: 'IP_CONFLICT',
        severity: 'HIGH',
        description:
          `IP DUPLICADA ${l.ip}: el DHCP se la asignó a ${l.host ?? 'un equipo'} (MAC ${leaseMac}${vendorOf(leaseMac) ? `, ${vendorOf(leaseMac)}` : ''}), ` +
          `pero en la red responde otro equipo: MAC ${liveMac}${describeLocation(loc)} Ese equipo tiene la IP puesta a mano dentro del rango del DHCP: ` +
          'cambiarle la IP a una fuera del rango (o reservarla en el DHCP).',
        metadata: { ip: l.ip, leaseMac, liveMac, leaseHost: l.host ?? null, location: loc },
        dedupKey: `IP_DUP:${l.ip}`,
        confirmations: 2,
      });
    }
  }
  return alerts;
}

// --- Consultas / aprobaciones -------------------------------------------------------
async function overview() {
  const [gateways, offers, recentDevices, servers, counts] = await Promise.all([
    prisma.netGatewayState.findMany(),
    prisma.dhcpOffer.findMany({ where: { lastSeenAt: { gte: new Date(Date.now() - 24 * 3600000) } }, orderBy: { lastSeenAt: 'desc' } }),
    prisma.netDevice.findMany({ where: { firstSeenAt: { gte: new Date(Date.now() - 14 * 86400000) } }, orderBy: { firstSeenAt: 'desc' }, take: 300 }),
    prisma.server.findMany({ select: { id: true, name: true } }),
    prisma.netDevice.count(),
  ]);
  const names = new Map(servers.map((s) => [s.id, s.name]));
  return {
    gateways: gateways.map((g) => ({
      serverId: g.serverId,
      serverName: names.get(g.serverId) ?? g.serverId,
      gatewayIp: g.gatewayIp,
      baselineMac: g.baselineMac,
      baselineVendor: vendorOf(g.baselineMac),
      currentMac: g.currentMac,
      currentVendor: vendorOf(g.currentMac),
      ok: g.currentMac === g.baselineMac,
      history: g.history ?? [],
      changedAt: g.changedAt,
      updatedAt: g.updatedAt,
    })),
    dhcpServers: offers.map((o) => ({ ...o, serverName: names.get(o.serverId) ?? o.serverId, vendor: vendorOf(o.mac) })),
    newDevices: recentDevices.map((d) => ({ ...d, vendor: d.vendor ?? vendorOf(d.mac) })),
    knownDevices: counts,
  };
}

async function approveDevice(mac, note) {
  const m = normMac(mac);
  const d = await prisma.netDevice.update({ where: { mac: m }, data: { approved: true, ...(note ? { note } : {}) } });
  const events = await prisma.securityEvent.findMany({ where: { dedupKey: `UNKNOWN_DEVICE:${m}`, status: { in: ACTIVE } }, select: { serverId: true } });
  for (const e of events) await autoResolveEvents(e.serverId, [`UNKNOWN_DEVICE:${m}`], null);
  return d;
}

// Aprobar muchos equipos juntos: una lista de MAC, todos los nuevos de una
// red (cidr) o todos los nuevos.
async function approveDevicesBulk({ macs, cidr, all }) {
  const where = { approved: false };
  if (Array.isArray(macs) && macs.length) where.mac = { in: macs.map(normMac).filter(Boolean) };
  else if (!all && !cidr) return { approved: 0 };
  let rows = await prisma.netDevice.findMany({ where, select: { mac: true, ip: true } });
  if (cidr) {
    const [net, bits] = String(cidr).split('/');
    const toInt = (ip) => String(ip ?? '').split('.').reduce((a, o) => (a << 8) + (Number(o) & 255), 0) >>> 0;
    const size = 2 ** (32 - Number(bits));
    const base = toInt(net);
    rows = rows.filter((d) => d.ip && toInt(d.ip) >= base && toInt(d.ip) < base + size);
  }
  const list = rows.map((d) => d.mac);
  if (!list.length) return { approved: 0 };
  await prisma.netDevice.updateMany({ where: { mac: { in: list } }, data: { approved: true } });
  const keys = list.map((m) => `UNKNOWN_DEVICE:${m}`);
  const events = await prisma.securityEvent.findMany({ where: { dedupKey: { in: keys }, status: { in: ACTIVE } }, select: { serverId: true, dedupKey: true } });
  const byServer = new Map();
  for (const e of events) byServer.set(e.serverId, [...(byServer.get(e.serverId) ?? []), e.dedupKey]);
  for (const [serverId, k] of byServer) await autoResolveEvents(serverId, k, null);
  return { approved: list.length, alertsResolved: events.length };
}

async function authorizeDhcp(ip) {
  const current = String((await getSetting('NETGUARD_DHCP_SERVERS')) ?? '')
    .split(/[,\s]+/)
    .filter(Boolean);
  if (!current.includes(ip)) await setSettings({ NETGUARD_DHCP_SERVERS: [...current, ip].join(',') });
  await prisma.dhcpOffer.updateMany({ where: { dhcpServer: ip }, data: { authorized: true } });
  const events = await prisma.securityEvent.findMany({ where: { dedupKey: `ROGUE_DHCP:${ip}`, status: { in: ACTIVE } }, select: { serverId: true } });
  for (const e of events) await autoResolveEvents(e.serverId, [`ROGUE_DHCP:${ip}`], null);
}

async function acceptGateway(serverId) {
  const state = await prisma.netGatewayState.findUnique({ where: { serverId } });
  if (!state) return null;
  await prisma.netGatewayState.update({ where: { serverId }, data: { baselineMac: state.currentMac, history: [{ mac: state.currentMac, at: new Date() }] } });
  await autoResolveEvents(serverId, [`GATEWAY_CONFLICT:${state.gatewayIp}`], null);
  return state;
}

module.exports = {
  ingestReport,
  observeDevices,
  duplicateIpAlerts,
  overview,
  approveDevice,
  approveDevicesBulk,
  authorizeDhcp,
  acceptGateway,
  locateMac,
  vendorOf,
  isRandomized,
  normMac,
  loadIeeeOui,
};
