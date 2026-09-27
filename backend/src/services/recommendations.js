// Recomendaciones expertas por tipo de alerta: que hacer ya (pasos concretos)
// y como evitar que se repita. Se usan en:
//   - cada alerta del dashboard ("Qué hacer"), aun sin IA configurada,
//   - las notificaciones (email/Telegram/Slack/app), con los 2 primeros pasos,
//   - el contexto del triage con IA (Gemini), para que no invente,
//   - los playbooks por defecto (Admin -> Playbooks) que todavia no existan.
const prisma = require('../prismaClient');

const RECOMMENDATIONS = {
  AGENT_OFFLINE: {
    title: 'Servidor sin reportar',
    steps: [
      'Hacer ping al servidor y abrir Escritorio remoto: confirmar si está encendido y con red.',
      'Si responde: en el servidor revisar la tarea programada "EnterpriseSOCAgent" (debe estar "En ejecución") y el log C:\\Program Files\\EnterpriseSOC\\Agent\\agent.log.',
      'Si no responde: revisar energía/UPS, switch y enlace del sitio (pestaña Red e Internet: ¿el sitio perdió internet?).',
      'Si otros servidores del mismo sitio también cayeron, tratarlo como caída de sitio y llamar al ISP.',
    ],
    prevention: 'UPS con apagado ordenado, BIOS en "encender al volver la energía" y agente actualizado (se relanza solo cada minuto).',
  },
  CPU_THRESHOLD: {
    title: 'CPU alta sostenida',
    steps: [
      'Abrir el detalle del servidor → "Salud preventiva" → "Procesos que más consumen" para ver el culpable.',
      'Si es antivirus, Windows Update o un backup, esperar a que termine; si se repite en horario de caja, reprogramarlo fuera de horario.',
      'Si es un proceso del sistema de punto de venta o SQL: revisar consultas/reportes pesados y reiniciar el servicio en una ventana tranquila.',
      'Si persiste sin causa clara: revisar malware (análisis completo de Defender).',
    ],
    prevention: 'Programar tareas pesadas (backups, antivirus, updates) de madrugada y dimensionar CPU si el promedio diario supera el 70%.',
  },
  MEMORY_THRESHOLD: {
    title: 'Memoria alta / agotada',
    steps: [
      'Ver en "Procesos que más consumen" (memoria) cuál crece: si un proceso sube sin parar es una fuga de memoria.',
      'Reiniciar ese servicio/aplicación en un momento sin operación; si es SQL Server, limitar "max server memory".',
      'Verificar el archivo de paginación (no debería estar al 100%).',
      'Si ocurre a diario, programar el reinicio del servicio o del equipo en horario nocturno y escalar al proveedor del software.',
    ],
    prevention: 'Ampliar RAM si el uso normal supera el 80% y mantener actualizado el software que pierde memoria.',
  },
  DISK_THRESHOLD: {
    title: 'Disco casi lleno',
    steps: [
      'Liberar espacio ya: vaciar %TEMP% y C:\\Windows\\Temp, Liberador de espacio en disco (incluye archivos de Windows Update).',
      'Buscar qué ocupa (WinDirStat/TreeSize): suelen ser backups viejos locales, logs de SQL o de la aplicación, perfiles de usuario.',
      'Mover o rotar backups y logs antiguos a otro disco o NAS; en SQL, reducir el log con un backup de log.',
      'Si el crecimiento es normal del negocio, planificar ampliar el disco (ver pronóstico de llenado en el detalle).',
    ],
    prevention: 'Rotación automática de backups/logs y revisar el pronóstico de llenado semanalmente.',
  },
  DISK_FORECAST: {
    title: 'El disco se va a llenar',
    steps: [
      'Ver en el detalle del servidor la tendencia (%/día) y los días restantes.',
      'Identificar qué carpeta crece (backups locales, logs, base de datos) y configurar su rotación.',
      'Si el crecimiento es legítimo, programar la ampliación del disco antes de la fecha estimada.',
    ],
    prevention: 'Políticas de retención para backups y logs; alarmas tempranas como esta evitan la caída del sistema.',
  },
  DISK_FAILURE_PREDICTED: {
    title: 'Disco con fallas',
    steps: [
      'URGENTE: verificar que exista un backup reciente y restaurable de ese equipo antes de tocar nada.',
      'Revisar el estado SMART/salud en el detalle del servidor y los errores de disco del Visor de eventos.',
      'Planificar el reemplazo del disco (o del equipo) cuanto antes; si es un RAID, reemplazar el disco degradado.',
      'Evitar tareas que exijan el disco (desfragmentar, chkdsk en caliente) hasta tener el backup.',
    ],
    prevention: 'Reemplazar discos con más de 5 años o con errores, y usar RAID/respaldo en servidores críticos.',
  },
  BACKUP_FAILED: {
    title: 'Backup fallido',
    steps: [
      'Ver en la pestaña Backups qué método/tarea falló y su detalle (código, archivos con error, destino).',
      'Verificar que el destino exista y tenga espacio: disco USB conectado, NAS/carpeta de red accesible, credenciales vigentes.',
      'Ejecutar el backup a mano (la tarea programada o wbadmin) y revisar su log para ver el error exacto.',
      'Confirmar que el servicio VSS (Instantáneas de volumen) esté en ejecución.',
    ],
    prevention: 'Destino con espacio de sobra, contraseñas de servicio sin vencimiento, y probar una restauración al mes.',
  },
  BACKUP_WARNING: {
    title: 'Backup con advertencias',
    steps: [
      'Revisar en la pestaña Backups qué trabajo quedó con advertencia (archivos no copiados, tarea atrasada o deshabilitada).',
      'Si hay archivos no copiados: suelen estar abiertos/bloqueados; usar robocopy con /B o programar el backup con la aplicación cerrada.',
      'Si la tarea no corre hace días: revisar que esté habilitada, que el equipo esté encendido a esa hora y la cuenta con la que corre.',
    ],
    prevention: 'Backups fuera del horario de operación y revisar esta pestaña una vez por semana.',
  },
  SERVICE_DOWN: {
    title: 'Servicio crítico detenido',
    steps: [
      'Intentar iniciarlo: services.msc → el servicio → Iniciar (o "Start-Service <nombre>" en PowerShell).',
      'Si no arranca, ver el error en el Visor de eventos (System / Application) justo en el momento del intento.',
      'Causas típicas: contraseña de la cuenta de servicio vencida, disco lleno, puerto ocupado, licencia.',
      'Configurar la recuperación del servicio: "Reiniciar el servicio" en el 1er y 2do error.',
    ],
    prevention: 'Cuentas de servicio con contraseña que no vence y recuperación automática configurada en cada servicio crítico.',
  },
  REBOOT_PENDING: {
    title: 'Reinicio pendiente',
    steps: [
      'Programar el reinicio fuera del horario de operación (idealmente con ventana de mantenimiento en el NOC).',
      'Avisar a los usuarios del equipo antes de reiniciar.',
    ],
    prevention: 'Ventana de mantenimiento semanal fija para aplicar actualizaciones y reiniciar.',
  },
  PATCHES_OUTDATED: {
    title: 'Parches de Windows atrasados',
    steps: [
      'Ejecutar Windows Update (o revisar WSUS/política) y aplicar primero las actualizaciones críticas/de seguridad.',
      'Si Windows Update falla, revisar espacio en disco y el servicio "wuauserv".',
      'Reiniciar en ventana de mantenimiento.',
    ],
    prevention: 'Actualizaciones automáticas en ventana nocturna fija, al menos una vez al mes.',
  },
  LOGIN_FAILURE: {
    title: 'Intentos de acceso fallidos',
    steps: [
      'Identificar el origen (IP/equipo en la alerta): si es interno, suele ser una contraseña vieja guardada en un celular, unidad de red o servicio.',
      'Si el origen es externo o desconocido: bloquearlo en el Fortigate y verificar que RDP no esté expuesto a internet.',
      'Si es una cuenta real, cambiarle la contraseña y revisar sus inicios de sesión recientes (pestaña Inventario → Sesiones).',
    ],
    prevention: 'No exponer RDP a internet (usar VPN), política de bloqueo de cuentas y MFA donde sea posible.',
  },
  AD_ACCOUNT_LOCKOUT: {
    title: 'Cuenta del AD bloqueada',
    steps: [
      'Confirmar con el usuario si fue él (contraseña olvidada) antes de desbloquear.',
      'Revisar el equipo de origen del bloqueo (en la alerta): una contraseña vieja guardada allí vuelve a bloquear la cuenta.',
      'Desbloquear en "Usuarios y equipos de Active Directory" o con Unlock-ADAccount, y si hace falta cambiar la contraseña.',
    ],
    prevention: 'Enseñar a actualizar la contraseña en celulares/unidades de red al cambiarla.',
  },
  PRIVILEGED_GROUP_CHANGE: {
    title: 'Cambio en un grupo privilegiado',
    steps: [
      'Confirmar con quien hizo el cambio (actor en la alerta) si estaba planificado y autorizado.',
      'Si NO fue autorizado: quitar la membresía de inmediato, cambiar la contraseña de la cuenta que lo hizo y tratarlo como incidente de seguridad.',
      'Revisar otros cambios recientes en Inventario → Sesiones y auditoría.',
    ],
    prevention: 'Pocas cuentas administradoras, separadas de las de uso diario, y registro de cambios aprobados.',
  },
  MALWARE_DETECTED: {
    title: 'Malware detectado',
    steps: [
      'Aislar el equipo de la red si la amenaza no fue eliminada (desconectar el cable/Wi-Fi).',
      'Ejecutar un análisis completo con Microsoft Defender y verificar que la amenaza figure como eliminada/en cuarentena.',
      'Cambiar las contraseñas usadas en ese equipo y revisar otros equipos del mismo sitio.',
      'Verificar que los backups recientes no estén comprometidos.',
    ],
    prevention: 'Defender activo con firmas al día, usuarios sin permisos de administrador y filtrado web en el Fortigate.',
  },
  NETWORK_UNREACHABLE: {
    title: 'Servidor inaccesible desde el NOC',
    steps: [
      'Verificar si el sitio tiene internet (pestaña Red e Internet) y si el agente sigue reportando.',
      'Si el agente reporta pero el puerto no responde: revisar el servicio que escucha en ese puerto y el firewall de Windows.',
      'Si el sitio entero no responde: revisar Fortigate/enlace y llamar al ISP.',
    ],
    prevention: 'Doble enlace de internet con failover automático en el Fortigate.',
  },
  INTERNET_OUTAGE: {
    title: 'Corte de internet',
    steps: [
      'Ver la duración del corte y si el enlace de respaldo tomó el tráfico.',
      'Si los cortes se repiten, reclamar al ISP con las fechas/horas registradas por el NOC.',
    ],
    prevention: 'Enlace secundario de otro proveedor y failover configurado en el Fortigate.',
  },
  ISP_FAILOVER: {
    title: 'Sitio en el enlace de respaldo',
    steps: [
      'El enlace principal está caído o degradado: reportarlo al ISP principal (contacto en la CMDB del sitio).',
      'Controlar que el enlace secundario soporte la carga (sistemas de cobro, VPN).',
      'Cuando vuelva el principal, confirmar que el tráfico regresó (esta alerta se cierra sola).',
    ],
    prevention: 'Monitorear la calidad de ambos enlaces y tener el SLA del ISP a mano.',
  },
  NETWORK_DEGRADED: {
    title: 'Internet degradado',
    steps: [
      'Ver en el detalle del servidor → Red la latencia y pérdida; comparar con otros sitios del mismo ISP.',
      'Revisar si hay consumo anormal (descargas, actualizaciones) saturando el enlace.',
      'Reiniciar el módem/ONT del ISP si la pérdida persiste y reclamar si no mejora.',
    ],
    prevention: 'Límites de ancho de banda (QoS) en el Fortigate para priorizar el sistema de cobro.',
  },
  DHCP_SCOPE_EXHAUSTED: {
    title: 'DHCP sin IPs libres',
    steps: [
      'Ver en Inventario → Mapa de IPs las concesiones: muchas pueden ser de celulares o equipos que ya no están.',
      'Reducir la duración de la concesión (por ejemplo a 1 día) para que se liberen más rápido.',
      'Ampliar el rango del ámbito o mover la red de invitados/celulares a otra VLAN.',
    ],
    prevention: 'Red de invitados separada y revisar el uso del ámbito mensualmente.',
  },
  IP_CONFLICT: {
    title: 'Conflicto de IP',
    steps: [
      'Buscar la MAC de la alerta en Inventario → Mapa de IPs para identificar el equipo con IP fija dentro del rango DHCP.',
      'Cambiar ese equipo a una IP de la lista "Libres para IP fija" o crearle una reserva DHCP.',
    ],
    prevention: 'IPs fijas solo fuera del rango DHCP, o reservas en el DHCP.',
  },
  PRINTER_ISSUE: {
    title: 'Problema de impresora',
    steps: [
      'Ver en Inventario → Impresoras el error exacto (papel, tóner, atasco, tapa, sin respuesta).',
      'Si no responde: verificar que esté encendida y con cable/Wi-Fi, y que su IP no haya cambiado (idealmente con reserva DHCP).',
      'Si es tóner/papel bajo: pedir el repuesto ahora, antes de que se detenga.',
    ],
    prevention: 'Reservas DHCP para impresoras y stock mínimo de tóner según el nivel que muestra el NOC.',
  },
  ANOMALY_DETECTED: {
    title: 'Comportamiento fuera de lo normal',
    steps: [
      'Comparar con el mismo horario de otros días en Monitoreo → rango 7 d.',
      'Si coincide con una tarea programada nueva o un cambio reciente, no requiere acción.',
      'Si no hay explicación, revisar procesos y conexiones del equipo.',
    ],
    prevention: 'Registrar cambios planificados para que las anomalías tengan contexto.',
  },
  CUSTOM: {
    title: 'Alerta',
    steps: ['Revisar el detalle de la alerta y el estado del servidor en el NOC.', 'Consultar al asistente IA con el texto de la alerta si no está claro el paso siguiente.'],
    prevention: 'Documentar la solución en el playbook para la próxima vez.',
  },
};

