// Dibujo del reporte ejecutivo (PDFKit). Separado de reports.js (datos) para
// que el diseno se pueda cambiar sin tocar las consultas.
//
// Criterios de diseno:
//   - Una portada que se lee en 30 segundos: KPIs con semaforo + resumen de
//     la IA + recomendaciones priorizadas.
//   - Graficos simples y honestos: donut para composiciones (salud, backups),
//     barras apiladas para alertas en el tiempo, barras horizontales para
//     rankings, lineas para la tendencia de recursos. Un solo eje por grafico.
//   - Colores de ESTADO reservados (ok / advertencia / grave / critico)
//     siempre acompanados de su etiqueta; nunca color solo. El color de marca
//     solo en la cromatica (encabezados), nunca en los datos.
const fs = require('fs');
const path = require('path');

const LOGO = path.join(__dirname, '..', '..', 'assets', 'logo-bistro.png');

const C = {
  brand: '#A84F22',
  brandDark: '#6C3317',
  brandSoft: '#FBF3EC',
  ink: '#0b0b0b',
  ink2: '#52514e',
  muted: '#898781',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  surface: '#fcfcfb',
  card: '#f6f5f2',
  white: '#ffffff',
  // estados (reservados)
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
  none: '#c3c2b7',
  // series categoricas (orden fijo)
  s1: '#2a78d6',
  s2: '#eb6834',
  s3: '#1baf7a',
};

const HEALTH = [
  { key: 'OK', label: 'OK', color: C.good },
  { key: 'WARNING', label: 'Advertencia', color: C.warning },
  { key: 'CRITICAL', label: 'Crítico', color: C.critical },
  { key: 'UNKNOWN', label: 'Sin datos', color: C.none },
];
const BACKUP = [
  { key: 'SUCCESS', label: 'Exitoso', color: C.good },
  { key: 'WARNING', label: 'Advertencia', color: C.warning },
  { key: 'FAILED', label: 'Fallido', color: C.critical },
  { key: 'NOT_CONFIGURED', label: 'No configurado', color: C.muted },
  { key: 'UNKNOWN', label: 'Sin datos', color: C.none },
];
const SEVERITY = [
  { key: 'CRITICAL', label: 'Crítica', color: C.critical },
  { key: 'HIGH', label: 'Alta', color: C.serious },
  { key: 'MEDIUM', label: 'Media', color: C.warning },
  { key: 'LOW', label: 'Baja', color: C.none },
];
const BACKUP_LABEL = { SUCCESS: 'Exitoso', WARNING: 'Advertencia', FAILED: 'Fallido', NOT_CONFIGURED: 'No configurado', UNKNOWN: 'Sin datos', EXCLUDED: 'No aplica' };
const BACKUP_COLOR = { SUCCESS: C.good, WARNING: C.warning, FAILED: C.critical, NOT_CONFIGURED: C.muted, UNKNOWN: C.none, EXCLUDED: C.none };
const HEALTH_LABEL = { OK: 'OK', WARNING: 'Advertencia', CRITICAL: 'Crítico', UNKNOWN: 'Sin datos' };
const HEALTH_COLOR = { OK: C.good, WARNING: C.warning, CRITICAL: C.critical, UNKNOWN: C.none };
const PRIORITY_COLOR = { ALTA: C.critical, MEDIA: C.serious, BAJA: C.s1 };

const TYPE_LABEL = {
  CPU_THRESHOLD: 'CPU alta',
  MEMORY_THRESHOLD: 'Memoria alta',
  DISK_THRESHOLD: 'Disco lleno',
  LOGIN_FAILURE: 'Logins fallidos',
  UNAUTHORIZED_ACCESS: 'Acceso no autorizado',
  MALWARE_DETECTED: 'Malware',
  PORT_SCAN: 'Escaneo de puertos',
  BACKUP_FAILED: 'Backup fallido',
  BACKUP_WARNING: 'Backup con advertencias',
  CUSTOM: 'Otros',
  AGENT_OFFLINE: 'Servidor sin reportar',
  ANOMALY_DETECTED: 'Anomalía de uso',
  NETWORK_UNREACHABLE: 'Servicio inaccesible',
  DISK_FORECAST: 'Disco por llenarse',
  DISK_FAILURE_PREDICTED: 'Falla de disco',
  SERVICE_DOWN: 'Servicio detenido',
  REBOOT_PENDING: 'Reinicio pendiente',
  PATCHES_OUTDATED: 'Parches atrasados',
  NETWORK_DEGRADED: 'Internet degradado',
  ISP_FAILOVER: 'Enlace de respaldo',
  INTERNET_OUTAGE: 'Corte de internet',
  DHCP_SCOPE_EXHAUSTED: 'DHCP sin IPs',
  IP_CONFLICT: 'Conflicto de IP',
  PRINTER_ISSUE: 'Impresora',
  AD_ACCOUNT_LOCKOUT: 'Cuenta AD bloqueada',
  PRIVILEGED_GROUP_CHANGE: 'Cambio de grupo privilegiado',
  APP_SERVICE_DOWN: 'Aplicación caída',
  APP_PERFORMANCE: 'Aplicación lenta',
  NETWORK_MICROCUTS: 'Micro-cortes de red',
};

