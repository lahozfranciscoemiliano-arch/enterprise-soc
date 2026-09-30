// Busqueda de fabricante por MAC (como dnschecker.org/mac-lookup), sin
// "desconocidos":
//   1. Registros oficiales de la IEEE: MA-L (24 bits), MA-M (28), MA-S (36) e
//      IAB (36). Los bloques chicos (MA-M/MA-S) son los que usan muchas camaras,
//      NVR, relojes y equipos de punto de venta, y no estan en el oui.txt clasico.
//   2. Si la IEEE no lo tiene: consulta en linea (maclookup.app) con el
//      resultado guardado en la base (tabla mac_vendor_cache).
//   3. MAC aleatoria (bit "administrada localmente"): celulares/Windows con
//      direccion privada; no tiene fabricante por diseño.
// Ademas se estima el tipo de equipo por el fabricante y el nombre.
const https = require('https');
const prisma = require('../prismaClient');

const IEEE_SOURCES = [
  { registry: 'MA-L', bits: 24, url: 'https://standards-oui.ieee.org/oui/oui.csv' },
  { registry: 'MA-M', bits: 28, url: 'https://standards-oui.ieee.org/oui28/mam.csv' },
  { registry: 'MA-S', bits: 36, url: 'https://standards-oui.ieee.org/oui36/oui36.csv' },
  { registry: 'IAB', bits: 36, url: 'https://standards-oui.ieee.org/iab/iab.csv' },
];
const RELOAD_MS = 7 * 86400000;
const ONLINE_URL = 'https://api.maclookup.app/v2/macs/';
const ONLINE_GAP_MS = 1100; // limite gratuito: ~2 consultas/s

// prefijo hexadecimal (6, 7 o 9 caracteres) -> { org, address, country, registry }
const registry = new Map();
const memCache = new Map(); // mac hex12 -> resultado online
let loadedAt = 0;
let loading = null;

function hex12(mac) {
  const h = String(mac ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');
  return h.length === 12 ? h : null;
}

function fmt(h) {
  return h.match(/../g).join(':');
}

// CSV con comillas (las direcciones llevan comas).
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function countryOf(address) {
  const m = String(address ?? '').match(/\b([A-Z]{2})\b(?:\s+[\w-]+)?\s*$/);
  return m ? m[1] : null;
}

function download(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 60000, headers: { 'User-Agent': 'EnterpriseSOC/1.0' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => resolve(body));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function loadRegistries() {
  if (loading) return loading;
  if (Date.now() - loadedAt < RELOAD_MS && registry.size > 0) return null;
  loading = (async () => {
    let total = 0;
    for (const src of IEEE_SOURCES) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const body = await download(src.url);
        const lines = body.split(/\r?\n/);
        for (const line of lines.slice(1)) {
          if (!line.trim()) continue;
          const [reg, assignment, org, address] = parseCsvLine(line);
          const prefix = String(assignment ?? '').toLowerCase();
          if (!/^[0-9a-f]{6,9}$/.test(prefix) || !org) continue;
          registry.set(prefix, { org: org.trim(), address: (address ?? '').replace(/\s+/g, ' ').trim() || null, country: countryOf(address), registry: reg || src.registry });
          total += 1;
        }
      } catch (err) {
        console.warn(`Busqueda MAC: no se pudo descargar ${src.registry} de la IEEE (${err.message})`);
      }
    }
    if (total > 0) {
      loadedAt = Date.now();
      console.log(`Busqueda MAC: ${total} bloques de fabricantes de la IEEE cargados`);
    } else {
      loadedAt = Date.now() - RELOAD_MS + 3600000; // reintenta en 1 h
    }
    loading = null;
  })();
  return loading;
}

function isRandomized(h) {
  return (parseInt(h.slice(0, 2), 16) & 0x02) === 0x02;
}
function isMulticast(h) {
  return (parseInt(h.slice(0, 2), 16) & 0x01) === 0x01;
}

function fromRegistry(h) {
  for (const len of [9, 7, 6]) {
    const hit = registry.get(h.slice(0, len));
    if (hit) return { vendor: hit.org, address: hit.address, country: hit.country, block: hit.registry, prefix: h.slice(0, len), source: 'IEEE' };
  }
  return null;
}

