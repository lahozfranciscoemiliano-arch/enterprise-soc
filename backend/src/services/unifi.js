// Ubiquiti UniFi: estado de los Access Points (y switches/gateways UniFi)
// registrados en la cuenta, sondeado cada 2 minutos.
//
// Dos modos (Admin -> Configuracion -> UniFi):
//   - "cloud": Site Manager API (https://api.ui.com/v1/devices) con una API
//     key creada en unifi.ui.com -> API. Funciona desde la VPS sin abrir
//     nada en las sucursales, para consolas registradas en la cuenta UI.
//   - "local": Integration API de la consola UniFi Network
//     ({consola}/proxy/network/integration/v1) con una API key creada en la
//     consola (Settings -> Control Plane -> Integrations). Da tambien la
//     cantidad de clientes por AP, pero la VPS tiene que llegar a la consola.
//
// Un AP caido se avisa UNA vez por caida (notifiedOffline) por los mismos
// canales que las alertas, y otra vez cuando vuelve.
const https = require('https');
const prisma = require('../prismaClient');
const { getSettings } = require('./settings');
const { notifyGeneric } = require('./notifications');
const { broadcast } = require('../websocket/socketServer');

const POLL_INTERVAL_MS = 2 * 60 * 1000;
const OFFLINE_GRACE_MS = 3 * 60 * 1000; // no avisar por un reinicio/actualizacion de firmware
const STALE_DELETE_DAYS = 7; // dispositivos que ya no devuelve la API

let lastRun = null; // { at, mode, devices, online, offline, error }

