// Cuerpo del correo de los reportes (diario / semanal / a demanda): un
// resumen breve para leer en el celular; el detalle va en el PDF adjunto.
const { TYPE_LABEL } = require('./reportPdf');

const KIND = {
  daily: { label: 'Diario', title: 'Reporte diario del NOC/SOC', note: 'Detalle de alertas, servidores con novedades, backups y discos del período.' },
  weekly: { label: 'Semanal', title: 'Reporte semanal general', note: 'Reporte general completo: gráficos, detalle por servidor, red e inventario.' },
  manual: { label: 'Ejecutivo', title: 'Reporte ejecutivo del NOC/SOC', note: 'Reporte completo del período.' },
};
const SEVERITY_LABEL = { LOW: 'BAJA', MEDIUM: 'MEDIA', HIGH: 'ALTA', CRITICAL: 'CRÍTICA' };
const SEVERITY_TONE = { LOW: 'info', MEDIUM: 'warn', HIGH: 'warn', CRITICAL: 'bad' };
const PRIORITY_TONE = { ALTA: 'bad', MEDIA: 'warn', BAJA: 'info' };

function fmt(date, tz, opts) {
  return new Date(date).toLocaleString('es-AR', { timeZone: tz || undefined, ...opts });
}

function shortText(text, max = 170) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function minutes(m) {
  if (m === null || m === undefined) return '—';
  if (m < 60) return `${Math.round(m)} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${Math.round(m % 60)} min`;
}

/** Estado general para el asunto: "Todo en orden" / "3 puntos a revisar" / "2 críticos". */
function headline(data) {
  const offline = data.serverRows.filter((s) => s.status === 'OFFLINE').length;
  const critical = data.stillOpenCritical.length + (data.backupBreakdown.FAILED ?? 0) + offline;
  const recs = (data.insights?.recommendations ?? []).filter((r) => r.priority === 'ALTA' || r.priority === 'MEDIA').length;
  if (critical > 0) return `${critical} punto(s) crítico(s)`;
  if (recs > 0) return `${recs} punto(s) a revisar`;
  return 'Todo en orden';
}

function kpis(data, full) {
  const h = data.healthBreakdown;
  const b = data.backupBreakdown;
  const backupTotal = Object.values(b).reduce((a, x) => a + x, 0);
  const avail = data.availabilityAvg;
  const crit = data.severityCounts.CRITICAL;
  const list = [
    {
      label: 'Disponibilidad',
      value: avail === null ? '—' : `${avail.toFixed(2)} %`,
      sub: 'promedio de servidores',
      tone: avail === null ? 'muted' : avail >= 99.5 ? 'ok' : avail >= 98 ? 'warn' : 'bad',
    },
    {
      label: 'Servidores OK',
      value: `${h.OK}/${data.totalServers}`,
      sub: `${h.WARNING} advert. · ${h.CRITICAL} crítico`,
      tone: h.CRITICAL > 0 ? 'bad' : h.WARNING > 0 ? 'warn' : 'ok',
    },
    {
      label: 'Backups OK',
      value: `${b.SUCCESS}/${backupTotal}`,
      sub: `${b.FAILED} fallido(s) · ${b.WARNING} advert.`,
      tone: b.FAILED > 0 ? 'bad' : b.WARNING > 0 ? 'warn' : 'ok',
    },
    {
      label: 'Alertas',
      value: String(data.eventsOpenedInPeriod),
      sub: `${crit} crítica(s) · ${data.openNow} abiertas`,
      tone: data.stillOpenCritical.length > 0 ? 'bad' : crit > 0 ? 'warn' : 'ok',
    },
  ];
  if (full) {
    list.push(
      {
        label: 'Resolución prom.',
        value: minutes(data.avgResolutionMinutes),
        sub: `${data.eventsResolvedInPeriod} resuelta(s)`,
        tone: data.avgResolutionMinutes === null ? 'muted' : data.avgResolutionMinutes <= 60 ? 'ok' : data.avgResolutionMinutes <= 240 ? 'warn' : 'bad',
      },
      {
        label: 'Cortes internet',
        value: String(data.outages),
        sub: data.outages ? `${minutes(data.outageMinutes)} sin servicio` : 'sin cortes',
        tone: data.outages === 0 ? 'ok' : data.outageMinutes > 60 ? 'bad' : 'warn',
      },
      {
        label: 'Discos en riesgo',
        value: String(data.disksAtRisk.length),
        sub: data.disksAtRisk.length ? `máx. ${Math.round(data.disksAtRisk[0].percent ?? 0)} % ${data.disksAtRisk[0].server}` : 'todos bajo 85 %',
        tone: data.disksAtRisk.some((d) => d.percent >= 95) ? 'bad' : data.disksAtRisk.length ? 'warn' : 'ok',
      },
      {
        label: 'Seguridad',
        value: String(data.malwareDetections + data.fortiCriticalInPeriod),
        sub: `${data.malwareDetections} malware · ${data.fortiCriticalInPeriod} Forti`,
        tone: data.malwareDetections > 0 ? 'bad' : data.fortiCriticalInPeriod > 0 ? 'warn' : 'ok',
      }
    );
  }
  return list;
}

