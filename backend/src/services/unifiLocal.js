// UniFi en detalle via agentes (controladores "Network Server" autoalojados).
//
// La nube (Site Manager) solo informa un resumen por sitio de estos
// controladores, y los de version vieja (8.0.x) ni eso. El detalle completo
// (cada AP y switch: estado, IP, MAC, clientes, canales, satisfaccion,
// firmware, uplink, puertos) solo lo tiene el controlador, que esta en la LAN
// de la sucursal. Por eso lo lee el agente de Windows de esa sucursal:
//
//   1. El agente manda sus IPs a POST /api/agent/unifi/tasks.
//   2. El backend le asigna los controladores de su red (IP LAN que informa
//      la nube, o las URLs cargadas a mano en Admin) y le pasa la cuenta de
//      solo lectura configurada en Admin -> UniFi -- SOLO por HTTPS.
//   3. El agente consulta el controlador (API clasica /api/s/{sitio}) y
//      manda el resultado a POST /api/agent/unifi/report.
//   4. Aca se guardan los equipos (mismas alertas de caida que el resto) y
//      los contadores exactos del sitio.
const prisma = require('../prismaClient');
const { getSettings } = require('./settings');
const { syncDevices, classify, COUNT_FIELDS } = require('./unifi');
const { broadcast } = require('../websocket/socketServer');

const POLL_SECONDS = 120;
const AGENT_IPS_TTL_MS = 15 * 60 * 1000;
const agentIps = new Map(); // serverId -> { name, ips: [{ip, prefix}], at, https }

function ipToInt(ip) {
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function sameSubnet(ip, net) {
  const a = ipToInt(ip);
  const b = ipToInt(net.ip);
  if (a === null || b === null) return false;
  const prefix = Math.min(Math.max(Number(net.prefix) || 24, 16), 30);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (a & mask) === (b & mask);
}

function parseManualControllers(text) {
  // Una URL por linea (o separadas por coma): https://192.168.1.5:8443
  return String(text ?? '')
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s))
    .slice(0, 50);
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// Controladores que le tocan a este agente: los de su red. Si hay varios
// agentes en la misma red, lo consulta uno solo (el primero por nombre).
async function buildTasks(server, ips, isHttps) {
  const cfg = await getSettings(['UNIFI_LOCAL_USERNAME', 'UNIFI_LOCAL_PASSWORD', 'UNIFI_LOCAL_CONTROLLERS', 'UNIFI_LOCAL_ENABLED']);
  agentIps.set(server.id, { name: server.name, ips, at: Date.now(), https: isHttps });
  if (cfg.UNIFI_LOCAL_ENABLED === false) return { enabled: false };

  const now = Date.now();
  const peers = [...agentIps.entries()]
    .filter(([, a]) => now - a.at < AGENT_IPS_TTL_MS)
    .sort((x, y) => x[1].name.localeCompare(y[1].name));
  const ownerOf = (ip) => peers.find(([, a]) => a.ips.some((net) => sameSubnet(ip, net)))?.[0];

  const sites = await prisma.unifiSite.findMany({ select: { id: true, hostId: true, hostName: true, siteKey: true, lanIps: true, controllerUrl: true } });
  const byHost = new Map();
  for (const s of sites) {
    if (!byHost.has(s.hostId)) byHost.set(s.hostId, { hostId: s.hostId, hostName: s.hostName, lanIps: s.lanIps ?? [], controllerUrl: s.controllerUrl, sites: [] });
    byHost.get(s.hostId).sites.push({ siteId: s.id, siteKey: s.siteKey });
  }

  const tasks = [];
  const seenUrls = new Set();
  for (const h of byHost.values()) {
    // URL que ya funciono antes (la recordamos) o las IPs LAN de la nube.
    const urls = h.controllerUrl ? [h.controllerUrl] : h.lanIps.flatMap((ip) => [`https://${ip}:8443`, `https://${ip}`]);
    const ip = hostOf(urls[0]);
    if (!ip || ownerOf(ip) !== server.id) continue;
    urls.forEach((u) => seenUrls.add(u));
    tasks.push({ hostId: h.hostId, hostName: h.hostName, urls, sites: h.sites });
  }
  for (const url of parseManualControllers(cfg.UNIFI_LOCAL_CONTROLLERS)) {
    const ip = hostOf(url);
    if (seenUrls.has(url) || !ip || ownerOf(ip) !== server.id) continue;
    tasks.push({ hostId: null, hostName: null, urls: [url], sites: [] });
  }

  const hasCredentials = Boolean(cfg.UNIFI_LOCAL_USERNAME && cfg.UNIFI_LOCAL_PASSWORD);
  return {
    enabled: true,
    intervalSeconds: POLL_SECONDS,
    // Controladores instalados en el mismo servidor del agente (muy comun
    // con "Network Server" en Windows): se prueban siempre.
    probeLocal: true,
    tasks,
    // La contrasena del controlador nunca viaja por HTTP plano.
    credentials: hasCredentials && isHttps ? { username: cfg.UNIFI_LOCAL_USERNAME, password: cfg.UNIFI_LOCAL_PASSWORD } : null,
    credentialsBlocked: hasCredentials && !isHttps ? 'https-required' : hasCredentials ? null : 'not-configured',
  };
}

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