// Tipo de equipo estimado por el fabricante y el nombre.
const KIND_RULES = [
  [/hikvision|dahua|axis comm|reolink|amcrest|uniview|hanwha|vivotek|milesight|ezviz|imou|tiandy/i, 'Cámara / NVR'],
  [/ubiquiti|tp-link|mikrotik|cisco|aruba|fortinet|juniper|netgear|d-link|ruckus|meraki|zyxel|huawei tech.*|h3c|tenda|edimax|cambium|grandstream|linksys/i, 'Equipo de red'],
  [/epson|brother|ricoh|kyocera|lexmark|xerox|canon|konica|zebra|bixolon|star micronics|citizen|sato|toshiba tec|sharp/i, 'Impresora'],
  [/apple|samsung|xiaomi|motorola|oppo|vivo mobile|oneplus|realme|google|huawei device|honor|nokia|lg electronics/i, 'Celular / tablet'],
  [/vmware|microsoft|xensource|red hat|qemu|parallels|oracle.*virtual/i, 'Máquina virtual'],
  [/ingenico|verifone|pax tech|newland|castles|honeywell|datalogic|symbol|posiflex|ncr|par tech|elo touch/i, 'Punto de venta / lector'],
  [/espressif|tuya|shelly|sonoff|itead|broadlink|raspberry|arduino|particle/i, 'IoT / automatización'],
  [/dell|lenovo|hewlett|hp inc|asustek|micro-star|giga-byte|gigabyte|intel|realtek|hon hai|foxconn|acer|biostar|asrock|liteon|azurewave|quanta|compal|wistron|pegatron|elitegroup/i, 'PC / notebook'],
  [/synology|qnap|western digital|seagate|netapp/i, 'Almacenamiento (NAS)'],
  [/polycom|yealink|grandstream|avaya|snom|fanvil/i, 'Teléfono IP'],
  [/zkteco|suprema|anviz|hikvision.*access/i, 'Control de acceso / reloj'],
];
function guessKind(vendor, hostname) {
  const h = String(hostname ?? '');
  if (/^(nvr|dvr|cam|ipc)/i.test(h)) return 'Cámara / NVR';
  if (/print|impr|prn|mfp/i.test(h)) return 'Impresora';
  if (/^(ap|sw|fw|fg|rt|router|switch)[-_\d]/i.test(h)) return 'Equipo de red';
  if (/iphone|android|galaxy|redmi|moto/i.test(h)) return 'Celular / tablet';
  for (const [re, kind] of KIND_RULES) if (re.test(String(vendor ?? ''))) return kind;
  return null;
}

// Resultado rapido (sincronico): IEEE + cache en memoria. Para listas.
function quickLookup(mac) {
  const h = hex12(mac);
  if (!h) return null;
  loadRegistries();
  if (isRandomized(h)) return { vendor: 'MAC aleatoria (celular / privacidad)', randomized: true, source: 'local' };
  return fromRegistry(h) ?? memCache.get(h) ?? null;
}

async function cacheGet(h) {
  const rows = await prisma.macVendorCache.findMany({ where: { prefix: { in: [h.slice(0, 9), h.slice(0, 7), h.slice(0, 6), h] } } });
  if (!rows.length) return null;
  const best = rows.sort((a, b) => b.prefix.length - a.prefix.length)[0];
  if (!best.vendor) return { vendor: null, source: 'online', notFound: true };
  return { vendor: best.vendor, address: best.address, country: best.country, block: best.block, prefix: best.prefix, source: best.source };
}