function attentionSection(data, max) {
  const recs = (data.insights?.recommendations ?? []).filter((r) => r.priority !== 'BAJA' || (data.insights.recommendations.length === 1 && r.priority === 'BAJA'));
  const items = recs.slice(0, max).map((r) => ({ chip: r.priority, tone: PRIORITY_TONE[r.priority] ?? 'info', title: r.title, text: shortText(r.detail, 220) }));
  if (!items.length || (items.length === 1 && recs[0].priority === 'BAJA')) {
    return { title: 'Requiere atención', items: [{ chip: 'OK', tone: 'ok', title: 'Sin pendientes', text: 'Todo funcionó normalmente en el período.' }] };
  }
  return { title: 'Requiere atención', items };
}

function dailyEventsSection(data) {
  const tz = data.timezone;
  const events = (data.recentEvents ?? []).slice(0, 6);
  if (!events.length) return { title: 'Novedades del período', text: 'Sin alertas en el período.' };
  return {
    title: 'Novedades del período',
    text: data.eventsOpenedInPeriod > events.length ? `Las ${events.length} más importantes de ${data.eventsOpenedInPeriod}; el resto está en el PDF.` : null,
    items: events.map((e) => ({
      chip: SEVERITY_LABEL[e.severity] ?? e.severity,
      tone: SEVERITY_TONE[e.severity] ?? 'muted',
      title: `${e.server} · ${TYPE_LABEL[e.type] ?? e.type}`,
      text: `${fmt(e.createdAt, tz, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}${e.status === 'RESOLVED' ? ' · resuelta' : ''} — ${shortText(e.description, 150)}`,
    })),
  };
}

function weeklySummarySection(data) {
  const items = [];
  const sev = data.severityCounts;
  items.push({ chip: 'ALERTAS', tone: sev.CRITICAL ? 'bad' : sev.HIGH ? 'warn' : 'ok', title: `${data.eventsOpenedInPeriod} alertas en la semana`, text: `${sev.CRITICAL} críticas · ${sev.HIGH} altas · ${sev.MEDIUM} medias · ${sev.LOW} bajas; ${data.openNow} siguen abiertas.` });
  if (data.topOffenders.length) {
    items.push({ chip: 'SERVIDORES', tone: 'info', title: 'Con más alertas', text: data.topOffenders.slice(0, 4).map(([name, n]) => `${name} (${n})`).join(', ') });
  }
  const failed = data.serverRows.filter((s) => s.backupResult === 'FAILED').map((s) => s.name);
  const ok = data.backupBreakdown.SUCCESS ?? 0;
  items.push({
    chip: 'BACKUPS',
    tone: failed.length ? 'bad' : ok ? 'ok' : 'muted',
    title: failed.length ? `${failed.length} backup(s) fallido(s)` : ok ? 'Backups al día' : 'Sin datos de backups',
    text: failed.length ? failed.join(', ') : ok ? `${ok} exitoso(s) al cierre de la semana.` : 'Ningún servidor informó un backup en el período.',
  });
  items.push({
    chip: 'INTERNET',
    tone: data.outages ? (data.outageMinutes > 60 ? 'bad' : 'warn') : 'ok',
    title: data.outages ? `${data.outages} corte(s) de internet` : 'Sin cortes de internet',
    text: data.outages ? `${minutes(data.outageMinutes)} sin servicio en total.` : 'Todas las sedes con enlace estable.',
  });
  return { title: 'La semana en números', items };
}

/** { subject, parts } para mailer.sendBrandedMail. */
function buildReportEmailParts(data, filename) {
  if (!data) {
    return {
      subject: 'NOC/SOC · Reporte',
      parts: {
        kicker: 'Reporte',
        title: 'Reporte del NOC/SOC',
        intro: 'Te enviamos el reporte solicitado desde el panel. Está adjunto en PDF.',
        attachment: filename,
      },
    };
  }
  const kind = KIND[data.kind] ? data.kind : 'manual';
  const k = KIND[kind];
  const tz = data.timezone;
  const day = fmt(data.generatedAt, tz, { weekday: 'long', day: 'numeric', month: 'long' });
  const range = `${fmt(data.periodStart, tz, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} → ${fmt(data.generatedAt, tz, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`;
  const state = headline(data);
  const subjectDate =
    kind === 'weekly'
      ? `${fmt(data.periodStart, tz, { day: '2-digit', month: '2-digit' })} al ${fmt(data.generatedAt, tz, { day: '2-digit', month: '2-digit' })}`
      : fmt(data.generatedAt, tz, { day: '2-digit', month: '2-digit', year: 'numeric' });

  const sections = [attentionSection(data, kind === 'weekly' ? 6 : 4)];
  sections.push(kind === 'weekly' ? weeklySummarySection(data) : dailyEventsSection(data));

  return {
    subject: `NOC/SOC · ${k.title.replace(' del NOC/SOC', '')} ${subjectDate} — ${state}`,
    parts: {
      preheader: `${state}. ${data.insights?.summary ?? ''}`,
      kicker: `${k.label} · ${day.charAt(0).toUpperCase()}${day.slice(1)}`,
      title: k.title,
      subtitle: `${data.periodLabel ?? ''} · ${range}`,
      intro: data.insights?.summary ?? null,
      kpis: kpis(data, kind !== 'daily'),
      sections,
      attachment: filename,
      attachmentNote: k.note,
    },
  };
}

module.exports = { buildReportEmailParts };
