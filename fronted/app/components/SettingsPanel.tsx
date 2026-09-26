import { useCallback, useEffect, useState } from 'react';
import { BarChart3, Bot, Check, FileText, Lock, Mail, Monitor, ShieldHalf, Trash2 } from 'lucide-react';
import type { SystemSettings } from '../types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

type FormState = Record<string, string | boolean>;

function plainField(settings: SystemSettings | null, key: keyof SystemSettings): string {
  if (!settings) return '';
  const s = settings[key] as { value: unknown } | undefined;
  return s?.value === null || s?.value === undefined ? '' : String(s.value);
}

function boolField(settings: SystemSettings | null, key: keyof SystemSettings): boolean {
  if (!settings) return false;
  const s = settings[key] as { value: unknown } | undefined;
  return Boolean(s?.value);
}

export default function SettingsPanel() {
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [form, setForm] = useState<FormState>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/admin/settings`, { credentials: 'include' });
      if (!res.ok) throw new Error((await res.json()).error || 'No se pudo cargar la configuración');
      const data: SystemSettings = await res.json();
      setSettings(data);
      setForm({
        SMTP_HOST: plainField(data, 'SMTP_HOST'),
        SMTP_PORT: plainField(data, 'SMTP_PORT'),
        SMTP_SECURE: boolField(data, 'SMTP_SECURE'),
        SMTP_USER: plainField(data, 'SMTP_USER'),
        SMTP_PASS: '',
        SMTP_FROM: plainField(data, 'SMTP_FROM'),
        ALERT_EMAIL_TO: plainField(data, 'ALERT_EMAIL_TO'),
        SLACK_WEBHOOK_URL: '',
        WEBHOOK_URL: '',
        NOTIFY_MIN_SEVERITY: plainField(data, 'NOTIFY_MIN_SEVERITY') || 'HIGH',
        JWT_EXPIRES_IN: plainField(data, 'JWT_EXPIRES_IN') || '8h',
        DEFAULT_CPU_HIGH: plainField(data, 'DEFAULT_CPU_HIGH'),
        DEFAULT_CPU_MEDIUM: plainField(data, 'DEFAULT_CPU_MEDIUM'),
        DEFAULT_MEM_HIGH: plainField(data, 'DEFAULT_MEM_HIGH'),
        DEFAULT_MEM_MEDIUM: plainField(data, 'DEFAULT_MEM_MEDIUM'),
        DEFAULT_DISK_HIGH: plainField(data, 'DEFAULT_DISK_HIGH'),
        DEFAULT_DISK_MEDIUM: plainField(data, 'DEFAULT_DISK_MEDIUM'),
        AGENT_ENROLLMENT_SECRET: '',
        AGENT_LATEST_VERSION: plainField(data, 'AGENT_LATEST_VERSION'),
        FORTI_SYSLOG_ENABLED: boolField(data, 'FORTI_SYSLOG_ENABLED'),
        FORTI_SYSLOG_PORT: plainField(data, 'FORTI_SYSLOG_PORT') || '5514',
        GEMINI_API_KEY: '',
        GEMINI_MODEL: plainField(data, 'GEMINI_MODEL') || 'gemini-3.8-flash',
        REMOTE_ACCESS_ENABLED: boolField(data, 'REMOTE_ACCESS_ENABLED'),
        TELEMETRY_RETENTION_DAYS: plainField(data, 'TELEMETRY_RETENTION_DAYS') || '30',
        SECURITY_EVENT_RETENTION_DAYS: plainField(data, 'SECURITY_EVENT_RETENTION_DAYS') || '365',
        BACKUP_STATUS_RETENTION_DAYS: plainField(data, 'BACKUP_STATUS_RETENTION_DAYS') || '180',
        FORTI_EVENT_RETENTION_DAYS: plainField(data, 'FORTI_EVENT_RETENTION_DAYS') || '180',
        AUDIT_LOG_RETENTION_DAYS: plainField(data, 'AUDIT_LOG_RETENTION_DAYS') || '365',
        REPORT_ENABLED: boolField(data, 'REPORT_ENABLED'),
        REPORT_FREQUENCY: plainField(data, 'REPORT_FREQUENCY') || 'daily',
        REPORT_HOUR: plainField(data, 'REPORT_HOUR') || '8',
        REPORT_EMAIL_TO: plainField(data, 'REPORT_EMAIL_TO'),
        AGENT_STALE_THRESHOLD_SECONDS: plainField(data, 'AGENT_STALE_THRESHOLD_SECONDS') || '240',
        TELEGRAM_BOT_TOKEN: '',
        TELEGRAM_CHAT_ID: plainField(data, 'TELEGRAM_CHAT_ID'),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const save = useCallback(
    async (section: string, keys: string[]) => {
      setSaving(section);
      setError(null);
      setSavedMessage(null);

      const payload: Record<string, unknown> = {};
      for (const key of keys) {
        const value = form[key];
        if (typeof value === 'boolean') {
          payload[key] = value;
        } else if (value !== '') {
          const numericKeys = [
            'SMTP_PORT',
            'DEFAULT_CPU_HIGH',
            'DEFAULT_CPU_MEDIUM',
            'DEFAULT_MEM_HIGH',
            'DEFAULT_MEM_MEDIUM',
            'DEFAULT_DISK_HIGH',
            'DEFAULT_DISK_MEDIUM',
            'FORTI_SYSLOG_PORT',
            'TELEMETRY_RETENTION_DAYS',
            'SECURITY_EVENT_RETENTION_DAYS',
            'BACKUP_STATUS_RETENTION_DAYS',
            'FORTI_EVENT_RETENTION_DAYS',
            'AUDIT_LOG_RETENTION_DAYS',
            'REPORT_HOUR',
            'AGENT_STALE_THRESHOLD_SECONDS',
          ];
          payload[key] = numericKeys.includes(key) ? Number(value) : value;
        }
      }

      try {
        const res = await fetch(`${API_URL}/api/admin/settings`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(payload),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || 'No se pudo guardar');
        setSettings(body);
        setSavedMessage(`Guardado: ${section}`);
        setTimeout(() => setSavedMessage(null), 3000);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error desconocido');
      } finally {
        setSaving(null);
      }
    },
    [form]
  );

  const set = (key: string, value: string | boolean) => setForm((p) => ({ ...p, [key]: value }));

  const input = (key: string, placeholder?: string, type = 'text') => (
    <input
      type={type}
      value={form[key] as string}
      onChange={(e) => set(key, e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-800 outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10 transition-colors"
    />
  );

  const checkbox = (key: string, label: string) => (
    <label className="flex items-center gap-2 text-xs text-slate-600">
      <input
        type="checkbox"
        checked={form[key] as boolean}
        onChange={(e) => set(key, e.target.checked)}
        className="h-4 w-4 rounded border-slate-300 bg-slate-50"
      />
      {label}
    </label>
  );

  const sensitiveHint = (key: keyof SystemSettings) => {
    const s = settings?.[key] as { configured: boolean; hint: string | null } | undefined;
    return s?.configured ? `Configurado (${s.hint})` : 'No configurado';
  };

  const saveBtn = (section: string, keys: string[]) => (
    <button
      onClick={() => save(section, keys)}
      disabled={saving === section}
      className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-700 disabled:opacity-50"
    >
      {saving === section ? 'Guardando...' : 'Guardar'}
    </button>
  );

  if (loading) return <p className="text-sm text-slate-400">Cargando configuración...</p>;

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">{error}</p>}
      {savedMessage && (
        <p className="flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-700">
          <Check className="h-3.5 w-3.5" />
          {savedMessage}
        </p>
      )}

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
        <h3 className="mb-3 text-sm font-semibold text-slate-800"><Mail className="inline h-4 w-4 -mt-0.5 mr-1.5 text-slate-400" />Notificaciones externas</h3>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {input('SMTP_HOST', 'SMTP_HOST (ej: smtp.gmail.com)')}
          {input('SMTP_PORT', 'Puerto (587)')}
          {input('SMTP_USER', 'Usuario SMTP')}
          {input('SMTP_PASS', `Contraseña SMTP (${sensitiveHint('SMTP_PASS')})`, 'password')}
          {input('SMTP_FROM', 'Remitente (noc@tudominio.com)')}
          {input('ALERT_EMAIL_TO', 'Destinatario(s) de alertas')}
          {input('SLACK_WEBHOOK_URL', `Slack webhook (${sensitiveHint('SLACK_WEBHOOK_URL')})`, 'password')}
          {input('WEBHOOK_URL', `Webhook genérico (${sensitiveHint('WEBHOOK_URL')})`, 'password')}
          {input('TELEGRAM_BOT_TOKEN', `Telegram bot token (${sensitiveHint('TELEGRAM_BOT_TOKEN')})`, 'password')}
          {input('TELEGRAM_CHAT_ID', 'Telegram chat ID')}
          <select
            value={form.NOTIFY_MIN_SEVERITY as string}
            onChange={(e) => set('NOTIFY_MIN_SEVERITY', e.target.value)}
            className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-800"
          >
            <option value="LOW">Notificar desde: LOW</option>
            <option value="MEDIUM">Notificar desde: MEDIUM</option>
            <option value="HIGH">Notificar desde: HIGH</option>
            <option value="CRITICAL">Notificar desde: CRITICAL</option>
          </select>
        </div>
        <div className="mt-2 flex items-center gap-1 checkbox">{checkbox('SMTP_SECURE', 'SMTP con TLS implícito (puerto 465)')}</div>
        <div className="mt-3">
          {saveBtn('notificaciones', [
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
            'NOTIFY_MIN_SEVERITY',
          ])}
        </div>
        <p className="mt-2 text-[11px] text-slate-400">
          Telegram: creá un bot con @BotFather (gratis, sin aprobación) y agregalo al grupo/chat a notificar para
          obtener el chat ID. Alternativa a WhatsApp Business (requiere cuenta Meta verificada) para equipos que
          prefieren notificarse ahí.
        </p>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
        <h3 className="mb-3 text-sm font-semibold text-slate-800"><BarChart3 className="inline h-4 w-4 -mt-0.5 mr-1.5 text-slate-400" />Umbrales globales por defecto</h3>
        <p className="mb-2 text-[11px] text-slate-400">
          Se usan cuando un servidor no tiene sus propios umbrales configurados (Admin → Servidores → Configurar).
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {input('DEFAULT_CPU_MEDIUM', 'CPU advertencia (75)')}
          {input('DEFAULT_CPU_HIGH', 'CPU crítico (90)')}
          {input('DEFAULT_MEM_MEDIUM', 'RAM advertencia (80)')}
          {input('DEFAULT_MEM_HIGH', 'RAM crítico (90)')}
          {input('DEFAULT_DISK_MEDIUM', 'Disco advertencia (85)')}
          {input('DEFAULT_DISK_HIGH', 'Disco crítico (95)')}
        </div>
        <div className="mt-3">
          {saveBtn('umbrales', [
            'DEFAULT_CPU_MEDIUM',
            'DEFAULT_CPU_HIGH',
            'DEFAULT_MEM_MEDIUM',
            'DEFAULT_MEM_HIGH',
            'DEFAULT_DISK_MEDIUM',
            'DEFAULT_DISK_HIGH',
          ])}
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
        <h3 className="mb-3 text-sm font-semibold text-slate-800"><Lock className="inline h-4 w-4 -mt-0.5 mr-1.5 text-slate-400" />Sesión y agentes</h3>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {input('JWT_EXPIRES_IN', 'Duración de sesión (8h)')}
          {input('AGENT_ENROLLMENT_SECRET', `Secreto de auto-enrolamiento (${sensitiveHint('AGENT_ENROLLMENT_SECRET')})`, 'password')}
          {input('AGENT_LATEST_VERSION', 'Última versión de agente publicada (ej: 1.1.0)')}
          {input('AGENT_STALE_THRESHOLD_SECONDS', 'Segundos sin telemetría antes de marcar OFFLINE (240)')}
        </div>
        <p className="mt-2 text-[11px] text-slate-400">
          Publicar una versión nueva acá hace que todos los agentes con una versión anterior se auto-actualicen en su
          próximo ciclo (bajan el .exe publicado en /downloads y se reinician solos). El umbral de watchdog controla
          cuánto tiempo sin telemetría tolera antes de marcar un servidor OFFLINE y alertar (Admin → Reportes muestra
          la última corrida).
        </p>
        <div className="mt-3">
          {saveBtn('sesión y agentes', [
            'JWT_EXPIRES_IN',
            'AGENT_ENROLLMENT_SECRET',
            'AGENT_LATEST_VERSION',
            'AGENT_STALE_THRESHOLD_SECONDS',
          ])}
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
        <h3 className="mb-3 text-sm font-semibold text-slate-800"><ShieldHalf className="inline h-4 w-4 -mt-0.5 mr-1.5 text-slate-400" />Fortinet</h3>
        <div className="flex flex-wrap items-center gap-4">
          {checkbox('FORTI_SYSLOG_ENABLED', 'Activar receptor de syslog UDP (requiere reiniciar el backend)')}
          <div className="w-40">{input('FORTI_SYSLOG_PORT', 'Puerto UDP (5514)')}</div>
        </div>
        <p className="mt-2 text-[11px] text-slate-400">
          Alternativa sin syslog: usar la ingesta por API con la API key de cada dispositivo (ver sección de
          dispositivos Fortinet más abajo).
        </p>
        <div className="mt-3">{saveBtn('fortinet', ['FORTI_SYSLOG_ENABLED', 'FORTI_SYSLOG_PORT'])}</div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
        <h3 className="mb-3 text-sm font-semibold text-slate-800"><Bot className="inline h-4 w-4 -mt-0.5 mr-1.5 text-slate-400" />Asistente (Gemini)</h3>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {input('GEMINI_API_KEY', `API key de Gemini (${sensitiveHint('GEMINI_API_KEY')})`, 'password')}
          {input('GEMINI_MODEL', 'Modelo (gemini-3.8-flash)')}
        </div>
        <p className="mt-2 text-[11px] text-slate-400">
          Requiere una API key de{' '}
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" className="text-brand-600 underline hover:text-brand-700">
            aistudio.google.com
          </a>{' '}
          (tiene nivel gratuito con límite de requests/minuto).
        </p>
        <div className="mt-3">{saveBtn('asistente', ['GEMINI_API_KEY', 'GEMINI_MODEL'])}</div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
        <h3 className="mb-3 text-sm font-semibold text-slate-800"><Trash2 className="inline h-4 w-4 -mt-0.5 mr-1.5 text-slate-400" />Retención de datos</h3>
        <p className="mb-2 text-[11px] text-slate-400">
          Cuántos días se conservan antes de purgarse automáticamente (todos los días, ver Admin → Housekeeping).
          0 = conservar para siempre — no recomendado en un disco chico.
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {input('TELEMETRY_RETENTION_DAYS', 'Telemetría (30)', 'number')}
          {input('SECURITY_EVENT_RETENTION_DAYS', 'Alertas resueltas (365)', 'number')}
          {input('BACKUP_STATUS_RETENTION_DAYS', 'Backups (180)', 'number')}
          {input('FORTI_EVENT_RETENTION_DAYS', 'Eventos Fortinet (180)', 'number')}
          {input('AUDIT_LOG_RETENTION_DAYS', 'Auditoría (365)', 'number')}
        </div>
        <div className="mt-3">
          {saveBtn('retención', [
            'TELEMETRY_RETENTION_DAYS',
            'SECURITY_EVENT_RETENTION_DAYS',
            'BACKUP_STATUS_RETENTION_DAYS',
            'FORTI_EVENT_RETENTION_DAYS',
            'AUDIT_LOG_RETENTION_DAYS',
          ])}
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
        <h3 className="mb-3 text-sm font-semibold text-slate-800"><FileText className="inline h-4 w-4 -mt-0.5 mr-1.5 text-slate-400" />Reportes ejecutivos</h3>
        <div className="flex flex-wrap items-center gap-4">
          {checkbox('REPORT_ENABLED', 'Enviar automáticamente por email')}
          <select
            value={form.REPORT_FREQUENCY as string}
            onChange={(e) => set('REPORT_FREQUENCY', e.target.value)}
            className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-800"
          >
            <option value="daily">Frecuencia: diaria</option>
            <option value="weekly">Frecuencia: semanal (lunes)</option>
          </select>
          <div className="w-36">{input('REPORT_HOUR', 'Hora UTC (0-23)', 'number')}</div>
        </div>
        <div className="mt-2">{input('REPORT_EMAIL_TO', 'Destinatario(s) del reporte')}</div>
        <p className="mt-2 text-[11px] text-slate-400">
          Requiere SMTP configurado (sección de Notificaciones externas, arriba). Los reportes generados quedan
          disponibles también en Admin → Reportes, con descarga bajo demanda.
        </p>
        <div className="mt-3">{saveBtn('reportes', ['REPORT_ENABLED', 'REPORT_FREQUENCY', 'REPORT_HOUR', 'REPORT_EMAIL_TO'])}</div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
        <h3 className="mb-3 text-sm font-semibold text-slate-800"><Monitor className="inline h-4 w-4 -mt-0.5 mr-1.5 text-slate-400" />Acceso remoto</h3>
        {checkbox('REMOTE_ACCESS_ENABLED', 'Mostrar el botón "Conectar" (RDP/VNC) en la ficha de cada servidor')}
        <p className="mt-2 text-[11px] text-slate-400">
          El túnel en sí siempre está disponible en el backend; este interruptor solo controla si el botón aparece en
          el panel, para no tentar a usarlo hasta que el equipo esté cómodo con la función.
        </p>
        <div className="mt-3">{saveBtn('acceso remoto', ['REMOTE_ACCESS_ENABLED'])}</div>
      </div>
    </div>
  );
}
