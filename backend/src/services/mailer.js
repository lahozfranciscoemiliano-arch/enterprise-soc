// Correo del NOC: transporte SMTP, plantilla HTML con la identidad del panel
// (cobre / naranja), firma institucional y codigo anti-phishing por
// destinatario.
//
// Cada destinatario recibe SU copia: si es un usuario del NOC con codigo
// anti-phishing configurado (Mi cuenta), el correo lo muestra arriba de todo.
// Un correo "del NOC" sin su codigo no lo mando el NOC.
//
// HTML para clientes de correo: tablas + estilos en linea (Outlook no
// entiende flex/grid), ancho maximo 640 px y apilado en celulares.
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const prisma = require('../prismaClient');
const { getSettings } = require('./settings');

const SMTP_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'MAIL_SUPPORT_EMAIL'];
const LOGO_PATH = path.join(__dirname, '..', '..', 'assets', 'logo-bistro.png');
const LOGO_CID = 'noc-logo@enterprise-soc';
const DEFAULT_SUPPORT_EMAIL = 'soc@grupobistro.com';
const FONT = "'Segoe UI', Tahoma, Arial, Helvetica, sans-serif";

// Paleta del panel (tailwind brand-*).
const C = {
  brand: '#A84F22',
  brand500: '#C2632D',
  brand700: '#873F1C',
  brandDark: '#6C3317',
  brand900: '#552812',
  soft: '#FBF3EC',
  soft2: '#F6E3D2',
  line: '#EBC29D',
  page: '#F4EEE8',
  card: '#FFFFFF',
  border: '#EFE6DD',
  panel: '#FAF7F4',
  ink: '#1F1A17',
  ink2: '#5B524C',
  muted: '#8A817A',
};

const TONES = {
  ok: { fg: '#15803D', bg: '#ECFDF3', bar: '#16A34A' },
  warn: { fg: '#B45309', bg: '#FFF7E6', bar: '#F59E0B' },
  bad: { fg: '#B91C1C', bg: '#FDECEC', bar: '#DC2626' },
  info: { fg: '#1D4ED8', bg: '#EEF4FF', bar: '#3B82F6' },
  muted: { fg: '#5B524C', bg: '#F4F1EE', bar: '#C9BFB6' },
  brand: { fg: C.brand700, bg: C.soft, bar: C.brand },
};

// ---------------------------------------------------------------------------
// SMTP
// ---------------------------------------------------------------------------
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
  const address = cfg.SMTP_FROM || cfg.SMTP_USER || 'noc@enterprise-soc.local';
  return /</.test(address) ? address : { name: 'NOC/SOC Grupo Bistro', address };
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
  return [...new Set(list.map((e) => e.toLowerCase()))];
}

// Traduce los errores de nodemailer a algo accionable.
function smtpErrorMessage(err, cfg) {
  const code = err?.code || '';
  const msg = err?.message || '';
  const port = Number(cfg.SMTP_PORT) || 587;
  if (code === 'EAUTH') return 'El servidor de correo rechazó usuario/contraseña. Con Gmail o Microsoft 365 hay que usar una "contraseña de aplicación" (requiere verificación en 2 pasos).';
  if (['ETIMEDOUT', 'ECONNECTION', 'ECONNREFUSED'].includes(code) || /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|timeout/i.test(msg)) return `No se pudo conectar a ${cfg.SMTP_HOST}:${port}. Revisá host y puerto (587 con STARTTLS o 465 con TLS implícito); algunos proveedores de VPS bloquean el puerto 25.`;
  if (code === 'EDNS' || code === 'ENOTFOUND') return `No existe el servidor ${cfg.SMTP_HOST}. Revisá el nombre.`;
  if (code === 'ESOCKET' || /wrong version number|ssl/i.test(msg)) return `Error de TLS con ${cfg.SMTP_HOST}:${port}: si usás 587 destildá "TLS implícito"; si usás 465, tildalo.`;
  if (code === 'EENVELOPE') return `El servidor rechazó el remitente o el destinatario: ${err.response || msg}`;
  return err?.response || msg || 'Error desconocido al enviar el correo';
}

