const prisma = require('../prismaClient');
const { notifyGeneric } = require('./notifications');
const { broadcastFortiEvent } = require('../websocket/socketServer');

// Parsea una linea de syslog de FortiGate: pares key=value separados por
// espacios, con valores entre comillas si tienen espacios adentro
// (formato estandar de FortiOS, no CEF). Ejemplo real:
//   date=2024-01-15 time=10:23:45 devname="FGT-BISTRO" type="event"
//   subtype="vpn" level="notice" srcip=190.1.2.3 user="jperez"
//   msg="SSL VPN login succeeded"
function parseFortiSyslogLine(line) {
  const fields = {};
  const re = /(\w+)=("([^"]*)"|\S+)/g;
  let match;
  let found = false;

  while ((match = re.exec(line)) !== null) {
    found = true;
    const key = match[1];
    const value = match[3] !== undefined ? match[3] : match[2];
    fields[key] = value;
  }

  return found ? fields : null;
}

// NOTA HONESTA: este mapeo cubre los subtype/level mas comunes de FortiOS
// documentados publicamente, pero no se probo contra logs reales de un
// FortiGate de Grupo Bistro (no hay uno disponible en este entorno). Todo lo
// que no matchea cae en OTHER/LOW sin perder el evento (queda el raw
// completo guardado) -- conviene revisar los primeros eventos reales que
// lleguen y ajustar esta funcion si hace falta.
function classifyFortiFields(fields) {
  const type = (fields.type || '').toLowerCase();
  const subtype = (fields.subtype || '').toLowerCase();
  const level = (fields.level || '').toLowerCase();
  const action = (fields.action || '').toLowerCase();

  const LEVEL_TO_SEVERITY = {
    emergency: 'CRITICAL',
    alert: 'CRITICAL',
    critical: 'CRITICAL',
    error: 'HIGH',
    warning: 'MEDIUM',
    notice: 'LOW',
    information: 'LOW',
    debug: 'LOW',
  };

  let eventType = 'OTHER';
  let severity = LEVEL_TO_SEVERITY[level] || 'LOW';

  if (subtype === 'vpn') {
    eventType = action.includes('logout') || (fields.msg || '').toLowerCase().includes('logout') ? 'VPN_LOGOUT' : 'VPN_LOGIN';
  } else if (subtype === 'ips') {
    eventType = 'IPS_ATTACK';
    severity = fields.severity ? String(fields.severity).toUpperCase() : severity || 'HIGH';
  } else if (subtype === 'virus' || subtype === 'antivirus') {
    eventType = 'VIRUS_DETECTED';
    severity = 'HIGH';
  } else if (subtype === 'ha') {
    eventType = 'HA_FAILOVER';
    severity = 'HIGH';
  } else if (type === 'event' && subtype === 'system' && /interface/i.test(fields.msg || '')) {
    eventType = 'INTERFACE_DOWN';
  } else if (subtype === 'admin' || (type === 'event' && subtype === 'system' && (fields.msg || '').toLowerCase().includes('login'))) {
    eventType = 'ADMIN_LOGIN';
  } else if (type === 'event' && subtype === 'config') {
    eventType = 'CONFIG_CHANGE';
    severity = severity === 'LOW' ? 'MEDIUM' : severity;
  } else if (type === 'traffic' && action === 'deny') {
    eventType = 'FIREWALL_DENY';
    severity = 'LOW';
  } else if (type === 'traffic') {
    eventType = 'TRAFFIC_ANOMALY';
  }

  if (!['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(severity)) severity = 'LOW';

  const description = fields.msg || fields.logdesc || `Evento FortiGate (${type || 'desconocido'}/${subtype || 'sin subtipo'})`;

  return {
    type: eventType,
    severity,
    description,
    sourceIp: fields.srcip || fields.remip || null,
    destIp: fields.dstip || null,
  };
}

const NOTIFY_TYPES = new Set(['IPS_ATTACK', 'VIRUS_DETECTED', 'HA_FAILOVER', 'INTERFACE_DOWN']);

async function ingestFortiEvent(device, normalized, raw) {
  const event = await prisma.fortiEvent.create({
    data: {
      deviceId: device.id,
      type: normalized.type,
      severity: normalized.severity,
      description: normalized.description,
      sourceIp: normalized.sourceIp || undefined,
      destIp: normalized.destIp || undefined,
      raw: raw ?? undefined,
    },
  });

  await prisma.fortiDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });

  broadcastFortiEvent({ ...event, deviceName: device.name });

  if (NOTIFY_TYPES.has(normalized.type) || normalized.severity === 'CRITICAL') {
    notifyGeneric({
      severity: normalized.severity,
      subject: `FortiGate ${device.name}: ${normalized.type}`,
      text: normalized.description,
      source: 'fortinet',
      metadata: { deviceName: device.name, sourceIp: normalized.sourceIp, destIp: normalized.destIp },
    }).catch(() => {});
  }

  return event;
}

module.exports = { parseFortiSyslogLine, classifyFortiFields, ingestFortiEvent };