const PAGE = { w: 595.28, h: 841.89, m: 40 };
const CW = PAGE.w - PAGE.m * 2; // ancho util
const BOTTOM = PAGE.h - 50; // limite antes del pie

function fmtBytes(b) {
  if (!b && b !== 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}
function fmtDate(d, withTime = true) {
  if (!d) return '—';
  const opts = withTime ? { dateStyle: 'short', timeStyle: 'short' } : { dateStyle: 'short' };
  return new Date(d).toLocaleString('es-AR', { ...opts, timeZone: process.env.APP_TIMEZONE || undefined });
}
function fmtMinutes(m) {
  if (m === null || m === undefined) return '—';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${m % 60} min` : `${Math.round(h / 24)} días`;
}
function pct(v, digits = 0) {
  return v === null || v === undefined ? '—' : `${Number(v).toFixed(digits)}%`;
}
// Solo caracteres que las fuentes estandar de PDF (WinAnsi) pueden dibujar.
function safe(text) {
  return String(text ?? '')
    .replace(/[←-⇿☀-➿\u{1F300}-\u{1FAFF}]/gu, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
}

class Report {
  constructor(doc, data) {
    this.doc = doc;
    this.data = data;
    this.y = PAGE.m;
  }

  // --- pagina / cursor ---------------------------------------------------
  newPage(title) {
    this.doc.addPage();
    this.pageHeader(title);
  }

  pageHeader(title) {
    const { doc } = this;
    doc.rect(0, 0, PAGE.w, 34).fill(C.brand);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(C.white).text('Enterprise SOC · Reporte ejecutivo', PAGE.m, 12, { width: CW / 2, lineBreak: false });
    doc.font('Helvetica').fontSize(9).fillColor(C.white).text(safe(title), PAGE.m + CW / 2, 13, { width: CW / 2, align: 'right', lineBreak: false });
    this.y = 52;
  }

  ensure(h, title) {
    if (this.y + h > BOTTOM) this.newPage(title ?? this.currentTitle ?? '');
  }

  section(title, subtitle) {
    this.currentTitle = title;
    this.ensure(60, title);
    const { doc } = this;
    doc.rect(PAGE.m, this.y + 2, 3, 14).fill(C.brand);
    doc.font('Helvetica-Bold').fontSize(13).fillColor(C.ink).text(safe(title), PAGE.m + 10, this.y, { width: CW - 10 });
    this.y = doc.y + 1;
    if (subtitle) {
      doc.font('Helvetica').fontSize(8.5).fillColor(C.muted).text(safe(subtitle), PAGE.m + 10, this.y, { width: CW - 10 });
      this.y = doc.y;
    }
    this.y += 8;
  }

  paragraph(text, opts = {}) {
    const { doc } = this;
    doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.size ?? 9.5).fillColor(opts.color ?? C.ink2);
    const h = doc.heightOfString(safe(text), { width: opts.width ?? CW, lineGap: 2 });
    this.ensure(h + 4);
    doc.text(safe(text), opts.x ?? PAGE.m, this.y, { width: opts.width ?? CW, lineGap: 2, align: opts.align ?? 'left' });
    this.y = doc.y + (opts.after ?? 6);
  }

  // --- piezas -----------------------------------------------------------
  statusDot(x, y, color, r = 3.2) {
    this.doc.circle(x, y, r).fill(color);
  }

  kpi(x, y, w, h, { label, value, sub, status }) {
    const { doc } = this;
    doc.roundedRect(x, y, w, h, 6).fill(C.card);
    if (status) doc.roundedRect(x, y, 3.5, h, 1.5).fill(status);
    doc.font('Helvetica').fontSize(7.5).fillColor(C.muted).text(safe(label).toUpperCase(), x + 11, y + 9, { width: w - 18, height: 9, ellipsis: true, characterSpacing: 0.3 });
    doc.font('Helvetica-Bold').fontSize(19).fillColor(C.ink).text(safe(value), x + 11, y + 21, { width: w - 18, height: 22, ellipsis: true });
    if (sub) doc.font('Helvetica').fontSize(7.5).fillColor(C.ink2).text(safe(sub), x + 11, y + 43, { width: w - 18, height: h - 46, ellipsis: true, lineGap: 0.5 });
  }

  kpiRow(items, h = 64) {
    const gap = 8;
    const w = (CW - gap * (items.length - 1)) / items.length;
    this.ensure(h + 8);
    items.forEach((it, i) => this.kpi(PAGE.m + i * (w + gap), this.y, w, h, it));
    this.y += h + gap;
  }

  legend(items, x, y, width) {
    const { doc } = this;
    let cy = y;
    for (const it of items) {
      this.statusDot(x + 4, cy + 4, it.color);
      doc.font('Helvetica').fontSize(8.5).fillColor(C.ink2).text(safe(it.label), x + 12, cy, { width: width - 50, height: 10, ellipsis: true });
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(C.ink).text(String(it.value), x + width - 36, cy, { width: 34, align: 'right', lineBreak: false });
      cy += 14;
    }
  }

  // Donut con leyenda (valor + etiqueta por segmento): composicion de un total.
  donut(x, y, size, title, items, centerLabel) {
    const { doc } = this;
    const total = items.reduce((a, i) => a + i.value, 0);
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(C.ink).text(safe(title), x, y, { width: 240 });
    const cx = x + size / 2;
    const cy = y + 18 + size / 2;
    const rOut = size / 2;
    const rIn = rOut * 0.62;
    if (total === 0) {
      doc.circle(cx, cy, rOut).fill(C.grid);
      doc.circle(cx, cy, rIn).fill(C.white);
    } else {
      let a0 = -Math.PI / 2;
      for (const it of items.filter((i) => i.value > 0)) {
        const a1 = a0 + (it.value / total) * Math.PI * 2;
        const large = a1 - a0 > Math.PI ? 1 : 0;
        const p = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
        if (it.value === total) {
          doc.circle(cx, cy, rOut).fill(it.color);
        } else {
          const [x0, y0] = p(rOut, a0);
          const [x1, y1] = p(rOut, a1);
          const [x2, y2] = p(rIn, a1);
          const [x3, y3] = p(rIn, a0);
          doc
            .path(`M ${x0} ${y0} A ${rOut} ${rOut} 0 ${large} 1 ${x1} ${y1} L ${x2} ${y2} A ${rIn} ${rIn} 0 ${large} 0 ${x3} ${y3} Z`)
            .fillColor(it.color)
            .fill();
          // separador de 2px del color de fondo
          doc.moveTo(cx + rIn * Math.cos(a0), cy + rIn * Math.sin(a0)).lineTo(x0, y0).lineWidth(2).strokeColor(C.white).stroke();
        }
        a0 = a1;
      }
      doc.circle(cx, cy, rIn).fill(C.white);
    }
    doc.font('Helvetica-Bold').fontSize(16).fillColor(C.ink).text(safe(centerLabel?.value ?? String(total)), cx - rIn, cy - 11, { width: rIn * 2, align: 'center', lineBreak: false });
    doc.font('Helvetica').fontSize(7).fillColor(C.muted).text(safe(centerLabel?.label ?? 'total'), cx - rIn, cy + 7, { width: rIn * 2, align: 'center', lineBreak: false });
    this.legend(items, x + size + 14, y + 26, 240 - size - 14);
  }

  // Barras horizontales (ranking de una sola serie).
  hbars(x, y, w, title, rows, { color = C.s1, max, valueFmt = (v) => String(v), labelW = 120 } = {}) {
    const { doc } = this;
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(C.ink).text(safe(title), x, y, { width: w });
    let cy = y + 18;
    if (rows.length === 0) {
      doc.font('Helvetica').fontSize(8.5).fillColor(C.muted).text('Sin datos en el período.', x, cy);
      return cy + 14;
    }
    const top = max ?? Math.max(...rows.map((r) => r.value), 1);
    const barW = w - labelW - 40;
    for (const r of rows) {
      doc.font('Helvetica').fontSize(8).fillColor(C.ink2).text(safe(r.label), x, cy + 1, { width: labelW - 6, height: 10, ellipsis: true });
      doc.rect(x + labelW, cy + 1, barW, 9).fill(C.card);
      const bw = Math.max(2, (r.value / top) * barW);
      doc.roundedRect(x + labelW, cy + 1, bw, 9, 2).fill(r.color ?? color);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(C.ink).text(valueFmt(r.value), x + labelW + barW + 4, cy + 1, { width: 36, lineBreak: false });
      cy += 15;
    }
    return cy;
  }

  // Columnas apiladas por severidad (alertas en el tiempo).
  stackedColumns(x, y, w, h, title, buckets, series, labelFmt) {
    const { doc } = this;
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(C.ink).text(safe(title), x, y, { width: w });
    const top = y + 18;
    const plotH = h - 40;
    const totals = buckets.map((b) => series.reduce((a, s) => a + (b[s.key] ?? 0), 0));
    const maxV = Math.max(4, ...totals);
    const step = niceStep(maxV);
    const yMax = Math.ceil(maxV / step) * step;
    const axisX = x + 24;
    const plotW = w - 24;
    // grilla + eje
    for (let v = 0; v <= yMax; v += step) {
      const gy = top + plotH - (v / yMax) * plotH;
      doc.moveTo(axisX, gy).lineTo(axisX + plotW, gy).lineWidth(0.5).strokeColor(v === 0 ? C.axis : C.grid).stroke();
      doc.font('Helvetica').fontSize(6.5).fillColor(C.muted).text(String(v), x, gy - 3, { width: 20, align: 'right', lineBreak: false });
    }
    const slot = plotW / buckets.length;
    const bw = Math.max(1.5, Math.min(22, slot - 2));
    buckets.forEach((b, i) => {
      let base = top + plotH;
      const bx = axisX + i * slot + (slot - bw) / 2;
      for (const s of series) {
        const v = b[s.key] ?? 0;
        if (!v) continue;
        const bh = (v / yMax) * plotH;
        doc.rect(bx, base - bh, bw, bh).fill(s.color);
        base -= bh;
        if (base < top + plotH - 0.5) doc.moveTo(bx, base).lineTo(bx + bw, base).lineWidth(1).strokeColor(C.white).stroke();
      }
    });
    // etiquetas del eje X (espaciadas)
    const every = Math.ceil(buckets.length / 10);
    buckets.forEach((b, i) => {
      if (i % every !== 0 && i !== buckets.length - 1) return;
      doc.font('Helvetica').fontSize(6.5).fillColor(C.muted).text(labelFmt(b.t), axisX + i * slot - 12, top + plotH + 4, { width: slot + 24, align: 'center', lineBreak: false });
    });
    // leyenda en linea
    let lx = axisX;
    const ly = top + plotH + 16;
    for (const s of series) {
      this.statusDot(lx + 3, ly + 3.5, s.color);
      const label = `${s.label} (${buckets.reduce((a, b) => a + (b[s.key] ?? 0), 0)})`;
      doc.font('Helvetica').fontSize(7.5).fillColor(C.ink2).text(label, lx + 9, ly, { lineBreak: false });
      lx += doc.widthOfString(label) + 22;
    }
  }

  // Lineas (misma unidad, un solo eje 0-100%).
  lines(x, y, w, h, title, points, series, labelFmt) {
    const { doc } = this;
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(C.ink).text(safe(title), x, y, { width: w });
    const top = y + 18;
    const plotH = h - 40;
    const axisX = x + 26;
    const plotW = w - 60;
    for (let v = 0; v <= 100; v += 25) {
      const gy = top + plotH - (v / 100) * plotH;
      doc.moveTo(axisX, gy).lineTo(axisX + plotW, gy).lineWidth(0.5).strokeColor(v === 0 ? C.axis : C.grid).stroke();
      doc.font('Helvetica').fontSize(6.5).fillColor(C.muted).text(`${v}%`, x, gy - 3, { width: 22, align: 'right', lineBreak: false });
    }
    if (points.length === 0) {
      doc.font('Helvetica').fontSize(8.5).fillColor(C.muted).text('Sin telemetría en el período.', axisX + 8, top + plotH / 2 - 5);
      return;
    }
    const px = (i) => axisX + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
    const py = (v) => top + plotH - (Math.min(100, Math.max(0, v)) / 100) * plotH;
    for (const s of series) {
      let started = false;
      points.forEach((p, i) => {
        const v = p[s.key];
        if (v === null || v === undefined) {
          started = false;
          return;
        }
        if (!started) doc.moveTo(px(i), py(v));
        else doc.lineTo(px(i), py(v));
        started = true;
      });
      doc.lineWidth(1.6).strokeColor(s.color).lineJoin('round').stroke();
      // etiqueta directa al final de la linea
      const last = [...points].reverse().find((p) => p[s.key] !== null && p[s.key] !== undefined);
      if (last) {
        const i = points.lastIndexOf(last);
        doc.circle(px(i), py(last[s.key]), 2.2).fill(s.color);
        doc.font('Helvetica-Bold').fontSize(7).fillColor(C.ink2).text(`${s.label} ${Math.round(last[s.key])}%`, px(i) + 5, py(last[s.key]) - 4, { lineBreak: false });
      }
    }
    const every = Math.ceil(points.length / 8);
    points.forEach((p, i) => {
      if (i % every !== 0 && i !== points.length - 1) return;
      doc.font('Helvetica').fontSize(6.5).fillColor(C.muted).text(labelFmt(p.t), px(i) - 20, top + plotH + 4, { width: 40, align: 'center', lineBreak: false });
    });
    let lx = axisX;
    const ly = top + plotH + 16;
    for (const s of series) {
      doc.moveTo(lx, ly + 3.5).lineTo(lx + 10, ly + 3.5).lineWidth(1.6).strokeColor(s.color).stroke();
      doc.font('Helvetica').fontSize(7.5).fillColor(C.ink2).text(s.legend, lx + 14, ly, { lineBreak: false });
      lx += doc.widthOfString(s.legend) + 28;
    }
  }

  // Mini barra de porcentaje dentro de una celda de tabla.
  meter(x, y, w, v, thresholds = [80, 90]) {
    const { doc } = this;
    if (v === null || v === undefined) {
      doc.font('Helvetica').fontSize(7.5).fillColor(C.muted).text('—', x, y, { lineBreak: false });
      return;
    }
    const color = v >= thresholds[1] ? C.critical : v >= thresholds[0] ? C.warning : C.good;
    doc.rect(x, y + 2, w - 26, 5).fill(C.card);
    doc.rect(x, y + 2, Math.max(1, ((w - 26) * Math.min(100, v)) / 100), 5).fill(color);
    doc.font('Helvetica').fontSize(7.5).fillColor(C.ink).text(`${Math.round(v)}%`, x + w - 24, y, { width: 24, lineBreak: false });
  }

  // Tabla generica con encabezado repetido al cambiar de pagina.
  table(columns, rows, { rowH = 16, zebra = true } = {}) {
    const { doc } = this;
    const header = () => {
      doc.rect(PAGE.m, this.y, CW, 16).fill(C.brandSoft);
      let x = PAGE.m + 4;
      for (const c of columns) {
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.brandDark).text(c.label, x, this.y + 5, { width: c.w - 6, height: 9, ellipsis: true, align: c.align ?? 'left' });
        x += c.w;
      }
      this.y += 17;
    };
    this.ensure(16 + rowH * Math.min(rows.length, 3));
    header();
    rows.forEach((row, ri) => {
      if (this.y + rowH > BOTTOM) {
        this.newPage(this.currentTitle);
        header();
      }
      if (zebra && ri % 2 === 1) doc.rect(PAGE.m, this.y, CW, rowH).fill(C.surface);
      let x = PAGE.m + 4;
      for (const c of columns) {
        const cy = c.multiline ? this.y + 3 : this.y + (rowH - 8) / 2;
        if (c.render) c.render(row, x, cy, c.w - 6);
        else {
          doc
            .font(c.bold ? 'Helvetica-Bold' : 'Helvetica')
            .fontSize(7.5)
            .fillColor(C.ink)
            .text(safe(c.value(row)), x, cy, { width: c.w - 6, height: c.multiline ? rowH - 4 : 9, ellipsis: true, align: c.align ?? 'left' });
        }
        x += c.w;
      }
      doc.moveTo(PAGE.m, this.y + rowH).lineTo(PAGE.m + CW, this.y + rowH).lineWidth(0.4).strokeColor(C.grid).stroke();
      this.y += rowH;
    });
    this.y += 10;
  }

  statusCell(color, label) {
    return (row, x, y, w) => {
      this.statusDot(x + 3, y + 3.5, color(row));
      this.doc.font('Helvetica').fontSize(7.5).fillColor(C.ink).text(safe(label(row)), x + 10, y, { width: w - 10, height: 9, ellipsis: true });
    };
  }
}

function niceStep(max) {
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

// ---------------------------------------------------------------------------
// Composicion del reporte
// ---------------------------------------------------------------------------
function drawCover(r) {
  const { doc, data } = r;
  // banda superior
  doc.rect(0, 0, PAGE.w, 150).fill(C.brand);
  doc.rect(0, 150, PAGE.w, 4).fill(C.brandDark);
  if (fs.existsSync(LOGO)) {
    doc.roundedRect(PAGE.m, 30, 128, 50, 6).fill(C.white);
    doc.image(LOGO, PAGE.m + 8, 36, { fit: [112, 38], align: 'center', valign: 'center' });
  }
  doc.font('Helvetica-Bold').fontSize(22).fillColor(C.white).text('Reporte Ejecutivo NOC/SOC', PAGE.m + 146, 34, { width: CW - 146 });
  doc.font('Helvetica').fontSize(10.5).fillColor(C.brandSoft).text('Grupo Bistro · Infraestructura, backups, red y seguridad', PAGE.m + 146, 62, { width: CW - 146 });
  const periodLabel = data.periodDays === 1 ? 'Últimas 24 horas' : `Últimos ${data.periodDays} días`;
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor(C.white)
    .text(`${periodLabel} · ${fmtDate(data.periodStart, false)} al ${fmtDate(data.generatedAt, false)} · Generado ${fmtDate(data.generatedAt)}`, PAGE.m, 112, { width: CW });
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(C.brandSoft).text('CONFIDENCIAL · USO INTERNO', PAGE.m, 128, { width: CW, characterSpacing: 1 });
  r.y = 172;

  const h = data.healthBreakdown;
  const b = data.backupBreakdown;
  const backupTotal = Object.values(b).reduce((a, x) => a + x, 0);
  const crit = data.severityCounts.CRITICAL;
  const avail = data.availabilityAvg;

  r.kpiRow([
    {
      label: 'Disponibilidad',
      value: avail === null ? '—' : pct(avail, 2),
      sub: 'promedio de servidores en el período',
      status: avail === null ? C.none : avail >= 99.5 ? C.good : avail >= 98 ? C.warning : C.critical,
    },
    {
      label: 'Servidores OK',
      value: `${h.OK}/${data.totalServers}`,
      sub: `${h.WARNING} advertencia · ${h.CRITICAL} crítico`,
      status: h.CRITICAL > 0 ? C.critical : h.WARNING > 0 ? C.warning : C.good,
    },
    {
      label: 'Backups exitosos',
      value: `${b.SUCCESS}/${backupTotal}`,
      sub: `${b.FAILED} fallido(s) · ${b.WARNING} con advertencia`,
      status: b.FAILED > 0 ? C.critical : b.WARNING > 0 ? C.warning : C.good,
    },
    {
      label: 'Alertas del período',
      value: String(data.eventsOpenedInPeriod),
      sub: `${crit} crítica(s) · ${data.openNow} siguen abiertas`,
      status: data.stillOpenCritical.length > 0 ? C.critical : crit > 0 ? C.serious : C.good,
    },
  ]);
  r.kpiRow([
    {
      label: 'Resolución promedio',
      value: fmtMinutes(data.avgResolutionMinutes),
      sub: `${data.eventsResolvedInPeriod} alerta(s) resuelta(s)`,
      status: data.avgResolutionMinutes === null ? C.none : data.avgResolutionMinutes <= 60 ? C.good : data.avgResolutionMinutes <= 240 ? C.warning : C.serious,
    },
    {
      label: 'Cortes de internet',
      value: String(data.outages),
      sub: data.outages ? `${fmtMinutes(data.outageMinutes)} sin servicio en total` : 'sin cortes registrados',
      status: data.outages === 0 ? C.good : data.outageMinutes > 60 ? C.critical : C.warning,
    },
    {
      label: 'Discos en riesgo',
      value: String(data.disksAtRisk.length),
      sub: data.disksAtRisk.length ? `máx. ${pct(data.disksAtRisk[0].percent)} en ${data.disksAtRisk[0].server}` : 'todos bajo 85%',
      status: data.disksAtRisk.some((d) => d.percent >= 95) ? C.critical : data.disksAtRisk.length ? C.warning : C.good,
    },
    {
      label: 'Seguridad',
      value: String(data.malwareDetections + data.fortiCriticalInPeriod),
      sub: `${data.malwareDetections} malware · ${data.fortiCriticalInPeriod} Forti crítico(s)`,
      status: data.malwareDetections > 0 ? C.critical : data.fortiCriticalInPeriod > 0 ? C.serious : C.good,
    },
  ]);
  r.y += 6;

  // Resumen y recomendaciones de la IA
  const ins = data.insights;
  r.section('Resumen ejecutivo', ins?.source === 'ai' ? 'Redactado por IA a partir de los datos agregados del período (sin datos personales ni de la red interna).' : 'Generado automáticamente a partir de los datos del período.');
  if (ins?.summary) r.paragraph(ins.summary, { size: 10, color: C.ink, after: 10 });

  if (ins?.recommendations?.length) {
    r.section('Recomendaciones priorizadas');
    for (const rec of ins.recommendations.slice(0, 7)) {
      const color = PRIORITY_COLOR[rec.priority] ?? C.s1;
      const title = safe(rec.title);
      const detail = safe(rec.detail ?? '');
      doc.font('Helvetica-Bold').fontSize(9.5);
      const th = doc.heightOfString(title, { width: CW - 78 });
      doc.font('Helvetica').fontSize(8.5);
      const dh = detail ? doc.heightOfString(detail, { width: CW - 78, lineGap: 1.5 }) : 0;
      const boxH = Math.max(34, th + dh + 16);
      r.ensure(boxH + 6, 'Recomendaciones');
      doc.roundedRect(PAGE.m, r.y, CW, boxH, 5).fill(C.card);
      doc.roundedRect(PAGE.m + 8, r.y + 9, 50, 14, 7).fill(color);
      doc.font('Helvetica-Bold').fontSize(7).fillColor(C.white).text(rec.priority, PAGE.m + 8, r.y + 13, { width: 50, align: 'center', lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(C.ink).text(title, PAGE.m + 68, r.y + 8, { width: CW - 78 });
      if (detail) doc.font('Helvetica').fontSize(8.5).fillColor(C.ink2).text(detail, PAGE.m + 68, doc.y + 2, { width: CW - 78, lineGap: 1.5 });
      r.y += boxH + 6;
    }
  }
}

function drawCharts(r) {
  const { data } = r;
  r.newPage('Estado general');
  r.section('Estado general de la infraestructura', 'Foto al momento de generar el reporte.');
  const y0 = r.y;
  r.donut(
    PAGE.m,
    y0,
    96,
    'Salud de servidores',
    HEALTH.map((s) => ({ ...s, value: data.healthBreakdown[s.key] })),
    { value: String(data.totalServers), label: 'servidores' }
  );
  r.donut(
    PAGE.m + CW / 2 + 8,
    y0,
    96,
    'Estado de backups',
    BACKUP.map((s) => ({ ...s, value: data.backupBreakdown[s.key] })),
    { value: String(Object.values(data.backupBreakdown).reduce((a, x) => a + x, 0)), label: 'con backup' }
  );
  r.y = y0 + 130;

  const labelFmt = data.hourly
    ? (t) => new Date(t).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: process.env.APP_TIMEZONE || undefined })
    : (t) => new Date(t).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });

  r.section('Alertas en el período', data.hourly ? 'Por hora, apiladas por severidad.' : 'Por día, apiladas por severidad.');
  r.ensure(170);
  r.stackedColumns(PAGE.m, r.y, CW, 170, `${data.eventsOpenedInPeriod} alertas generadas`, data.timeline, SEVERITY, labelFmt);
  r.y += 176;

  r.ensure(190);
  const yb = r.y;
  const endL = r.hbars(
    PAGE.m,
    yb,
    CW / 2 - 10,
    'Servidores con más alertas',
    data.topOffenders.slice(0, 8).map(([name, v]) => ({ label: name, value: v })),
    { color: C.s1, labelW: 100 }
  );
  const endR = r.hbars(
    PAGE.m + CW / 2 + 10,
    yb,
    CW / 2 - 10,
    'Alertas por tipo',
    data.topTypes.map(([type, v]) => ({ label: TYPE_LABEL[type] ?? type, value: v })),
    { color: C.s1, labelW: 110 }
  );
  r.y = Math.max(endL, endR) + 10;

  r.section('Uso de recursos de la flota', 'Promedio de CPU y RAM de todos los servidores; disco = el más lleno.');
  r.ensure(170);
  r.lines(
    PAGE.m,
    r.y,
    CW,
    170,
    'CPU, RAM y disco (%)',
    data.fleetTrend,
    [
      { key: 'cpu', label: 'CPU', legend: 'CPU promedio', color: C.s1 },
      { key: 'mem', label: 'RAM', legend: 'RAM promedio', color: C.s2 },
      { key: 'disk', label: 'Disco', legend: 'Disco más lleno', color: C.s3 },
    ],
    labelFmt
  );
  r.y += 176;
}

function drawServers(r) {
  const { data, doc } = r;
  r.newPage('Detalle por servidor');
  r.section('Detalle por servidor', 'Estado actual, recursos, backup, alertas y disponibilidad en el período.');
  r.table(
    [
      { label: 'Servidor', w: 88, bold: true, value: (s) => s.name },
      { label: 'Salud', w: 66, render: r.statusCell((s) => HEALTH_COLOR[s.health], (s) => (s.status === 'OFFLINE' ? 'Sin reportar' : HEALTH_LABEL[s.health])) },
      { label: 'CPU', w: 56, render: (s, x, y, w) => r.meter(x, y, w, s.cpuUsage, [70, 90]) },
      { label: 'RAM', w: 56, render: (s, x, y, w) => r.meter(x, y, w, s.memoryUsage, [80, 92]) },
      { label: 'Disco C:', w: 56, render: (s, x, y, w) => r.meter(x, y, w, s.diskUsage, [85, 95]) },
      { label: 'Backup', w: 70, render: r.statusCell((s) => BACKUP_COLOR[s.backupResult], (s) => BACKUP_LABEL[s.backupResult]) },
      { label: 'Últ. backup', w: 55, value: (s) => (s.backupResult === 'EXCLUDED' ? '—' : fmtDate(s.backupLastAt, false)) },
      { label: 'Alertas', w: 32, align: 'right', value: (s) => String(s.alerts) },
      { label: 'Disp.', w: 36, align: 'right', value: (s) => pct(s.availability, 1) },
    ],
    data.serverRows
  );

  if (data.disksAtRisk.length) {
    r.section('Discos en riesgo', 'Unidades al 85% o más, o que al ritmo actual llegan al 95% en menos de 30 días.');
    r.table(
      [
        { label: 'Servidor', w: 130, bold: true, value: (d) => d.server },
        { label: 'Unidad', w: 60, value: (d) => d.mount },
        { label: 'Uso', w: 120, render: (d, x, y, w) => r.meter(x, y, w, d.percent, [85, 95]) },
        { label: 'Libre', w: 80, value: (d) => fmtBytes(d.freeBytes) },
        { label: 'Llega al 95% en', w: 125, value: (d) => (d.daysTo95 ? `~${d.daysTo95} día(s)` : '—') },
      ],
      data.disksAtRisk.slice(0, 20)
    );
  }

  if (data.stillOpenCritical.length) {
    r.section('Alertas críticas sin resolver');
    r.table(
      [
        { label: 'Desde', w: 80, value: (e) => fmtDate(e.createdAt) },
        { label: 'Servidor', w: 80, bold: true, value: (e) => e.server?.name ?? '—' },
        { label: 'Tipo', w: 95, value: (e) => TYPE_LABEL[e.type] ?? e.type },
        { label: 'Descripción', w: 260, multiline: true, value: (e) => e.description },
      ],
      data.stillOpenCritical.slice(0, 25),
      { rowH: 22 }
    );
  }

  // Salud preventiva de la flota
  r.section('Mantenimiento preventivo');
  r.kpiRow(
    [
      { label: 'Parches atrasados', value: String(data.patchesOutdated), sub: '+45 días sin parches o críticos pendientes', status: data.patchesOutdated ? C.warning : C.good },
      { label: 'Reinicio pendiente', value: String(data.rebootPending), sub: 'para terminar de aplicar actualizaciones', status: data.rebootPending ? C.warning : C.good },
      { label: 'Logins fallidos (24 h)', value: String(data.failedLogons), sub: 'suma de todos los servidores', status: data.failedLogons >= 200 ? C.serious : C.good },
      { label: 'Eventos Fortinet', value: String(data.fortiEventsInPeriod), sub: `${data.fortiCriticalInPeriod} crítico(s) en el período`, status: data.fortiCriticalInPeriod ? C.serious : C.good },
    ],
    64
  );
  doc.fillColor(C.ink);
}

function drawNetwork(r) {
  const { data } = r;
  const inv = data.inventory;
  const u = data.unifi;
  const hasInv = inv && (inv.endpointsTotal > 0 || inv.scopes.length > 0 || inv.printersTotal > 0);
  if (!hasInv && !u.sites) return;
  r.newPage('Red e inventario');
  r.section('Red, WiFi e inventario');
  r.kpiRow([
    { label: 'Equipos del dominio', value: String(inv.endpointsTotal), sub: `${inv.endpointsOnline} encendidos al generar`, status: C.s1 },
    { label: 'Access Points', value: u.aps ? `${u.aps - u.apsOffline}/${u.aps}` : '—', sub: `${u.sites} sitio(s) UniFi · ${u.clients} clientes WiFi`, status: u.apsOffline ? C.critical : u.aps ? C.good : C.none },
    { label: 'Impresoras', value: String(inv.printersTotal), sub: `${inv.printersWithIssues.length} con problemas · ${inv.lowSupplies.length} consumible(s) bajos`, status: inv.printersWithIssues.length ? C.warning : C.good },
    { label: 'Active Directory', value: String(inv.lockedUsers), sub: `bloqueados ahora · ${inv.expiringPasswords} claves vencen en 7 días`, status: inv.lockedUsers ? C.warning : C.good },
  ]);

  if (inv.scopes.length) {
    r.ensure(30 + inv.scopes.length * 15);
    r.y = r.hbars(
      PAGE.m,
      r.y,
      CW,
      'Ocupación de los ámbitos DHCP',
      inv.scopes.map((s) => ({
        label: `${s.name ?? s.id} (${s.free} libres)`,
        value: s.percentInUse,
        color: s.percentInUse >= 90 ? C.critical : s.percentInUse >= 80 ? C.warning : C.good,
      })),
      { max: 100, valueFmt: (v) => `${Math.round(v)}%`, labelW: 190 }
    ) + 8;
  }

  r.section('Actividad del directorio en el período', 'Solo totales: el detalle por usuario queda en el NOC.');
  r.paragraph(
    `Inicios de sesión registrados: ${inv.logonsInPeriod} · Bloqueos de cuenta: ${inv.lockouts} · Altas a grupos privilegiados: ${inv.privChanges}.`
  );

  if (inv.printersWithIssues.length || inv.lowSupplies.length) {
    r.section('Impresoras que requieren atención');
    for (const p of inv.printersWithIssues.slice(0, 12)) r.paragraph(`• ${p}`, { after: 2, size: 8.5 });
    for (const p of inv.lowSupplies.slice(0, 12)) r.paragraph(`• Consumible bajo: ${p}`, { after: 2, size: 8.5 });
  }
}

function drawFooters(doc) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    doc.moveTo(PAGE.m, PAGE.h - 34).lineTo(PAGE.w - PAGE.m, PAGE.h - 34).lineWidth(0.5).strokeColor(C.grid).stroke();
    doc
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(C.muted)
      .text('Enterprise SOC · Grupo Bistro · Confidencial - uso interno', PAGE.m, PAGE.h - 28, { width: CW / 2, lineBreak: false });
    doc.text(`Página ${i + 1} de ${range.count}`, PAGE.m + CW / 2, PAGE.h - 28, { width: CW / 2, align: 'right', lineBreak: false });
  }
}

function drawReportPdf(doc, data) {
  const r = new Report(doc, data);
  drawCover(r);
  drawCharts(r);
  drawServers(r);
  drawNetwork(r);
  drawFooters(doc);
}

module.exports = { drawReportPdf, TYPE_LABEL };
