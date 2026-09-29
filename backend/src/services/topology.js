// Topologia automatica de cada sede: Internet -> gateway (FortiGate / UniFi)
// -> switches -> APs -> servidores, armada con lo que ya sabe el NOC:
//   - UniFi (controlador local o nube): equipos y de quien cuelga cada uno
//     (uplink), y los clientes con su switch/puerto o AP;
//   - agentes: IP de cada servidor, su gateway y la MAC del gateway;
//   - IP publica: los servidores de una misma sede salen por la misma IP.
// El estado de cada eslabon es el real (online/offline, salud, alertas).
const prisma = require('../prismaClient');
const { withLatest } = require('./latest');
const { getHealthStatus } = require('./alertEngine');

function norm(mac) {
  const hex = String(mac ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');
  return hex.length === 12 ? hex.match(/../g).join(':') : null;
}

function subnet24(ip) {
  const m = String(ip ?? '').match(/^(\d+\.\d+\.\d+)\.\d+$/);
  return m ? m[1] : null;
}

function deviceStatus(d) {
  return d.status === 'online' ? 'ok' : d.status === 'offline' ? 'down' : 'warning';
}

function serverStatus(s, health) {
  if (s.status === 'OFFLINE') return 'down';
  if (health === 'CRITICAL') return 'critical';
  if (health === 'WARNING' || s.status === 'DEGRADED') return 'warning';
  return 'ok';
}

async function buildNetworkTopology() {
  const [sites, devices, rawServers, gateways, openAlerts] = await Promise.all([
    prisma.unifiSite.findMany(),
    prisma.unifiDevice.findMany(),
    prisma.server.findMany(),
    prisma.netGatewayState.findMany(),
    prisma.securityEvent.groupBy({ by: ['serverId'], where: { status: 'OPEN' }, _count: { _all: true } }),
  ]);
  const servers = await withLatest(rawServers, { backups: false });
  const alertsBy = new Map(openAlerts.map((a) => [a.serverId, a._count._all]));
  const gwBy = new Map(gateways.map((g) => [g.serverId, g]));
  const placed = new Set();
  const out = [];

  // Servidores por subred /24 (para ubicarlos en la sede de UniFi que tenga
  // equipos en esa misma subred).
  const serverNode = (s) => {
    const health = getHealthStatus(s.telemetry?.[0], s);
    return {
      id: `srv:${s.id}`,
      serverId: s.id,
      type: 'server',
      name: s.name,
      ip: s.ipAddress,
      status: serverStatus(s, health),
      detail: [s.telemetry?.[0] ? `CPU ${Math.round(s.telemetry[0].cpuUsage)}% · RAM ${Math.round(s.telemetry[0].memoryUsage)}%` : 'sin telemetría', alertsBy.get(s.id) ? `${alertsBy.get(s.id)} alerta(s)` : null]
        .filter(Boolean)
        .join(' · '),
    };
  };

  for (const site of sites) {
    const siteDevices = devices.filter((d) => d.siteId === site.id);
    if (siteDevices.length === 0) continue;
    const nodes = [];
    const edges = [];
    const byMac = new Map(siteDevices.map((d) => [d.id, d]));
    const byName = new Map(siteDevices.map((d) => [d.name, d]));
    const health = site.health ?? {};
    const wanOk = site.hostOnline !== false && (health.wan?.status ?? 'ok') !== 'error';
    nodes.push({
      id: `wan:${site.id}`,
      type: 'internet',
      name: 'Internet',
      status: wanOk ? 'ok' : 'down',
      detail: [site.ispName ?? health.wan?.isp, health.wan?.latencyMs != null ? `${health.wan.latencyMs} ms` : null, health.wan?.wanIp].filter(Boolean).join(' · ') || null,
    });

    // Gateway: el de UniFi si existe; si no, un nodo "gateway del sitio" con la
    // IP que ven los agentes.
    const gwDevices = siteDevices.filter((d) => d.deviceType === 'gateway');
    const subnets = new Set(siteDevices.map((d) => subnet24(d.ipAddress)).filter(Boolean));
    const siteServers = servers.filter((s) => {
      if (placed.has(s.id)) return false;
      const clients = Array.isArray(site.clients) ? site.clients : [];
      return clients.some((c) => c.ip === s.ipAddress) || subnets.has(subnet24(s.ipAddress));
    });
    let rootId;
    if (gwDevices.length) {
      for (const g of gwDevices) {
        nodes.push({ id: `dev:${g.id}`, type: 'gateway', name: g.name, ip: g.ipAddress, model: g.model, status: deviceStatus(g), detail: g.model });
        edges.push({ from: `wan:${site.id}`, to: `dev:${g.id}` });
      }
      rootId = `dev:${gwDevices[0].id}`;
    } else {
      const gwState = siteServers.map((s) => gwBy.get(s.id)).find(Boolean);
      rootId = `gw:${site.id}`;
      const conflict = siteServers.some((s) => {
        const g = gwBy.get(s.id);
        return g && g.baselineMac && g.currentMac !== g.baselineMac;
      });
      nodes.push({
        id: rootId,
        type: 'gateway',
        name: 'Gateway / FortiGate',
        ip: gwState?.gatewayIp ?? null,
        status: conflict ? 'critical' : wanOk ? 'ok' : 'down',
        detail: conflict ? '¡La MAC del gateway cambió! (ver Seguridad de red)' : gwState?.baselineMac ?? null,
      });
      edges.push({ from: `wan:${site.id}`, to: rootId });
    }

    // Switches y APs, colgados de su uplink.
    for (const d of siteDevices.filter((x) => x.deviceType !== 'gateway')) {
      const up = d.details?.uplink ?? {};
      const parent = (up.mac && byMac.get(norm(up.mac))) || (up.device && byName.get(up.device)) || null;
      const detail = [
        d.model,
        d.clients != null ? `${d.clients} cliente(s)` : null,
        d.details?.ports ? `${d.details.ports.up}/${d.details.ports.total} puertos` : null,
        d.firmwareStatus === 'updateAvailable' ? 'firmware pendiente' : null,
      ]
        .filter(Boolean)
        .join(' · ');
      nodes.push({ id: `dev:${d.id}`, type: d.deviceType === 'ap' ? 'ap' : d.deviceType === 'switch' ? 'switch' : 'device', name: d.name, ip: d.ipAddress, status: deviceStatus(d), detail });
      edges.push({ from: parent && parent.id !== d.id ? `dev:${parent.id}` : rootId, to: `dev:${d.id}`, label: up.port ? `puerto ${up.port}` : up.type === 'wireless' ? 'malla WiFi' : null });
    }

    // Servidores: al switch/AP donde UniFi los ve, o al gateway.
    for (const s of siteServers) {
      placed.add(s.id);
      const c = (Array.isArray(site.clients) ? site.clients : []).find((x) => x.ip === s.ipAddress);
      const parentMac = norm(c?.sw_mac) ?? norm(c?.ap_mac);
      const parent = parentMac && byMac.get(parentMac) ? `dev:${parentMac}` : rootId;
      nodes.push(serverNode(s));
      edges.push({ from: parent, to: `srv:${s.id}`, label: c?.sw_port ? `puerto ${c.sw_port}` : c?.essid ? `WiFi ${c.essid}` : null });
    }

    out.push({
      id: site.id,
      name: site.siteName || site.hostName,
      source: site.localAt ? 'UniFi local' : 'UniFi nube',
      counts: {
        devices: siteDevices.length,
        offline: siteDevices.filter((d) => d.status === 'offline').length,
        clients: (site.wifiClients ?? 0) + (site.wiredClients ?? 0),
      },
      nodes,
      edges,
    });
  }

  // Sedes sin UniFi: servidores agrupados por IP publica (misma salida a
  // internet = misma sede) con su gateway.
  const rest = servers.filter((s) => !placed.has(s.id) && !(s.tags ?? []).includes('infra-vps'));
  const groups = new Map();
  for (const s of rest) {
    const key = s.publicIp ?? `sin-ip:${subnet24(s.ipAddress) ?? s.id}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  for (const [key, list] of groups) {
    const id = `grp:${key}`;
    const nodes = [{ id: `wan:${id}`, type: 'internet', name: 'Internet', status: list.some((s) => s.status !== 'OFFLINE') ? 'ok' : 'down', detail: key.startsWith('sin-ip') ? null : `IP pública ${key}` }];
    const edges = [];
    const byGw = new Map();
    // Los que todavia no informaron su gateway (agente < 1.14) cuelgan del
    // gateway conocido de la sede, si hay uno solo.
    const knownGws = [...new Set(list.map((s) => gwBy.get(s.id)?.gatewayIp).filter(Boolean))];
    for (const s of list) {
      const g = gwBy.get(s.id);
      const gwKey = g?.gatewayIp ?? (knownGws.length === 1 ? knownGws[0] : 'desconocido');
      byGw.set(gwKey, [...(byGw.get(gwKey) ?? []), s]);
    }
    for (const [gwIp, members] of byGw) {
      const gid = `gw:${id}:${gwIp}`;
      const conflict = members.some((s) => {
        const g = gwBy.get(s.id);
        return g && g.baselineMac && g.currentMac !== g.baselineMac;
      });
      nodes.push({
        id: gid,
        type: 'gateway',
        name: 'Gateway / FortiGate',
        ip: gwIp === 'desconocido' ? null : gwIp,
        status: conflict ? 'critical' : 'ok',
        detail: conflict ? '¡La MAC del gateway cambió!' : gwBy.get(members[0].id)?.baselineMac ?? null,
      });
      edges.push({ from: `wan:${id}`, to: gid });
      for (const s of members) {
        nodes.push(serverNode(s));
        edges.push({ from: gid, to: `srv:${s.id}` });
      }
    }
    const names = list.map((s) => s.name).sort();
    const label = names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} y ${names.length - 3} más`;
    out.push({ id, name: key.startsWith('sin-ip') ? label : `Sede ${key} · ${label}`, source: 'agentes', counts: { devices: 0, offline: 0, clients: 0 }, nodes, edges });
  }
  return { sites: out.sort((a, b) => a.name.localeCompare(b.name)), generatedAt: new Date() };
}

module.exports = { buildNetworkTopology };