// Estado del equipo en la API clasica (campo "state").
const STATE = { 0: 'offline', 1: 'online', 2: 'pending_adoption', 4: 'updating', 5: 'provisioning', 6: 'offline', 7: 'adopting', 9: 'adopting', 10: 'adoption_failed', 11: 'isolated' };
const TYPE_BY_CODE = { uap: 'ap', usw: 'switch', ugw: 'gateway', udm: 'gateway', uxg: 'gateway', ucg: 'gateway', uck: 'other' };

function normalizeLocalDevice(d, site) {
  const mac = String(d.mac ?? '').toLowerCase();
  if (!mac) return null;
  const typeCode = String(d.type ?? '').toLowerCase();
  const deviceType = TYPE_BY_CODE[typeCode] ?? classify({ model: d.model, shortname: d.model, name: d.name });
  const status = STATE[d.state] ?? (d.state === undefined ? 'unknown' : `estado ${d.state}`);
  const radios = (Array.isArray(d.radio_table_stats) ? d.radio_table_stats : []).map((r) => ({
    band: r.radio === 'ng' ? '2.4 GHz' : r.radio === 'na' ? '5 GHz' : r.radio === '6e' ? '6 GHz' : r.radio,
    channel: n(r.channel),
    clients: n(r.num_sta),
    satisfaction: n(r.satisfaction),
    utilization: n(r.cu_total),
    txPower: n(r.tx_power),
  }));
  const ports = Array.isArray(d.port_table) ? d.port_table : [];
  const sys = d['system-stats'] ?? {};
  return {
    id: mac,
    name: d.name || d.model || mac,
    model: d.model_name || d.model || null,
    deviceType,
    ipAddress: d.ip || null,
    status,
    siteName: site.desc && site.desc.toLowerCase() !== 'default' ? site.desc : site.hostName || site.desc || null,
    hostName: site.hostName || site.desc || null,
    siteId: site.siteId,
    source: 'agent',
    firmwareVersion: d.version || null,
    firmwareStatus: d.upgradable ? 'updateAvailable' : null,
    startupTime: n(d.uptime) ? new Date(Date.now() - n(d.uptime) * 1000) : null,
    clients: n(d.num_sta),
    uptimeSeconds: n(d.uptime),
    details: {
      mac,
      serial: d.serial || null,
      typeCode: typeCode || null,
      satisfaction: n(d.satisfaction),
      cpu: n(sys.cpu),
      mem: n(sys.mem),
      userClients: n(d['user-num_sta']),
      guestClients: n(d['guest-num_sta']),
      upgradeTo: d.upgrade_to_firmware || null,
      lastSeenAt: n(d.last_seen) ? new Date(n(d.last_seen) * 1000).toISOString() : null,
      tempC: n(d.general_temperature),
      uplink: d.uplink
        ? {
            type: d.uplink.type || null,
            device: d.uplink.uplink_device_name || d.last_uplink?.uplink_device_name || null,
            port: n(d.uplink.uplink_remote_port ?? d.last_uplink?.uplink_remote_port),
            speed: n(d.uplink.speed),
            fullDuplex: d.uplink.full_duplex ?? null,
          }
        : null,
      radios,
      ports: ports.length
        ? {
            total: ports.length,
            up: ports.filter((p) => p.up).length,
            poeWatts: n(d.total_used_power) ?? ports.reduce((a, p) => a + (Number(p.poe_power) || 0), 0),
          }
        : null,
    },
  };
}

function summarizeHealth(list) {
  const out = {};
  for (const h of Array.isArray(list) ? list : []) {
    if (!h?.subsystem) continue;
    out[h.subsystem] = {
      status: h.status ?? null,
      users: n(h.num_user),
      guests: n(h.num_guest),
      aps: n(h.num_ap),
      switches: n(h.num_sw),
      disconnected: n(h.num_disconnected),
      adopted: n(h.num_adopted),
      wanIp: h.wan_ip ?? null,
      isp: h.isp_name ?? h.isp_organization ?? null,
      latencyMs: n(h.latency),
      downMbps: n(h.xput_down),
      upMbps: n(h.xput_up),
      uptimeSeconds: n(h.uptime),
    };
  }
  return out;
}

