const nodemailer = require('nodemailer');
const { getSettings } = require('./settings');

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
];

async function dispatch(notif) {
  const cfg = await getSettings(NOTIFICATION_SETTING_KEYS);
  const minSeverity = cfg.NOTIFY_MIN_SEVERITY || 'HIGH';
  if ((SEVERITY_RANK[notif.severity] ?? 0) < (SEVERITY_RANK[minSeverity] ?? 2)) return;

  await Promise.allSettled([sendEmailAlert(cfg, notif), sendSlackAlert(cfg, notif), sendGenericWebhook(cfg, notif)]);
}

// Se llama sin "await" desde las rutas para no demorar la respuesta HTTP;
// por eso nunca debe lanzar (cada canal atrapa sus propios errores).
async function notifyAlert(event) {
  await dispatch({
    severity: event.severity,
    subject: `${event.serverName}: ${event.type}`,
    text: event.description,
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

module.exports = { notifyAlert, notifyGeneric, sendReportEmail };
