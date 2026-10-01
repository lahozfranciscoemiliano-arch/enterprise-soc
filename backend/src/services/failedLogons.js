// Detalle de los inicios de sesion fallidos (evento 4625) que manda el agente:
// traduce el tipo de inicio de sesion y el motivo del fallo, identifica cada
// IP interna con el inventario (equipo, usuario, fabricante) y arma un
// resumen legible de DE DONDE vienen los intentos.
const prisma = require('../prismaClient');

const LOGON_TYPE = {
  2: 'Local (teclado)',
  3: 'Red (carpetas compartidas / SMB)',
  4: 'Tarea programada',
  5: 'Servicio de Windows',
  7: 'Desbloqueo de pantalla',
  8: 'Red con contraseña en texto (IIS / básica)',
  9: 'RunAs con otras credenciales',
  10: 'Escritorio remoto (RDP)',
  11: 'Credenciales en caché',
};

const REASON = {
  '0xc000006a': 'contraseña incorrecta',
  '0xc0000064': 'el usuario no existe',
  '0xc000006d': 'usuario o contraseña incorrectos',
  '0xc0000072': 'cuenta deshabilitada',
  '0xc0000234': 'cuenta bloqueada',
  '0xc0000071': 'contraseña vencida',
  '0xc0000193': 'cuenta vencida',
  '0xc0000224': 'debe cambiar la contraseña',
  '0xc000006f': 'fuera del horario permitido',
  '0xc0000070': 'equipo no permitido para ese usuario',
  '0xc000015b': 'tipo de inicio de sesión no permitido',
  '0xc0000133': 'reloj desfasado con el dominio',
  '0xc0000413': 'bloqueado por el firewall de autenticación',
  '0xc000005e': 'no hay servidor de inicio de sesión disponible',
  '0xc00000dc': 'servidor de dominio en estado inválido',
};

function logonTypeLabel(t) {
  return LOGON_TYPE[Number(t)] ?? `tipo ${t}`;
}
function reasonLabel(code) {
  return REASON[String(code ?? '').toLowerCase()] ?? String(code ?? '?');
}
function topKey(obj) {
  return Object.entries(obj ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

// Completa cada origen con lo que el NOC sabe de esa IP / nombre de equipo.
async function enrichFailedLogons(detail) {
  if (!detail || !Array.isArray(detail.sources)) return detail;
  const ips = detail.sources.map((s) => s.ip).filter(Boolean);
  const names = detail.sources.map((s) => s.workstation).filter(Boolean);
  const [endpoints, devices, servers] = await Promise.all([
    prisma.endpoint.findMany({
      where: { OR: [{ ipAddress: { in: ips } }, { hostname: { in: names } }] },
      select: { hostname: true, ipAddress: true, lastUser: true, macAddress: true, os: true },
    }),
    prisma.netDevice.findMany({ where: { ip: { in: ips } }, select: { ip: true, mac: true, hostname: true, vendor: true } }),
    prisma.server.findMany({ where: { ipAddress: { in: ips } }, select: { name: true, ipAddress: true } }),
  ]);
  const epByIp = new Map(endpoints.filter((e) => e.ipAddress).map((e) => [e.ipAddress, e]));
  const epByName = new Map(endpoints.map((e) => [e.hostname, e]));
  const devByIp = new Map(devices.map((d) => [d.ip, d]));
  const srvByIp = new Map(servers.map((s) => [s.ipAddress, s]));
  return {
    ...detail,
    sources: detail.sources.map((s) => {
      const ep = (s.ip && epByIp.get(s.ip)) || (s.workstation && epByName.get(s.workstation)) || null;
      const dev = s.ip ? devByIp.get(s.ip) : null;
      const srv = s.ip ? srvByIp.get(s.ip) : null;
      const mainType = topKey(s.logonTypes);
      const mainReason = topKey(s.reasons);
      return {
        ...s,
        hostname: s.workstation ?? srv?.name ?? ep?.hostname ?? dev?.hostname ?? null,
        knownAs: srv ? `servidor ${srv.name}` : ep ? `equipo del dominio ${ep.hostname}` : dev?.hostname ?? null,
        domainUser: ep?.lastUser ?? null,
        mac: ep?.macAddress ?? dev?.mac ?? null,
        vendor: dev?.vendor ?? null,
        mainType,
        mainTypeLabel: mainType ? logonTypeLabel(mainType) : null,
        mainReason,
        mainReasonLabel: mainReason ? reasonLabel(mainReason) : null,
      };
    }),
  };
}

function describeSource(s) {
  const where = s.public
    ? `INTERNET ${s.ip}`
    : [s.hostname, s.ip].filter(Boolean).join(' / ') || 'origen local (sin IP: proceso del propio servidor)';
  const user = s.users?.[0]?.name ? ` usuario "${s.users[0].name}"` : '';
  const via = s.mainTypeLabel ? ` por ${s.mainTypeLabel}` : '';
  const why = s.mainReasonLabel ? ` (${s.mainReasonLabel})` : '';
  const proc = s.processes?.[0]?.name ? ` · proceso ${s.processes[0].name}` : '';
  return `${where} →${user}${via}${why} ×${s.count}${proc}`;
}

// Texto de la alerta + severidad sugerida.
function summarizeFailedLogons(serverName, total, detail) {
  if (!detail?.sources?.length) {
    return {
      description: `${serverName}: ${total} inicios de sesión fallidos en 24 hs — posible fuerza bruta (RDP) o una credencial vieja guardada en algún servicio.`,
      fromInternet: false,
    };
  }
  const internet = detail.sources.filter((s) => s.public);
  const top = detail.sources.slice(0, 3).map(describeSource);
  const single = detail.sources.length === 1 && detail.sources[0].users?.length === 1;
  let hint;
  if (internet.length) {
    hint = `Hay intentos DESDE INTERNET (${internet.length} IP pública/s): el escritorio remoto o algún puerto está expuesto. Cerrarlo en la FortiGate y usar la VPN.`;
  } else if (single && ['0xc000006a', '0xc0000234', '0xc0000071'].includes(detail.sources[0].mainReason)) {
    hint = 'Un solo equipo y un solo usuario con contraseña incorrecta: casi seguro una contraseña vieja guardada (unidad de red, servicio, tarea programada o celular).';
  } else if (detail.sources.some((s) => s.mainReason === '0xc0000064')) {
    hint = 'Se prueban usuarios que no existen: patrón típico de un escaneo o fuerza bruta.';
  } else {
    hint = 'Revisar el detalle por origen en la alerta.';
  }
  return {
    description:
      `${serverName}: ${detail.total}${detail.truncated ? '+' : ''} inicios de sesión fallidos en 24 hs desde ${detail.sourceCount} origen(es). ` +
      `Principales: ${top.join(' | ')}. ${hint}`,
    fromInternet: internet.length > 0,
  };
}

module.exports = { enrichFailedLogons, summarizeFailedLogons, logonTypeLabel, reasonLabel, LOGON_TYPE, REASON };