// ---------------------------------------------------------------------------
// Plantilla
// ---------------------------------------------------------------------------
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Texto plano -> HTML (escapado, con saltos de linea). */
function textToHtml(text) {
  return esc(text).replace(/\n/g, '<br>');
}

function panelUrl() {
  const url = (process.env.CORS_ORIGIN || '').split(',')[0].trim();
  return /^https?:\/\//.test(url) ? url.replace(/\/$/, '') : null;
}

function panelHost() {
  const url = panelUrl();
  return url ? url.replace(/^https?:\/\//, '') : null;
}

/** Firma institucional (la de Grupo Bistro, con la identidad del panel). */
function signatureHtml({ supportEmail = DEFAULT_SUPPORT_EMAIL } = {}) {
  const url = panelUrl();
  const host = panelHost();
  const mail = esc(supportEmail);
  const links = [
    url ? `<a href="${esc(url)}" style="color:${C.brand};font-weight:600;text-decoration:none;">${esc(host)}</a>` : null,
    `<a href="mailto:${mail}" style="color:${C.brand};font-weight:600;text-decoration:none;">${mail}</a>`,
  ]
    .filter(Boolean)
    .join(`<span style="color:${C.line};">&nbsp;&nbsp;|&nbsp;&nbsp;</span>`);
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;font-family:${FONT};border-collapse:separate;">
  <tr>
    <td width="4" style="width:4px;background:${C.brand};border-radius:4px 0 0 4px;font-size:0;line-height:0;">&nbsp;</td>
    <td style="background:${C.panel};border:1px solid ${C.border};border-left:0;border-radius:0 8px 8px 0;padding:12px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td valign="middle" style="padding-right:12px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
              <td align="center" valign="middle" width="40" height="40" style="width:40px;height:40px;background:${C.brand};background-image:linear-gradient(135deg,${C.brand700},${C.brand500});border-radius:10px;color:#FFFFFF;font-family:${FONT};font-size:11px;font-weight:800;letter-spacing:1px;">SOC</td>
            </tr></table>
          </td>
          <td valign="middle">
            <span style="font-size:14px;font-weight:800;color:${C.brand900};letter-spacing:1.5px;">ENTERPRISE SOC</span>
            <span style="display:inline-block;font-size:10px;line-height:14px;background:${C.brand};color:#FFFFFF;padding:2px 7px;border-radius:4px;margin-left:6px;font-weight:700;letter-spacing:0.5px;vertical-align:2px;">GRUPO BISTRO</span>
            <div style="font-size:12px;color:${C.ink2};margin-top:3px;">Centro de Operaciones de Seguridad y Monitoreo 24/7</div>
            <div style="font-size:11.5px;margin-top:6px;">${links}</div>
          </td>
        </tr>
      </table>
      <div style="border-top:1px solid ${C.border};margin-top:10px;padding-top:8px;font-size:10px;color:${C.muted};line-height:1.45;">
        Este es un mensaje automático generado por la plataforma de monitoreo Enterprise SOC. Para asistencia directa o reporte de incidentes, contacte a
        <a href="mailto:${mail}" style="color:${C.brand700};font-weight:700;text-decoration:none;">${mail}</a>.
      </div>
    </td>
  </tr>
</table>`;
}

function antiPhishingHtml(recipient) {
  if (recipient?.code) {
    return `
<tr><td style="padding:18px 28px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.soft};border:1px solid ${C.line};border-radius:10px;">
    <tr><td style="padding:11px 14px;font-family:${FONT};font-size:12px;color:${C.brandDark};line-height:1.5;">
      <b>Código anti-phishing:</b>
      <span style="display:inline-block;font-family:Consolas,'Courier New',monospace;font-size:13px;font-weight:700;color:${C.brand900};background:#FFFFFF;border:1px dashed ${C.brand500};border-radius:6px;padding:2px 9px;margin-left:4px;">${esc(recipient.code)}</span><br>
      <span style="font-size:11px;color:#8A6A55;">Si un correo del NOC no muestra tu código, no lo enviamos nosotros: no abras sus enlaces ni adjuntos.</span>
    </td></tr>
  </table>
</td></tr>`;
  }
  if (recipient?.isUser) {
    return `
<tr><td style="padding:18px 28px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.panel};border:1px solid ${C.border};border-radius:10px;">
    <tr><td style="padding:10px 14px;font-family:${FONT};font-size:11.5px;color:${C.ink2};line-height:1.5;">
      Protegete del phishing: configurá tu <b>código anti-phishing</b> en el panel (Mi cuenta) y va a aparecer acá en cada correo del NOC.
    </td></tr>
  </table>
</td></tr>`;
  }
  return '';
}

function kpiTile(k) {
  const t = TONES[k.tone] ?? TONES.muted;
  return `
<td class="kpi" width="25%" valign="top" style="padding:5px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFFFFF;border:1px solid ${C.border};border-top:3px solid ${t.bar};border-radius:10px;">
    <tr><td style="padding:10px 12px;font-family:${FONT};">
      <div style="font-size:9.5px;letter-spacing:1px;text-transform:uppercase;color:${C.muted};font-weight:700;">${esc(k.label)}</div>
      <div style="font-size:21px;font-weight:700;color:${k.tone === 'ok' || !k.tone ? C.ink : t.fg};margin-top:3px;line-height:1.2;">${esc(k.value)}</div>
      ${k.sub ? `<div style="font-size:10.5px;color:${C.muted};margin-top:2px;line-height:1.3;">${esc(k.sub)}</div>` : ''}
    </td></tr>
  </table>
</td>`;
}

function kpisHtml(kpis) {
  if (!kpis?.length) return '';
  const rows = [];
  for (let i = 0; i < kpis.length; i += 4) {
    const cells = kpis.slice(i, i + 4).map(kpiTile);
    while (cells.length < 4) cells.push('<td class="kpi" width="25%" style="padding:5px;"></td>');
    rows.push(`<tr>${cells.join('')}</tr>`);
  }
  return `
<tr><td style="padding:14px 23px 2px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows.join('')}</table>
</td></tr>`;
}

function chip(label, tone) {
  const t = TONES[tone] ?? TONES.muted;
  return `<span style="display:inline-block;font-family:${FONT};font-size:9.5px;font-weight:700;letter-spacing:0.6px;color:${t.fg};background:${t.bg};border:1px solid ${t.bar}33;border-radius:999px;padding:2px 8px;white-space:nowrap;">${esc(label)}</span>`;
}

function sectionHtml(s) {
  const items = (s.items ?? [])
    .map(
      (it) => `
    <tr>
      <td valign="top" width="88" style="padding:9px 10px 9px 0;border-top:1px solid ${C.border};">${it.chip ? chip(it.chip, it.tone) : ''}</td>
      <td valign="top" style="padding:9px 0;border-top:1px solid ${C.border};font-family:${FONT};font-size:13px;color:${C.ink};line-height:1.45;">
        ${it.title ? `<b>${esc(it.title)}</b>` : ''}${it.title && it.text ? '<br>' : ''}${it.text ? `<span style="color:${C.ink2};font-size:12.5px;">${esc(it.text)}</span>` : ''}
      </td>
    </tr>`
    )
    .join('');
  return `
<tr><td style="padding:18px 28px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td colspan="2" style="padding-bottom:6px;font-family:${FONT};">
      <span style="display:inline-block;width:18px;height:3px;background:${C.brand};border-radius:2px;vertical-align:middle;"></span>
      <span style="font-size:12px;font-weight:800;letter-spacing:1.2px;text-transform:uppercase;color:${C.brandDark};vertical-align:middle;margin-left:6px;">${esc(s.title)}</span>
    </td></tr>
    ${s.text ? `<tr><td colspan="2" style="padding:2px 0 8px;font-family:${FONT};font-size:13px;color:${C.ink2};line-height:1.5;">${textToHtml(s.text)}</td></tr>` : ''}
    ${items}
  </table>
</td></tr>`;
}

/**
 * Arma el HTML completo.
 *   kicker     linea chica arriba a la derecha (tipo + fecha)
 *   title      titulo grande del encabezado
 *   subtitle   bajada del encabezado (periodo, servidor...)
 *   intro      parrafo principal (texto plano)
 *   kpis       [{label, value, sub, tone}]
 *   sections   [{title, text, items: [{chip, tone, title, text}]}]
 *   cta        {url, label}
 *   attachment nombre del PDF adjunto (se menciona en el cuerpo)
 */
function renderEmail(parts, recipient, { supportEmail } = {}) {
  const ctaUrl = parts.cta?.url ?? panelUrl();
  const preheader = parts.preheader ?? parts.intro ?? '';
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(parts.title)}</title>
<style>
  @media only screen and (max-width: 600px) {
    .kpi { display: inline-block !important; width: 50% !important; box-sizing: border-box; }
    .px { padding-left: 16px !important; padding-right: 16px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(String(preheader).slice(0, 140))}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page};">
<tr><td align="center" style="padding:24px 10px;">
  <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:640px;background:${C.card};border:1px solid #EADFD5;border-radius:14px;overflow:hidden;">
    <tr><td class="px" style="background:${C.brand};background-image:linear-gradient(135deg,${C.brand700} 0%,${C.brand} 50%,${C.brand500} 100%);padding:22px 28px 24px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td valign="middle">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="background:#FFFFFF;border-radius:10px;padding:7px 12px;"><img src="cid:${LOGO_CID}" alt="Grupo Bistro" height="30" style="display:block;height:30px;width:auto;border:0;"></td>
          </tr></table>
        </td>
        <td align="right" valign="middle" style="font-family:${FONT};color:${C.soft};">
          <div style="font-size:10.5px;letter-spacing:2.5px;font-weight:800;">NOC / SOC</div>
          ${parts.kicker ? `<div style="font-size:11.5px;color:${C.soft2};margin-top:2px;">${esc(parts.kicker)}</div>` : ''}
        </td>
      </tr></table>
      <div style="font-family:${FONT};font-size:23px;line-height:1.25;font-weight:700;color:#FFFFFF;margin-top:18px;">${esc(parts.title)}</div>
      ${parts.subtitle ? `<div style="font-family:${FONT};font-size:13px;color:${C.soft2};margin-top:5px;">${esc(parts.subtitle)}</div>` : ''}
    </td></tr>
    <tr><td style="height:4px;line-height:4px;font-size:0;background:${C.brandDark};">&nbsp;</td></tr>
    ${antiPhishingHtml(recipient)}
    ${parts.intro ? `<tr><td class="px" style="padding:18px 28px 2px;font-family:${FONT};font-size:14px;line-height:1.6;color:${C.ink};">${textToHtml(parts.intro)}</td></tr>` : ''}
    ${kpisHtml(parts.kpis)}
    ${(parts.sections ?? []).map(sectionHtml).join('')}
    ${
      ctaUrl
        ? `<tr><td align="center" style="padding:24px 28px 6px;">
      <a href="${esc(ctaUrl)}" style="display:inline-block;background:${C.brand};background-image:linear-gradient(135deg,${C.brand700},${C.brand500});color:#FFFFFF;font-family:${FONT};font-size:14px;font-weight:700;text-decoration:none;padding:12px 28px;border-radius:999px;">${esc(parts.cta?.label ?? 'Abrir el NOC/SOC')} &rarr;</a>
    </td></tr>`
        : ''
    }
    ${
      parts.attachment
        ? `<tr><td class="px" style="padding:16px 28px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.panel};border:1px solid ${C.border};border-radius:10px;">
        <tr><td style="padding:10px 14px;font-family:${FONT};font-size:12px;color:${C.ink2};">
          <span style="display:inline-block;background:${C.brand};color:#FFFFFF;font-size:9px;font-weight:800;border-radius:4px;padding:2px 5px;margin-right:6px;">PDF</span>
          <b style="color:${C.ink};">${esc(parts.attachment)}</b>${parts.attachmentNote ? ` &middot; ${esc(parts.attachmentNote)}` : ''}
        </td></tr>
      </table>
    </td></tr>`
        : ''
    }
    <tr><td class="px" style="padding:22px 28px 22px;">${signatureHtml({ supportEmail })}</td></tr>
    <tr><td class="px" style="background:${C.panel};border-top:1px solid ${C.border};padding:13px 28px;font-family:${FONT};font-size:10.5px;color:${C.muted};line-height:1.5;">
      Mensaje automático, no responder. El NOC nunca te va a pedir contraseñas, PIN ni códigos por correo.${recipient?.email ? ` Enviado a ${esc(recipient.email)}.` : ''}
    </td></tr>
  </table>
  <div style="font-family:${FONT};font-size:10px;color:#A69D95;margin-top:10px;">Enterprise SOC &middot; Grupo Bistro &middot; Confidencial, uso interno</div>
</td></tr>
</table>
</body>
</html>`;
}

/** Version en texto plano (clientes sin HTML, filtros de spam). */
function renderText(parts, recipient, { supportEmail = DEFAULT_SUPPORT_EMAIL } = {}) {
  const out = [];
  if (recipient?.code) out.push(`Código anti-phishing: ${recipient.code}`, '');
  out.push(parts.title.toUpperCase());
  if (parts.subtitle) out.push(parts.subtitle);
  out.push('');
  if (parts.intro) out.push(parts.intro, '');
  if (parts.kpis?.length) {
    for (const k of parts.kpis) out.push(`- ${k.label}: ${k.value}${k.sub ? ` (${k.sub})` : ''}`);
    out.push('');
  }
  for (const s of parts.sections ?? []) {
    out.push(s.title.toUpperCase());
    if (s.text) out.push(s.text);
    for (const it of s.items ?? []) out.push(`- ${it.chip ? `[${it.chip}] ` : ''}${[it.title, it.text].filter(Boolean).join(': ')}`);
    out.push('');
  }
  if (parts.attachment) out.push(`Adjunto: ${parts.attachment}`, '');
  const url = parts.cta?.url ?? panelUrl();
  if (url) out.push(`Panel: ${url}`, '');
  out.push('--', 'ENTERPRISE SOC · GRUPO BISTRO', 'Centro de Operaciones de Seguridad y Monitoreo 24/7', `Asistencia: ${supportEmail}`);
  out.push('Mensaje automático. El NOC nunca te va a pedir contraseñas, PIN ni códigos por correo.');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------------
async function recipientDirectory() {
  const users = await prisma.user.findMany({ select: { email: true, name: true, antiPhishingCode: true } });
  return new Map(users.map((u) => [u.email.toLowerCase(), u]));
}

/**
 * Envia un correo con la plantilla del NOC, una copia por destinatario (con
 * su codigo anti-phishing). parts = ver renderEmail. Devuelve la lista de
 * destinatarios; si alguno falla lanza un Error con el motivo.
 */
async function sendBrandedMail({ to, subject, parts, attachments = [] }) {
  const cfg = await getSettings(SMTP_KEYS);
  if (!cfg.SMTP_HOST) throw new Error('Falta configurar el servidor de correo (Admin → Configuración → Notificaciones externas).');
  const recipients = parseRecipients(to);
  const directory = await recipientDirectory();
  const supportEmail = cfg.MAIL_SUPPORT_EMAIL || DEFAULT_SUPPORT_EMAIL;
  const transport = smtpTransport(cfg);
  const logo = fs.existsSync(LOGO_PATH) ? [{ filename: 'logo.png', path: LOGO_PATH, cid: LOGO_CID }] : [];
  const sent = [];
  const failed = [];
  for (const email of recipients) {
    const user = directory.get(email);
    const recipient = { email, isUser: Boolean(user), code: user?.antiPhishingCode || null };
    try {
      await transport.sendMail({
        from: smtpFrom(cfg),
        to: email,
        subject,
        html: renderEmail(parts, recipient, { supportEmail }),
        text: renderText(parts, recipient, { supportEmail }),
        attachments: [...attachments, ...logo],
      });
      sent.push(email);
    } catch (err) {
      failed.push({ email, error: smtpErrorMessage(err, cfg) });
    }
  }
  transport.close();
  if (failed.length) {
    const detail = failed[0].error;
    throw new Error(sent.length ? `Enviado a ${sent.join(', ')}, pero falló ${failed.map((f) => f.email).join(', ')}: ${detail}` : detail);
  }
  return sent;
}

module.exports = {
  SMTP_KEYS,
  smtpTransport,
  smtpFrom,
  smtpErrorMessage,
  parseRecipients,
  renderEmail,
  renderText,
  signatureHtml,
  sendBrandedMail,
  panelUrl,
  TONES,
};
