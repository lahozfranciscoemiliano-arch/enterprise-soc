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

async function fetchCloudDevices(apiKey) {
  const devices = [];
  let nextToken = null;
  for (let page = 0; page < 20; page += 1) {
    const url = new URL('https://api.ui.com/v1/devices');
    url.searchParams.set('pageSize', '200');
    if (nextToken) url.searchParams.set('nextToken', nextToken);
    // eslint-disable-next-line no-await-in-loop
    const body = await requestJson(url, { apiKey });
    for (const host of body.data ?? []) {
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
    if (mode === 'local') {
      if (!cfg.UNIFI_CONTROLLER_URL) throw new Error('Falta la URL de la consola UniFi (modo local)');
      devices = await fetchLocalDevices(cfg.UNIFI_CONTROLLER_URL, cfg.UNIFI_API_KEY, Boolean(cfg.UNIFI_VERIFY_TLS));
    } else {
      devices = await fetchCloudDevices(cfg.UNIFI_API_KEY);
    }

    const notified = await syncDevices(devices);
    lastRun = {
      at: new Date(),
      mode,
      devices: devices.length,
      online: devices.filter((d) => d.status === 'online').length,
      offline: devices.filter((d) => d.status === 'offline').length,
      notified,
      error: null,
    };
  } catch (err) {
    lastRun = { at: new Date(), mode, devices: 0, online: 0, offline: 0, error: err.message };
    console.error('Error sondeando UniFi:', err.message);
  }

  broadcast({ type: 'UNIFI_UPDATE', lastRun });
  return lastRun;
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

module.exports = { runUnifiPoll, listUnifiDevices, getLastRun, scheduleUnifiPoll, syncDevices, classify, normalizeStatus };