function getRecommendation(type) {
  return RECOMMENDATIONS[type] ?? null;
}

// Texto corto para notificaciones: los 2 primeros pasos.
function shortRecommendation(type) {
  const rec = RECOMMENDATIONS[type];
  if (!rec) return '';
  return `Qué hacer: 1) ${rec.steps[0]}${rec.steps[1] ? ` 2) ${rec.steps[1]}` : ''}`;
}

function asPlaybookMarkdown(rec) {
  return `${rec.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nPrevención: ${rec.prevention}`;
}

// Crea los playbooks que falten (nunca pisa uno editado por un ADMIN).
async function seedMissingPlaybooks() {
  try {
    const existing = new Set((await prisma.playbook.findMany({ select: { key: true } })).map((p) => p.key));
    const missing = Object.entries(RECOMMENDATIONS).filter(([key]) => !existing.has(key));
    for (const [key, rec] of missing) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.playbook.create({ data: { key, title: rec.title, content: asPlaybookMarkdown(rec) } }).catch(() => {});
    }
    if (missing.length) console.log(`Playbooks: ${missing.length} creado(s) con las recomendaciones por defecto`);
  } catch (err) {
    console.error('No se pudieron crear los playbooks por defecto', err.message);
  }
}

module.exports = { RECOMMENDATIONS, getRecommendation, shortRecommendation, seedMissingPlaybooks };
