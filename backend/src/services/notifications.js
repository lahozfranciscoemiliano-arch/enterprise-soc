const nodemailer = require('nodemailer');
const { getSettings } = require('./settings');
const { shortRecommendation } = require('./recommendations');

const SEVERITY_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
const SEVERITY_EMOJI = { LOW: '🔵', MEDIUM: '🟡', HIGH: '🟠', CRITICAL: '🔴' };

async function sendEmailAlert(cfg, notif) {
  if (!cfg.SMTP_HOST || !cfg.ALERT_EMAIL_TO) return;

  try {
    const transporter = nodemailer.createTransport({
      host: cfg.SMTP_HOST,
      port: cfg.SMTP_PORT || 587,
      secure: Boolean(cfg.SMTP_SECURE),
      auth: cfg.SMTP_USER ? { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS } : undefined,
    });

    await transporter.sendMail({
      from: cfg.SMTP_FROM || 'noc@enterprise-soc.local',
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
// A diferencia de sendEmailAlert, el destinatario lo elige quien llama (el
// campo REPORT_EMAIL_TO puede ser distinto de ALERT_EMAIL_TO), y no pasa por
// el umbral de severidad de dispatch() porque un reporte no es una alerta.
async function sendReportEmail({ to, filename, buffer }) {
  const cfg = await getSettings(['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']);
  if (!cfg.SMTP_HOST) {
    throw new Error('No se puede enviar el reporte por email: falta configurar SMTP (Admin -> Configuración)');
  }

  const transporter = nodemailer.createTransport({
    host: cfg.SMTP_HOST,
    port: cfg.SMTP_PORT || 587,
    secure: Boolean(cfg.SMTP_SECURE),
    auth: cfg.SMTP_USER ? { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS } : undefined,
  });

  await transporter.sendMail({
    from: cfg.SMTP_FROM || 'noc@enterprise-soc.local',
    to,
    subject: `Reporte Ejecutivo Enterprise SOC — ${new Date().toLocaleDateString('es-AR')}`,
    text: 'Se adjunta el reporte ejecutivo generado automáticamente por Enterprise SOC.',
    attachments: [{ filename, content: buffer, contentType: 'application/pdf' }],
  });
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

module.exports = { notifyAlert, notifyGeneric, sendReportEmail, inQuietHours, buildDigest };