function getLastRun() {
  return lastRun;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function requestJson(url, { apiKey, verifyTls = true, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'GET',
        headers: { 'X-API-KEY': apiKey, Accept: 'application/json' },
        // Las consolas locales traen un certificado autofirmado.
        rejectUnauthorized: verifyTls,
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 20 * 1024 * 1024) req.destroy(new Error('Respuesta de UniFi demasiado grande'));
        });
        res.on('end', () => {
          if (res.statusCode === 401 || res.statusCode === 403) {
            reject(new Error(`UniFi rechazó la API key (HTTP ${res.statusCode})`));
            return;
          }
          if (res.statusCode === 429) {
            reject(new Error('UniFi limitó las consultas (HTTP 429); se reintenta en el próximo ciclo'));
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`UniFi respondió HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error('UniFi devolvió una respuesta que no es JSON'));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Tiempo de espera agotado consultando UniFi')));
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Normalizacion
// ---------------------------------------------------------------------------
function classify({ model, shortname, name, features, isConsole }) {
  const f = (features ?? []).map((x) => String(x).toLowerCase());
  if (f.includes('accesspoint')) return 'ap';
  if (f.includes('switching')) return 'switch';
  if (isConsole) return 'gateway';
  const text = `${shortname ?? ''} ${model ?? ''}`.toUpperCase();
  if (/\b(UDM|UDR|UXG|USG|UCG|UDW|UX7?|EFG|UCK)/.test(text)) return 'gateway';
  if (/\b(USW|US-|US\d|USL|USMINI|USF)/.test(text)) return 'switch';
  if (/\b(UAP|U6|U7|UAL|UK-|E7|NANOHD|FLEXHD|BEACONHD|IW-|UWB|UMA|AP)/.test(text) || /\bAP\b/i.test(name ?? '')) return 'ap';
  return 'other';
}

function normalizeStatus(value) {
  const v = String(value ?? '').toLowerCase();
  if (v === 'online' || v === 'connected') return 'online';
  if (v === 'offline' || v === 'disconnected' || v === 'connection_interrupted' || v === 'isolated') return 'offline';
  return v || 'unknown'; // updating, adopting, pending_adoption, getting_ready...
}

async function fetchCloudDevices(apiKey, hostNames = new Map()) {
  const devices = [];
  let nextToken = null;
  for (let page = 0; page < 20; page += 1) {
    const url = new URL('https://api.ui.com/v1/devices');
    url.searchParams.set('pageSize', '200');
    if (nextToken) url.searchParams.set('nextToken', nextToken);
    // eslint-disable-next-line no-await-in-loop
    const body = await requestJson(url, { apiKey });
    for (const host of body.data ?? []) {
      if (host.hostId && host.hostName) hostNames.set(host.hostId, host.hostName);
      for (const d of host.devices ?? []) {
        const mac = String(d.mac ?? d.id ?? '').toLowerCase();
        if (!mac) continue;
        devices.push({
          id: mac,
          name: d.name || d.model || mac,
          model: d.model || d.shortname || null,
          deviceType: classify(d),
          ipAddress: d.ip || null,
          status: normalizeStatus(d.status),
          siteName: host.hostName || null,
          hostName: host.hostName || null,
          firmwareVersion: d.version || null,
          firmwareStatus: d.firmwareStatus || (d.updateAvailable ? 'updateAvailable' : null),
          startupTime: d.startupTime ? new Date(d.startupTime) : null,
          clients: null,
          uptimeSeconds: d.startupTime ? Math.max(0, Math.round((Date.now() - new Date(d.startupTime).getTime()) / 1000)) : null,
        });
      }
    }
    nextToken = body.nextToken;
    if (!nextToken) break;
  }
  return devices;
}

async function fetchCloudList(path, apiKey) {
  const items = [];
  let nextToken = null;
  for (let page = 0; page < 20; page += 1) {
    const url = new URL(`https://api.ui.com${path}`);
    url.searchParams.set('pageSize', '200');
    if (nextToken) url.searchParams.set('nextToken', nextToken);
    // eslint-disable-next-line no-await-in-loop
    const body = await requestJson(url, { apiKey });
    items.push(...(body.data ?? []));
    nextToken = body.nextToken;
    if (!nextToken) break;
  }
  return items;
}

function hostOnline(host) {
  const rs = host.reportedState ?? {};
  const state = String(rs.state ?? rs.status ?? host.state ?? '').toLowerCase();
  if (['connected', 'online', 'ok', 'running'].includes(state)) return true;
  if (['disconnected', 'offline', 'unreachable', 'down'].includes(state)) return false;
  if (host.isBlocked) return false;
  return null;
}

function hostVersion(host) {
  const rs = host.reportedState ?? {};
  const network = Array.isArray(rs.controllers) ? rs.controllers.find((c) => c.name === 'network') : null;
  return {
    version: network?.version ?? rs.version ?? rs.firmwareVersion ?? null,
    updateAvailable: network?.updateAvailable ?? (rs.firmwareUpdate?.latestAvailableVersion ? true : null) ?? null,
  };
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// IPs privadas (LAN) del controlador que informa la nube: el agente de la
// sucursal en esa misma red es el que lo consulta localmente.
const PRIVATE_IPV4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)\d+\.\d+(\.\d+)?$/;
function hostLanIps(host) {
  const rs = host.reportedState ?? {};
  const candidates = [host.ipAddress, rs.ip, rs.ipAddress, rs.lanIp, ...(Array.isArray(rs.ipAddrs) ? rs.ipAddrs : [])];
  for (const iface of Array.isArray(rs.interfaces) ? rs.interfaces : []) {
    candidates.push(iface?.ip, iface?.ipv4, ...(Array.isArray(iface?.ips) ? iface.ips : []));
  }
  return [...new Set(candidates.map((ip) => String(ip ?? '').split('/')[0].trim()).filter((ip) => PRIVATE_IPV4.test(ip)))].slice(0, 8);
}

// "super" es el sitio interno de administracion de los controladores
// autoalojados: no tiene equipos y aparecia duplicando cada sucursal.
function isInternalSite(site) {
  const name = String(site.meta?.name ?? '').toLowerCase();
  const desc = String(site.meta?.desc ?? '').toLowerCase();
  return name === 'super' || desc === 'super';
}

// Resumen por sitio: /v1/hosts (estado del controlador) + /v1/sites
// (contadores de equipos y clientes). Unico dato disponible para
// controladores "Network Server" autoalojados.
async function fetchCloudSites(apiKey, hostNames) {
  const [hosts, sites] = await Promise.all([fetchCloudList('/v1/hosts', apiKey), fetchCloudList('/v1/sites', apiKey)]);
  const hostById = new Map(hosts.map((h) => [h.id, h]));
  const realSites = sites.filter((site) => !isInternalSite(site));
  const sitesPerHost = new Map();
  for (const site of realSites) sitesPerHost.set(site.hostId, (sitesPerHost.get(site.hostId) ?? 0) + 1);

  const rows = realSites.map((site) => {
    const host = hostById.get(site.hostId) ?? {};
    const rs = host.reportedState ?? {};
    const counts = site.statistics?.counts ?? {};
    const hostName = hostNames.get(site.hostId) || rs.name || rs.hostname || host.userData?.name || site.hostId;
    const desc = site.meta?.desc || site.meta?.name || null;
    const { version, updateAvailable } = hostVersion(host);
    return {
      id: site.siteId,
      hostId: site.hostId,
      hostName,
      hostType: host.type ?? rs.host_type ?? null,
      siteKey: site.meta?.name ?? null,
      lanIps: hostLanIps(host),
      // Con un solo sitio por controlador ("Default") alcanza con el nombre del host.
      siteName: sitesPerHost.get(site.hostId) > 1 && desc ? desc : null,
      hostOnline: hostOnline(host),
      version,
      updateAvailable,
      totalDevices: num(counts.totalDevice),
      offlineDevices: num(counts.offlineDevice),
      wifiDevices: num(counts.wifiDevice),
      offlineWifi: num(counts.offlineWifiDevice),
      wiredDevices: num(counts.wiredDevice),
      offlineWired: num(counts.offlineWiredDevice),
      gatewayDevices: num(counts.gatewayDevice),
      offlineGateways: num(counts.offlineGatewayDevice),
      wifiClients: num(counts.wifiClient),
      wiredClients: num(counts.wiredClient),
      guestClients: num(counts.guestClient),
      pendingUpdates: num(counts.pendingUpdateDevice),
      criticalAlerts: num(counts.criticalNotification),
      ispName: site.statistics?.ispInfo?.name ?? site.statistics?.ispInfo?.organization ?? null,
      wanUptime: site.statistics?.percentages?.wanUptime ?? null,
      txRetry: site.statistics?.percentages?.txRetry ?? null,
    };
  });

  // Diagnostico sin datos sensibles: solo nombres de campos, para ajustar el
  // parseo si Ubiquiti cambia el formato.
  const diag = {
    hosts: hosts.length,
    sites: sites.length,
    hostTypes: [...new Set(hosts.map((h) => h.type).filter(Boolean))],
    reportedStateKeys: Object.keys(hosts[0]?.reportedState ?? {}).slice(0, 40),
    siteCountKeys: Object.keys(sites[0]?.statistics?.counts ?? {}),
  };
  return { rows, diag };
}

const COUNT_FIELDS = [
  'totalDevices', 'offlineDevices', 'wifiDevices', 'offlineWifi', 'wiredDevices', 'offlineWired',
  'gatewayDevices', 'offlineGateways', 'wifiClients', 'wiredClients', 'guestClients', 'pendingUpdates',
];
function pickCounts(row) {
  return Object.fromEntries(COUNT_FIELDS.map((k) => [k, row[k]]));
}

async function syncSites(rows) {
  const now = new Date();
  const existing = new Map((await prisma.unifiSite.findMany()).map((s) => [s.id, s]));
  const notifications = [];
  const tz = process.env.APP_TIMEZONE || undefined;

  const LOCAL_FRESH_MS = 10 * 60 * 1000;
  for (const raw of rows) {
    const prev = existing.get(raw.id);
    // Si el agente de la sucursal leyo el controlador hace poco, sus
    // contadores (exactos, equipo por equipo) mandan sobre el resumen de la
    // nube, y las caidas las avisa cada equipo (syncDevices).
    const localFresh = prev?.localAt && now - prev.localAt < LOCAL_FRESH_MS;
    const r = localFresh ? { ...raw, ...pickCounts(prev) } : raw;
    const data = {
      ...r,
      lastSyncAt: now,
      devicesDownSince: r.offlineDevices > 0 ? prev?.devicesDownSince ?? now : null,
      notifiedDown: prev?.notifiedDown ?? 0,
      hostOfflineSince: r.hostOnline === false ? prev?.hostOfflineSince ?? now : null,
      notifiedHostDown: prev?.notifiedHostDown ?? false,
    };
    const label = r.siteName ? `${r.hostName} (${r.siteName})` : r.hostName;

    // Controlador del sitio desconectado de la nube (PC/servidor apagado o sin internet).
    if (r.hostOnline === false && !data.notifiedHostDown && now - data.hostOfflineSince >= OFFLINE_GRACE_MS) {
      data.notifiedHostDown = true;
      notifications.push({
        severity: 'HIGH',
        subject: `UniFi: controlador de "${label}" desconectado`,
        text: `El controlador UniFi Network de ${label} no reporta a unifi.ui.com desde ${data.hostOfflineSince.toLocaleString('es', { timeZone: tz })}. Mientras tanto no se ve el estado de sus Access Points: revisar que el equipo donde corre esté encendido y con internet.`,
      });
    } else if (r.hostOnline === true && data.notifiedHostDown) {
      data.notifiedHostDown = false;
      notifications.push({ severity: 'HIGH', subject: `UniFi: controlador de "${label}" reconectado`, text: `${label} volvió a reportar.` });
    }

    // Equipos caidos en el sitio: aviso cuando aparecen (o aumentan) y al normalizarse.
    if (r.hostOnline !== false && !localFresh) {
      if (r.offlineDevices > data.notifiedDown && now - data.devicesDownSince >= OFFLINE_GRACE_MS) {
        data.notifiedDown = r.offlineDevices;
        const parts = [
          r.offlineWifi && `${r.offlineWifi} Access Point(s)`,
          r.offlineWired && `${r.offlineWired} switch(es)`,
          r.offlineGateways && `${r.offlineGateways} gateway(s)`,
        ].filter(Boolean);
        notifications.push({
          severity: r.offlineGateways ? 'CRITICAL' : 'HIGH',
          subject: `UniFi: ${r.offlineDevices} equipo(s) caído(s) en ${label}`,
          text: `${label}: ${parts.join(', ') || `${r.offlineDevices} equipo(s)`} sin conexión (de ${r.totalDevices}). Revisar energía/PoE y el cable hacia el switch.`,
        });
      } else if (r.offlineDevices === 0 && data.notifiedDown > 0) {
        data.notifiedDown = 0;
        notifications.push({ severity: 'HIGH', subject: `UniFi: ${label} sin equipos caídos`, text: `Todos los equipos UniFi de ${label} volvieron a estar online.` });
      }
    }

    // eslint-disable-next-line no-await-in-loop
    await prisma.unifiSite.upsert({ where: { id: r.id }, create: data, update: data });
  }
  await prisma.unifiSite.deleteMany({ where: { lastSyncAt: { lt: new Date(now.getTime() - STALE_DELETE_DAYS * 86400000) } } });
  // Sitios que la nube ya no informa (p. ej. los "super" internos) y que
  // ningun agente leyo en la ultima media hora.
  if (rows.length > 0) {
    await prisma.unifiSite.deleteMany({
      where: {
        id: { notIn: rows.map((r) => r.id) },
        OR: [{ localAt: null }, { localAt: { lt: new Date(now.getTime() - 30 * 60 * 1000) } }],
      },
    });
  }

  for (const n of notifications) notifyGeneric({ ...n, source: 'unifi' }).catch(() => {});
  return notifications.length;
}

async function fetchPaged(baseUrl, opts) {
  const items = [];
  for (let offset = 0; offset < 5000; offset += 200) {
    const url = new URL(baseUrl);
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('limit', '200');
    // eslint-disable-next-line no-await-in-loop
    const body = await requestJson(url, opts);
    const data = body.data ?? [];
    items.push(...data);
    const total = body.totalCount ?? data.length;
    if (data.length === 0 || items.length >= total) break;
  }
  return items;
}

async function fetchLocalDevices(controllerUrl, apiKey, verifyTls) {
  const base = `${controllerUrl.replace(/\/+$/, '')}/proxy/network/integration/v1`;
  const opts = { apiKey, verifyTls };
  const sites = await fetchPaged(`${base}/sites`, opts);
  const devices = [];

  for (const site of sites) {
    // eslint-disable-next-line no-await-in-loop
    const [siteDevices, clients] = await Promise.all([
      fetchPaged(`${base}/sites/${site.id}/devices`, opts),
      fetchPaged(`${base}/sites/${site.id}/clients`, opts).catch(() => []),
    ]);
    const clientsPerDevice = new Map();
    for (const c of clients) {
      if (c.uplinkDeviceId) clientsPerDevice.set(c.uplinkDeviceId, (clientsPerDevice.get(c.uplinkDeviceId) ?? 0) + 1);
    }

    for (const d of siteDevices) {
      const mac = String(d.macAddress ?? d.id ?? '').toLowerCase();
      if (!mac) continue;
      devices.push({
        id: mac,
        name: d.name || d.model || mac,
        model: d.model || null,
        deviceType: classify(d),
        ipAddress: d.ipAddress || null,
        status: normalizeStatus(d.state),
        siteName: site.name || null,
        hostName: site.name || null,
        firmwareVersion: d.firmwareVersion || null,
        firmwareStatus: d.firmwareUpdatable ? 'updateAvailable' : null,
        startupTime: null,
        clients: clientsPerDevice.get(d.id) ?? 0,
        uptimeSeconds: null,
      });
    }
  }
  return devices;
}

// ---------------------------------------------------------------------------
// Sincronizacion
// ---------------------------------------------------------------------------
const TYPE_LABEL = { ap: 'Access Point', switch: 'Switch', gateway: 'Gateway', other: 'Dispositivo' };

async function syncDevices(devices) {
  const now = new Date();
  const existing = new Map((await prisma.unifiDevice.findMany()).map((d) => [d.id, d]));
  const notifications = [];

  for (const d of devices) {
    const prev = existing.get(d.id);
    const statusChanged = !prev || prev.status !== d.status;
    const data = {
      ...d,
      lastSyncAt: now,
      statusChangedAt: statusChanged ? now : prev.statusChangedAt,
      lastSeenOnlineAt: d.status === 'online' ? now : prev?.lastSeenOnlineAt ?? null,
      notifiedOffline: prev?.notifiedOffline ?? false,
    };

    const offlineSince = data.statusChangedAt;
    if (d.status === 'offline' && !data.notifiedOffline && now - offlineSince >= OFFLINE_GRACE_MS) {
      data.notifiedOffline = true;
      notifications.push({
        severity: d.deviceType === 'ap' ? 'HIGH' : 'CRITICAL',
        subject: `UniFi: ${TYPE_LABEL[d.deviceType]} "${d.name}" CAÍDO${d.siteName ? ` (${d.siteName})` : ''}`,
        text: `${TYPE_LABEL[d.deviceType]} ${d.name} (${d.model ?? 'modelo desconocido'}, ${d.ipAddress ?? 'sin IP'}) está offline desde ${offlineSince.toLocaleString('es', { timeZone: process.env.APP_TIMEZONE || undefined })}. Revisar energía/PoE y el cable hacia el switch.`,
        metadata: { mac: d.id, siteName: d.siteName, status: d.status },
      });
    } else if (d.status === 'online' && data.notifiedOffline) {
      data.notifiedOffline = false;
      const downMinutes = prev?.statusChangedAt ? Math.round((now - prev.statusChangedAt) / 60000) : null;
      notifications.push({
        severity: d.deviceType === 'ap' ? 'HIGH' : 'CRITICAL',
        subject: `UniFi: ${TYPE_LABEL[d.deviceType]} "${d.name}" restablecido`,
        text: `${d.name} volvió a estar online${downMinutes !== null ? ` después de ~${downMinutes} min` : ''}.`,
        metadata: { mac: d.id, siteName: d.siteName, status: d.status },
      });
    }

    // eslint-disable-next-line no-await-in-loop
    await prisma.unifiDevice.upsert({ where: { id: d.id }, create: data, update: data });
  }

  await prisma.unifiDevice.deleteMany({
    where: { lastSyncAt: { lt: new Date(now.getTime() - STALE_DELETE_DAYS * 86400000) } },
  });

  for (const n of notifications) {
    notifyGeneric({ ...n, source: 'unifi' }).catch(() => {});
  }
  return notifications.length;
}

async function runUnifiPoll() {
  const cfg = await getSettings(['UNIFI_MODE', 'UNIFI_API_KEY', 'UNIFI_CONTROLLER_URL', 'UNIFI_VERIFY_TLS']);
  const mode = cfg.UNIFI_MODE || (cfg.UNIFI_API_KEY ? 'cloud' : 'off');
  if (mode === 'off' || !cfg.UNIFI_API_KEY) {
    lastRun = { at: new Date(), mode: 'off', devices: 0, online: 0, offline: 0, error: null };
    return lastRun;
  }

  try {
    let devices;
    let siteRows = [];
    let diag = null;
    if (mode === 'local') {
      if (!cfg.UNIFI_CONTROLLER_URL) throw new Error('Falta la URL de la consola UniFi (modo local)');
      devices = await fetchLocalDevices(cfg.UNIFI_CONTROLLER_URL, cfg.UNIFI_API_KEY, Boolean(cfg.UNIFI_VERIFY_TLS));
    } else {
      const hostNames = new Map();
      devices = await fetchCloudDevices(cfg.UNIFI_API_KEY, hostNames);
      ({ rows: siteRows, diag } = await fetchCloudSites(cfg.UNIFI_API_KEY, hostNames));
    }

    const notified = (await syncDevices(devices)) + (siteRows.length ? await syncSites(siteRows) : 0);
    // Sin lista de equipos (controladores autoalojados), los totales salen
    // de los contadores de cada sitio.
    const fromSites = devices.length === 0 && siteRows.length > 0;
    const sum = (k) => siteRows.reduce((a, r) => a + r[k], 0);
    lastRun = {
      at: new Date(),
      mode,
      devices: fromSites ? sum('totalDevices') : devices.length,
      online: fromSites ? sum('totalDevices') - sum('offlineDevices') : devices.filter((d) => d.status === 'online').length,
      offline: fromSites ? sum('offlineDevices') : devices.filter((d) => d.status === 'offline').length,
      sites: siteRows.length,
      sitesOffline: siteRows.filter((r) => r.hostOnline === false).length,
      detail: fromSites ? 'sites' : 'devices',
      notified,
      diag,
      error: null,
    };
  } catch (err) {
    lastRun = { at: new Date(), mode, devices: 0, online: 0, offline: 0, error: err.message };
    console.error('Error sondeando UniFi:', err.message);
  }

  broadcast({ type: 'UNIFI_UPDATE', lastRun });
  return lastRun;
}

async function listUnifiSites() {
  return prisma.unifiSite.findMany({ orderBy: [{ hostName: 'asc' }] });
}

async function listUnifiDevices() {
  return prisma.unifiDevice.findMany({ orderBy: [{ siteName: 'asc' }, { name: 'asc' }] });
}

function scheduleUnifiPoll() {
  setTimeout(() => {
    runUnifiPoll().catch((err) => console.error('Error en el sondeo UniFi', err));
    setInterval(() => {
      runUnifiPoll().catch((err) => console.error('Error en el sondeo UniFi', err));
    }, POLL_INTERVAL_MS);
  }, 20 * 1000);
}

module.exports = { COUNT_FIELDS, hostLanIps, isInternalSite, runUnifiPoll, listUnifiDevices, listUnifiSites, syncSites, fetchCloudSites, getLastRun, scheduleUnifiPoll, syncDevices, classify, normalizeStatus };