function countsFrom(devices) {
  const by = (t) => devices.filter((d) => d.deviceType === t);
  const off = (list) => list.filter((d) => d.status !== 'online').length;
  const aps = by('ap');
  const sws = by('switch');
  const gws = by('gateway');
  return {
    totalDevices: devices.length,
    offlineDevices: off(devices),
    wifiDevices: aps.length,
    offlineWifi: off(aps),
    wiredDevices: sws.length,
    offlineWired: off(sws),
    gatewayDevices: gws.length,
    offlineGateways: off(gws),
    wifiClients: aps.reduce((a, d) => a + (d.clients ?? 0), 0),
    pendingUpdates: devices.filter((d) => d.firmwareStatus === 'updateAvailable').length,
  };
}

// El sitio del controlador local puede no tener el mismo id que la nube:
// se busca por id, despues por controlador + nombre interno, y por la IP LAN.
async function resolveSite(site, hostId, url) {
  const byId = await prisma.unifiSite.findUnique({ where: { id: site.siteId } });
  if (byId) return byId;
  let host = hostId;
  if (!host) {
    const ip = hostOf(url);
    const match = ip
      ? await prisma.unifiSite.findFirst({ where: { OR: [{ lanIps: { has: ip } }, { controllerUrl: url }] } })
      : null;
    host = match?.hostId ?? null;
  }
  if (!host) return null;
  const sameHost = await prisma.unifiSite.findMany({ where: { hostId: host } });
  return sameHost.find((s) => s.siteKey && s.siteKey === site.siteKey) ?? (sameHost.length === 1 ? sameHost[0] : null);
}

async function processReport(server, report) {
  const now = new Date();
  const allDevices = [];
  for (const ctl of report.controllers ?? []) {
    const hostId = ctl.hostId ?? null;
    if (!ctl.ok) {
      if (hostId) {
        await prisma.unifiSite.updateMany({ where: { hostId }, data: { localError: String(ctl.error ?? 'error').slice(0, 300), localSource: server.name } });
      }
      continue;
    }
    for (const site of ctl.sites ?? []) {
      if (!site.siteId || String(site.siteKey).toLowerCase() === 'super') continue;
      const existing = await resolveSite(site, hostId, ctl.url);
      const siteId = existing?.id ?? site.siteId;
      const devices = (site.devices ?? [])
        .map((d) => normalizeLocalDevice(d, { ...site, siteId, hostName: existing?.hostName ?? site.desc }))
        .filter(Boolean);
      allDevices.push(...devices);
      const health = summarizeHealth(site.health);
      const counts = countsFrom(devices);
      counts.wiredClients = health.lan?.users ?? 0;
      counts.guestClients = (health.wlan?.guests ?? 0) + (health.lan?.guests ?? 0);
      const local = {
        ...counts,
        siteKey: site.siteKey ?? existing?.siteKey ?? null,
        localSource: server.name,
        localAt: now,
        localError: null,
        controllerUrl: ctl.url ?? null,
        health,
        ...(ctl.version ? { version: String(ctl.version) } : {}),
        ...(existing ? {} : { hostOnline: true }),
      };
      if (existing) {
        await prisma.unifiSite.update({ where: { id: existing.id }, data: local });
      } else {
        // Controlador que la nube no informa (o sitio nuevo): se crea igual.
        await prisma.unifiSite.create({
          data: {
            id: site.siteId,
            hostId: hostId ?? `local:${ctl.url}`,
            hostName: site.desc && site.desc.toLowerCase() !== 'default' ? site.desc : `${server.name} (local)`,
            siteName: null,
            lastSyncAt: now,
            ...local,
          },
        });
      }
    }
  }
  const notified = allDevices.length ? await syncDevices(allDevices) : 0;
  broadcast({ type: 'UNIFI_UPDATE', lastRun: { at: now, source: server.name } });
  return { devices: allDevices.length, notified };
}

// Estado para Admin: agentes vistos y si pueden recibir la credencial.
function agentStatus() {
  const now = Date.now();
  return [...agentIps.entries()]
    .filter(([, a]) => now - a.at < AGENT_IPS_TTL_MS)
    .map(([id, a]) => ({ serverId: id, name: a.name, https: a.https }));
}

module.exports = { buildTasks, processReport, agentStatus, normalizeLocalDevice, sameSubnet, COUNT_FIELDS };
