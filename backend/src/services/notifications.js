const nodemailer = require('nodemailer');

// Config 100% por variables de entorno: cada cliente/deploy tiene su propio
// backend, asi que no hace falta una UI de configuracion multi-tenant.
const SEVERITY_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
const NOTIFY_MIN_SEVERITY = process.env.NOTIFY_MIN_SEVERITY || 'HIGH';
const SEVERITY_EMOJI = { LOW: '🔵', MEDIUM: '🟡', HIGH: '🟠', CRITICAL: '🔴' };

let mailTransporter;

function getMailTransporter() {
  if (mailTransporter !== undefined) return mailTransporter;

  if (!process.env.SMTP_HOST) {
    mailTransporter = null;
    return mailTransporter;
  }

  mailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });

  return mailTransporter;
}

async function sendEmailAlert(event) {
  const transporter = getMailTransporter();
  const to = process.env.ALERT_EMAIL_TO;
  if (!transporter || !to) return;

  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || 'noc@enterprise-soc.local',
      to,
      subject: `[${event.severity}] ${event.serverName}: ${event.type}`,
      text: event.description,
    });
  } catch (err) {
    console.error('Error enviando alerta por email', err);
  }
}

async function sendSlackAlert(event) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `${SEVERITY_EMOJI[event.severity] ?? ''} *${event.severity}* — ${event.serverName}\n${event.description}`,
      }),
    });
  } catch (err) {
    console.error('Error enviando alerta a Slack', err);
  }
}

async function sendGenericWebhook(event) {
  const url = process.env.WEBHOOK_URL;
  if (!url) return;

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: event.id,
        type: event.type,
        severity: event.severity,
        description: event.description,
        serverName: event.serverName,
        createdAt: event.createdAt,
      }),
    });
  } catch (err) {
    console.error('Error enviando alerta a webhook genérico', err);
  }
}

// Se llama sin "await" desde las rutas para no demorar la respuesta HTTP;
// por eso nunca debe lanzar (cada canal atrapa sus propios errores).
async function notifyAlert(event) {
  if ((SEVERITY_RANK[event.severity] ?? 0) < (SEVERITY_RANK[NOTIFY_MIN_SEVERITY] ?? 2)) return;
  await Promise.allSettled([sendEmailAlert(event), sendSlackAlert(event), sendGenericWebhook(event)]);
}

module.exports = { notifyAlert };
