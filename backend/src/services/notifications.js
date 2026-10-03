const nodemailer = require('nodemailer');
const { getSettings } = require('./settings');
const { shortRecommendation } = require('./recommendations');

const SEVERITY_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
const SEVERITY_EMOJI = { LOW: '🔵', MEDIUM: '🟡', HIGH: '🟠', CRITICAL: '🔴' };

const SMTP_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];

function smtpTransport(cfg) {
  const port = Number(cfg.SMTP_PORT) || 587;
  return nodemailer.createTransport({
    host: cfg.SMTP_HOST,
    port,
    // 465 siempre es TLS implicito: con secure=false la conexion se cuelga.
    secure: Boolean(cfg.SMTP_SECURE) || port === 465,
    auth: cfg.SMTP_USER ? { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
}

// Gmail / Microsoft 365 rechazan un remitente que no es la cuenta autenticada.
function smtpFrom(cfg) {
  return cfg.SMTP_FROM || cfg.SMTP_USER || 'noc@enterprise-soc.local';
}

/** "a@x.com, b@y.com; c@z.com" -> lista validada (max 10). */
function parseRecipients(raw) {
  const list = String(raw ?? '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = list.filter((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  if (!list.length) throw new Error('Falta el destinatario');
  if (bad.length) throw new Error(`Dirección inválida: ${bad.join(', ')}`);
  if (list.length > 10) throw new Error('Máximo 10 destinatarios');
  return list;
}

// Traduce los errores de nodemailer a algo accionable.
function smtpErrorMessage(err, cfg) {
  const code = err?.code || '';
  const port = Number(cfg.SMTP_PORT) || 587;
  if (code === 'EAUTH') return 'El servidor de correo rechazó usuario/contraseña. Con Gmail o Microsoft 365 hay que usar una "contraseña de aplicación" (requiere verificación en 2 pasos).';
  const msg = err?.message || '';
  if (['ETIMEDOUT', 'ECONNECTION', 'ECONNREFUSED'].includes(code) || /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|timeout/i.test(msg)) return `No se pudo conectar a ${cfg.SMTP_HOST}:${port}. Revisá host y puerto (587 con STARTTLS o 465 con TLS implícito); algunos proveedores de VPS bloquean el puerto 25.`;
  if (code === 'EDNS' || code === 'ENOTFOUND') return `No existe el servidor ${cfg.SMTP_HOST}. Revisá el nombre.`;
  if (code === 'ESOCKET' || /wrong version number|ssl/i.test(msg)) return `Error de TLS con ${cfg.SMTP_HOST}:${port}: si usás 587 destildá "TLS implícito"; si usás 465, tildalo.`;
  if (code === 'EENVELOPE') return `El servidor rechazó el remitente o el destinatario: ${err.response || err.message}`;
  return err?.response || err?.message || 'Error desconocido al enviar el correo';
}

async function sendEmailAlert(cfg, notif) {
  if (!cfg.SMTP_HOST || !cfg.ALERT_EMAIL_TO) return;

  try {
    await smtpTransport(cfg).sendMail({
      from: smtpFrom(cfg),
      to: cfg.ALERT_EMAIL_TO,
      subject: `[${notif.severity}] ${notif.subject}`,
      text: notif.text,
    });
  } catch (err) {
    console.error('Error enviando alerta por email', err);
  }
}

// Reusa la config SMTP de notificaciones de alertas (Admin -> Configuracion
// -> Notificaciones externas): no hay un SMTP separado solo para reportes.
// No pasa por el umbral de severidad de dispatch(): un reporte no es una alerta.
// Devuelve la lista de destinatarios; si falla lanza un Error con un mensaje
// que se puede mostrar en el panel.
async function sendReportEmail({ to, filename, buffer, summary }) {
  const cfg = await getSettings(SMTP_KEYS);
  if (!cfg.SMTP_HOST) {
    throw new Error('No se puede enviar el reporte por email: falta configurar SMTP (Admin -> Configuración)');
  }
  const recipients = parseRecipients(to);
  const lines = [
    'Se adjunta el reporte ejecutivo del NOC/SOC.',
    summary?.periodDays ? `Período: últimos ${summary.periodDays} día(s).` : null,
    typeof summary?.slaPercentage === 'number' ? `Disponibilidad (SLA): ${summary.slaPercentage.toFixed(2)} %.` : null,
    '',
    'Enviado automáticamente por Enterprise SOC.',
  ].filter((l) => l !== null);
  try {
    await smtpTransport(cfg).sendMail({
      from: smtpFrom(cfg),
      to: recipients.join(', '),
      subject: `Reporte Ejecutivo NOC/SOC — ${new Date().toLocaleDateString('es-AR')}`,
      text: lines.join('\n'),
      attachments: [{ filename, content: buffer, contentType: 'application/pdf' }],
    });
  } catch (err) {
    throw new Error(smtpErrorMessage(err, cfg));
  }
  return recipients;
}

// Prueba de un canal desde Admin -> Configuracion. A diferencia de los envios
// reales (que nunca lanzan), devuelve el error exacto del proveedor.
async function sendTestNotification(channel, { to } = {}) {
  const cfg = await getSettings(NOTIFICATION_SETTING_KEYS);
  const stamp = new Date().toLocaleString('es-AR');
  const text = `Prueba de notificaciones del NOC/SOC (${stamp}). Si ves este mensaje, el canal funciona.`;

  if (channel === 'email') {
    if (!cfg.SMTP_HOST) throw new Error('Falta configurar el servidor SMTP (y guardar).');
    const recipients = parseRecipients(to || cfg.ALERT_EMAIL_TO);
    const transport = smtpTransport(cfg);
    try {
      await transport.verify();
      await transport.sendMail({ from: smtpFrom(cfg), to: recipients.join(', '), subject: 'Prueba de correo — NOC/SOC', text });
    } catch (err) {
      throw new Error(smtpErrorMessage(err, cfg));
    }
    return `Correo enviado a ${recipients.join(', ')}. Si no llega en unos minutos, revisá la carpeta de spam.`;
  }

  if (channel === 'telegram') {
    if (!cfg.TELEGRAM_BOT_TOKEN || !cfg.TELEGRAM_CHAT_ID) throw new Error('Faltan el token del bot y/o el chat ID (y guardar).');
    const res = await fetch(`https://api.telegram.org/bot${cfg.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.TELEGRAM_CHAT_ID, text: `✅ ${text}` }),
    }).catch((err) => {
      throw new Error(`No se pudo conectar con Telegram: ${err.message}`);
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
      const why = body.description || `HTTP ${res.status}`;
      if (res.status === 401) throw new Error('Telegram rechazó el token del bot (revisalo en @BotFather).');
      if (/chat not found/i.test(why)) throw new Error('Telegram no encuentra el chat: agregá el bot al grupo y mandale un mensaje primero, y revisá el chat ID (los grupos empiezan con -).');
      throw new Error(`Telegram respondió: ${why}`);
    }
    return 'Mensaje enviado a Telegram.';
  }

  if (channel === 'slack' || channel === 'webhook') {
    const url = channel === 'slack' ? cfg.SLACK_WEBHOOK_URL : cfg.WEBHOOK_URL;
    if (!url) throw new Error(`Falta configurar el ${channel === 'slack' ? 'webhook de Slack' : 'webhook genérico'} (y guardar).`);
    const payload = channel === 'slack' ? { text: `✅ ${text}` } : { source: 'test', severity: 'LOW', subject: 'Prueba de notificaciones', text, createdAt: new Date().toISOString() };
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).catch((err) => {
      throw new Error(`No se pudo conectar: ${err.message}`);
    });
    if (!res.ok) throw new Error(`El webhook respondió HTTP ${res.status}`);
    return 'Mensaje enviado.';
  }

  throw new Error('Canal desconocido');
}

async function sendSlackAlert(cfg, notif) {
  if (!cfg.SLACK_WEBHOOK_URL) return;

  try {
    await fetch(cfg.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `${SEVERITY_EMOJI[notif.severity] ?? ''} *${notif.severity}* — ${notif.subject}\n${notif.text}`,
      }),
    });
  } catch (err) {
    console.error('Error enviando alerta a Slack', err);
  }
}

async function sendGenericWebhook(cfg, notif) {
  if (!cfg.WEBHOOK_URL) return;

  try {
    await fetch(cfg.WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(notif.webhookPayload),
    });
  } catch (err) {
    console.error('Error enviando alerta a webhook genérico', err);
  }
}

// Canal adicional pensado para equipos de operaciones que viven en WhatsApp
// pero no tienen infraestructura para la API de WhatsApp Business (requiere
// cuenta Meta verificada o un puente como Twilio/360dialog). Telegram es la
// alternativa mas simple: un bot propio (gratis, @BotFather) + el chat_id
// del grupo/persona a notificar, sin proceso de aprobacion.
async function sendTelegramAlert(cfg, notif) {
  if (!cfg.TELEGRAM_BOT_TOKEN || !cfg.TELEGRAM_CHAT_ID) return;

  try {
    const url = `https://api.telegram.org/bot${cfg.TELEGRAM_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: cfg.TELEGRAM_CHAT_ID,
        // Texto plano: con parse_mode Markdown un "_" o "*" en un nombre de
        // servidor/usuario hace que Telegram rechace el mensaje entero.
        text: `${SEVERITY_EMOJI[notif.severity] ?? ''} ${notif.severity} — ${notif.subject}\n${notif.text}`.slice(0, 4000),
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error('Error enviando alerta a Telegram', err);
  }
}

const NOTIFICATION_SETTING_KEYS = [
  'NOTIFY_MIN_SEVERITY',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_FROM',
  'ALERT_EMAIL_TO',
  'SLACK_WEBHOOK_URL',
  'WEBHOOK_URL',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'NOTIFY_QUIET_HOURS',
  'NOTIFY_BATCH_MINUTES',
];

async function sendToAllChannels(cfg, notif) {
  await Promise.allSettled([
    sendEmailAlert(cfg, notif),
    sendSlackAlert(cfg, notif),
    sendGenericWebhook(cfg, notif),
    sendTelegramAlert(cfg, notif),
  ]);
}

// ---------------------------------------------------------------------------
// Anti-fatiga: las CRITICAL salen al instante; el resto se agrupa en un solo
// mensaje cada NOTIFY_BATCH_MINUTES (3 por defecto). En el horario silencioso
// (NOTIFY_QUIET_HOURS, ej. "22-07") solo salen las CRITICAL y lo demas llega
// en un resumen al terminar el horario.
// ---------------------------------------------------------------------------
const queue = [];
let flushTimer = null;

function inQuietHours(spec, date = new Date()) {
  const m = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(String(spec || '').trim());
  if (!m) return false;
  const tz = process.env.APP_TIMEZONE || undefined;
  const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz }).format(date));
  const [from, to] = [Number(m[1]) % 24, Number(m[2]) % 24];
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

function buildDigest(items, quiet) {
  const counts = items.reduce((acc, n) => ({ ...acc, [n.severity]: (acc[n.severity] ?? 0) + 1 }), {});
  const worst = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].find((sev) => counts[sev]) ?? 'MEDIUM';
  const summary = Object.entries(counts)
    .map(([sev, c]) => `${c} ${sev}`)
    .join(' · ');
  const lines = items.slice(0, 25).map((n) => `${SEVERITY_EMOJI[n.severity] ?? '•'} ${n.subject}: ${String(n.text).split('\n')[0].slice(0, 180)}`);
  if (items.length > 25) lines.push(`… y ${items.length - 25} más (ver el NOC).`);
  return {
    severity: worst,
    subject: quiet ? `Resumen del horario silencioso: ${items.length} alerta(s)` : `${items.length} alertas nuevas (${summary})`,
    text: lines.join('\n'),
    webhookPayload: { source: 'digest', count: items.length, items: items.map((n) => n.webhookPayload) },
  };
}

async function flushQueue() {
  flushTimer = null;
  if (queue.length === 0) return;
  const cfg = await getSettings(NOTIFICATION_SETTING_KEYS);
  if (inQuietHours(cfg.NOTIFY_QUIET_HOURS)) {
    // Se sigue acumulando hasta que termine el horario silencioso.
    flushTimer = setTimeout(() => flushQueue().catch(() => {}), 5 * 60 * 1000);
    queue.quiet = true;
    return;
  }
  const items = queue.splice(0, queue.length);
  const quiet = Boolean(queue.quiet);
  queue.quiet = false;
  await sendToAllChannels(cfg, items.length === 1 && !quiet ? items[0] : buildDigest(items, quiet));
}

async function dispatch(notif) {
  const cfg = await getSettings(NOTIFICATION_SETTING_KEYS);
  const minSeverity = cfg.NOTIFY_MIN_SEVERITY || 'HIGH';
  if ((SEVERITY_RANK[notif.severity] ?? 0) < (SEVERITY_RANK[minSeverity] ?? 2)) return;

  if (notif.severity === 'CRITICAL' || notif.immediate) {
    await sendToAllChannels(cfg, notif);
    return;
  }

  // Mismo asunto ya en cola (ej. la misma alerta reabierta): no se duplica.
  if (queue.some((q) => q.subject === notif.subject && q.text === notif.text)) return;
  queue.push(notif);
  if (!flushTimer) {
    const minutes = Math.min(Math.max(Number(cfg.NOTIFY_BATCH_MINUTES) || 3, 0), 60);
    flushTimer = setTimeout(() => flushQueue().catch((err) => console.error('Error enviando resumen de alertas', err)), minutes * 60 * 1000);
  }
}

// Se llama sin "await" desde las rutas para no demorar la respuesta HTTP;
// por eso nunca debe lanzar (cada canal atrapa sus propios errores).
async function notifyAlert(event) {
  const rec = shortRecommendation(event.type);
  await dispatch({
    severity: event.severity,
    subject: `${event.serverName}: ${event.recommendation?.title ?? event.type}`,
    text: rec ? `${event.description}\n${rec}` : event.description,
    webhookPayload: {
      source: 'server',
      id: event.id,
      type: event.type,
      severity: event.severity,
      description: event.description,
      serverName: event.serverName,
      createdAt: event.createdAt,
    },
  });
}

// Misma logica de canales/umbral que notifyAlert, para eventos que no
// vienen de un SecurityEvent (por ahora: Fortinet).
async function notifyGeneric({ severity, subject, text, source, metadata }) {
  await dispatch({
    severity,
    subject,
    text,
    webhookPayload: { source, severity, subject, text, metadata, createdAt: new Date().toISOString() },
  });
}

module.exports = { notifyAlert, notifyGeneric, sendReportEmail, sendTestNotification, parseRecipients, inQuietHours, buildDigest };