let lastOnline = 0;
async function onlineLookup(h) {
  const wait = lastOnline + ONLINE_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastOnline = Date.now();
  const body = await new Promise((resolve, reject) => {
    const req = https.get(`${ONLINE_URL}${fmt(h)}`, { timeout: 8000, headers: { 'User-Agent': 'EnterpriseSOC/1.0' } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        data += c;
      });
      res.on('end', () => (res.statusCode === 200 ? resolve(data) : reject(new Error(`HTTP ${res.statusCode}`))));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
  const j = JSON.parse(body);
  const found = Boolean(j.found && j.company);
  const prefix = String(j.macPrefix ?? '').toLowerCase().replace(/[^0-9a-f]/g, '') || h.slice(0, 6);
  const result = found
    ? { vendor: j.company, address: j.address || null, country: j.country || countryOf(j.address), block: j.blockType || null, prefix, source: 'maclookup.app' }
    : { vendor: null, source: 'online', notFound: true };
  await prisma.macVendorCache
    .upsert({
      where: { prefix: found ? prefix : h.slice(0, 6) },
      create: { prefix: found ? prefix : h.slice(0, 6), vendor: result.vendor, address: result.address ?? null, country: result.country ?? null, block: result.block ?? null, source: 'maclookup.app' },
      update: { vendor: result.vendor, address: result.address ?? null, country: result.country ?? null, block: result.block ?? null, updatedAt: new Date() },
    })
    .catch(() => null);
  if (found) memCache.set(h, result);
  return result;
}

// Busqueda completa (la de la herramienta "MAC Lookup").
async function lookupMac(mac, { online = true } = {}) {
  const h = hex12(mac);
  if (!h) return null;
  await loadRegistries();
  const base = {
    mac: fmt(h),
    oui: fmt(h.slice(0, 6)),
    randomized: isRandomized(h),
    multicast: isMulticast(h),
    administration: isRandomized(h) ? 'Local (aleatoria / privada)' : 'Universal (asignada por el fabricante)',
    transmission: isMulticast(h) ? 'Multicast' : 'Unicast',
  };
  if (base.randomized) {
    return {
      ...base,
      vendor: null,
      source: 'local',
      note: 'MAC aleatoria: la usan celulares y Windows con "direcciones privadas" para no ser rastreados. No tiene fabricante; identificar el equipo por nombre, IP o usuario.',
      kind: 'Celular / tablet (probable)',
    };
  }
  let hit = fromRegistry(h) ?? memCache.get(h) ?? (await cacheGet(h));
  if ((!hit || hit.notFound) && online && !hit?.notFound) {
    try {
      hit = await onlineLookup(h);
    } catch (err) {
      hit = { vendor: null, source: 'error', error: err.message };
    }
  }
  const device = await prisma.netDevice.findUnique({ where: { mac: fmt(h) } });
  return {
    ...base,
    vendor: hit?.vendor ?? null,
    address: hit?.address ?? null,
    country: hit?.country ?? null,
    block: hit?.block ?? null,
    prefix: hit?.prefix ? `${hit.prefix.toUpperCase().match(/.{1,2}/g).join(':')}/${hit.prefix.length * 4}` : null,
    source: hit?.source ?? null,
    kind: guessKind(hit?.vendor, device?.hostname),
    note: hit?.vendor ? null : 'Prefijo sin registrar en la IEEE ni en la base en línea (equipo genérico, clon o MAC modificada).',
  };
}

// Completa en segundo plano el fabricante de los equipos que quedaron sin
// identificar (consulta en linea, 1 por segundo, 60 por vuelta).
async function enrichUnknownVendors(limit = 60) {
  await loadRegistries();
  const rows = await prisma.netDevice.findMany({ where: { vendor: null, randomized: false }, take: 500, orderBy: { lastSeenAt: 'desc' } });
  let fixed = 0;
  let online = 0;
  for (const d of rows) {
    const h = hex12(d.mac);
    if (!h) continue;
    let hit = fromRegistry(h) ?? memCache.get(h);
    if (!hit) {
      // eslint-disable-next-line no-await-in-loop
      hit = await cacheGet(h);
      if (!hit && online < limit) {
        online += 1;
        try {
          // eslint-disable-next-line no-await-in-loop
          hit = await onlineLookup(h);
        } catch {
          hit = null;
        }
      }
    }
    if (hit?.vendor) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.netDevice.update({ where: { mac: d.mac }, data: { vendor: hit.vendor } });
      fixed += 1;
    }
  }
  if (fixed) console.log(`Busqueda MAC: ${fixed} equipo(s) identificados (fabricante completado)`);
  return fixed;
}

function scheduleMacEnrichment() {
  loadRegistries();
  setTimeout(() => enrichUnknownVendors().catch(() => null), 60000);
  setInterval(() => enrichUnknownVendors().catch(() => null), 15 * 60000);
}

module.exports = { lookupMac, quickLookup, guessKind, enrichUnknownVendors, scheduleMacEnrichment, loadRegistries };
