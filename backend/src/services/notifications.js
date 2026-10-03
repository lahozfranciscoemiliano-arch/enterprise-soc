const { getSettings } = require('./settings');
const { shortRecommendation } = require('./recommendations');

const SEVERITY_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
const SEVERITY_EMOJI = { LOW: '🔵', MEDIUM: '🟡', HIGH: '🟠', CRITICAL: '🔴' };

const { sendBrandedMail, smtpTransport, smtpErrorMessage, parseRecipients, panelUrl } = require('./mailer');
const { buildReportEmailParts } = require('./reportEmail');

const SEVERITY_TONE = { LOW: 'info', MEDIUM: 'warn', HIGH: 'warn', CRITICAL: 'bad' };
const SEVERITY_LABEL = { LOW: 'BAJA', MEDIUM: 'MEDIA', HIGH: 'ALTA', CRITICAL: 'CRÍTICA' };

// Alertas por correo segun EMAIL_ALERTS_MODE (Admin -> Configuracion):
//   'none' (por defecto): el correo queda para los reportes (1 por dia habil);
//                         las alertas llegan por Telegram / la app / el panel.
//   'critical': solo las CRITICAL, al instante.
//   'all': todas las que pasan el umbral NOTIFY_MIN_SEVERITY.
async function sendEmailAlert(cfg, notif) {
  if (!cfg.SMTP_HOST || !cfg.ALERT_EMAIL_TO) return;
  const mode = cfg.EMAIL_ALERTS_MODE || 'none';
  if (mode === 'none') return;
  if (mode === 'critical' && notif.severity !== 'CRITICAL') return;

  const tz = process.env.APP_TIMEZONE || undefined;
  try {
    await sendBrandedMail({
      to: cfg.ALERT_EMAIL_TO,
      subject: `[${SEVERITY_LABEL[notif.severity] ?? notif.severity}] ${notif.subject}`,
      parts: {
        kicker: `Alerta · ${new Date().toLocaleString('es-AR', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' })}`,
        title: notif.subject,
        subtitle: `Severidad ${SEVERITY_LABEL[notif.severity] ?? notif.severity}`,
        sections: [{ title: 'Detalle', items: [{ chip: SEVERITY_LABEL[notif.severity] ?? notif.severity, tone: SEVERITY_TONE[notif.severity] ?? 'muted', text: notif.text }] }],
        cta: { url: panelUrl(), label: 'Ver en el NOC/SOC' },
      },
    });
  } catch (err) {
    console.error('Error enviando alerta por email', err.message);
  }
}

// Reporte PDF por correo (reusa la config SMTP de notificaciones). Con
// "data" (recien generado) el cuerpo trae el resumen del periodo; sin data
// (reenvio de un PDF viejo) un texto generico. No pasa por el umbral de
// severidad: un reporte no es una alerta. Devuelve los destinatarios; si
// falla lanza un Error con un mensaje para mostrar en el panel.
async function sendReportEmail({ to, filename, buffer, data }) {
  const { subject, parts } = buildReportEmailParts(data, filename);
  return sendBrandedMail({
    to,
    subject,
    parts,
    attachments: [{ filename, content: buffer, contentType: 'application/pdf' }],
  });
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
    } catch (err) {
      throw new Error(smtpErrorMessage(err, cfg));
    } finally {
      transport.close();
    }
    await sendBrandedMail({
      to: recipients.join(','),
      subject: 'Prueba de correo — NOC/SOC',
      parts: {
        kicker: `Prueba · ${stamp}`,
        title: 'Prueba de correo',
        subtitle: 'El envío de correos del NOC/SOC funciona',
        intro:
          'Si estás leyendo esto, el servidor de correo está bien configurado. Así se ven los correos del NOC: los reportes diarios y semanales llegan con este mismo diseño y el PDF adjunto.',
        sections: [
          {
            title: 'Código anti-phishing',
            text: 'Si configuraste tu código en el panel (Mi cuenta → Código anti-phishing), aparece arriba de todo. Un correo "del NOC" sin tu código no es nuestro.',
          },
        ],
      },
    });
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
  'EMAIL_ALERTS_MODE',
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

module.exports = { notifyAlert, notifyGeneric, sendReportEmail, sendTestNotification, inQuietHours, buildDigest };
