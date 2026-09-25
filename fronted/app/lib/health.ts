import type { BackupResult, EventStatus, HealthStatus, Severity } from '../types';

// Debe reflejar los mismos umbrales que enterprise-soc/backend/src/services/alertEngine.js
export const RESOURCE_THRESHOLDS = {
  cpuUsage: { high: 90, medium: 75 },
  memoryUsage: { high: 90, medium: 80 },
  diskUsage: { high: 95, medium: 85 },
} as const;

export function getHealthStatus(
  cpuUsage: number | null,
  memoryUsage: number | null,
  diskUsage: number | null
): HealthStatus {
  if (cpuUsage === null || memoryUsage === null || diskUsage === null) return 'UNKNOWN';

  let status: HealthStatus = 'OK';

  for (const [field, rule] of Object.entries(RESOURCE_THRESHOLDS)) {
    const value = { cpuUsage, memoryUsage, diskUsage }[field as keyof typeof RESOURCE_THRESHOLDS];
    if (value >= rule.high) return 'CRITICAL';
    if (value >= rule.medium) status = 'WARNING';
  }

  return status;
}

export type ResourceLevel = 'ok' | 'warning' | 'critical';

export function resourceLevel(value: number, kind: keyof typeof RESOURCE_THRESHOLDS): ResourceLevel {
  const t = RESOURCE_THRESHOLDS[kind];
  if (value >= t.high) return 'critical';
  if (value >= t.medium) return 'warning';
  return 'ok';
}

export const RESOURCE_LEVEL_COLOR: Record<ResourceLevel, { bar: string; track: string; text: string }> = {
  ok: { bar: 'bg-emerald-500', track: 'bg-emerald-100', text: 'text-emerald-700' },
  warning: { bar: 'bg-amber-500', track: 'bg-amber-100', text: 'text-amber-700' },
  critical: { bar: 'bg-red-500', track: 'bg-red-100', text: 'text-red-700' },
};

export const HEALTH_STYLES: Record<HealthStatus, { dot: string; text: string; badge: string; label: string }> = {
  OK: { dot: 'bg-emerald-500', text: 'text-emerald-600', badge: 'bg-emerald-50 text-emerald-700 border-emerald-200', label: 'OK' },
  WARNING: { dot: 'bg-amber-500', text: 'text-amber-600', badge: 'bg-amber-50 text-amber-700 border-amber-200', label: 'ADVERTENCIA' },
  CRITICAL: { dot: 'bg-red-500', text: 'text-red-600', badge: 'bg-red-50 text-red-700 border-red-200', label: 'CRÍTICO' },
  UNKNOWN: { dot: 'bg-slate-400', text: 'text-slate-500', badge: 'bg-slate-100 text-slate-500 border-slate-200', label: 'SIN DATOS' },
};

export const BACKUP_STYLES: Record<BackupResult, { badge: string; label: string }> = {
  SUCCESS: { badge: 'bg-emerald-50 text-emerald-700 border-emerald-200', label: 'ÉXITO' },
  WARNING: { badge: 'bg-amber-50 text-amber-700 border-amber-200', label: 'ADVERTENCIA' },
  FAILED: { badge: 'bg-red-50 text-red-700 border-red-200', label: 'FALLIDO' },
  NOT_CONFIGURED: { badge: 'bg-slate-100 text-slate-500 border-slate-200', label: 'NO CONFIGURADO' },
  UNKNOWN: { badge: 'bg-slate-100 text-slate-500 border-slate-200', label: 'SIN DATOS' },
};

export const BACKUP_METHOD_LABELS: Record<string, string> = {
  WINDOWS_SERVER_BACKUP: 'Windows Server Backup',
  WBADMIN: 'Backup and Restore (wbadmin)',
  NONE: 'Sin método detectado',
};

export const SEVERITY_STYLES: Record<Severity, string> = {
  LOW: 'bg-slate-100 text-slate-600 border-slate-200',
  MEDIUM: 'bg-yellow-50 text-yellow-700 border-yellow-200',
  HIGH: 'bg-orange-50 text-orange-700 border-orange-200',
  CRITICAL: 'bg-red-50 text-red-700 border-red-200',
};

export const EVENT_STATUS_STYLES: Record<EventStatus, { badge: string; label: string }> = {
  OPEN: { badge: 'bg-red-50 text-red-700 border-red-200', label: 'ABIERTA' },
  ACKNOWLEDGED: { badge: 'bg-amber-50 text-amber-700 border-amber-200', label: 'RECONOCIDA' },
  RESOLVED: { badge: 'bg-emerald-50 text-emerald-700 border-emerald-200', label: 'RESUELTA' },
};

export const MAINTENANCE_BADGE = 'bg-sky-50 text-sky-700 border-sky-200';

export function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// Antiguedad del ultimo backup exitoso -- ni wbadmin ni el WMI de Windows
// Server Backup exponen la duracion de la corrida, asi que esta es la
// señal honesta mas cercana a "hace cuanto que no hay un backup nuevo".
export function backupAgeLevel(lastBackupAt: string | null): ResourceLevel | 'none' {
  if (!lastBackupAt) return 'none';
  const days = (Date.now() - new Date(lastBackupAt).getTime()) / 86_400_000;
  if (days >= 3) return 'critical';
  if (days >= 1.5) return 'warning';
  return 'ok';
}
