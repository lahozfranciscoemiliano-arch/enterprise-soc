import type { BackupResult, EventStatus, HealthStatus, Severity } from '../types';

// Debe reflejar los mismos umbrales que enterprise-soc/backend/src/services/alertEngine.js
const THRESHOLDS = {
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

  for (const [field, rule] of Object.entries(THRESHOLDS)) {
    const value = { cpuUsage, memoryUsage, diskUsage }[field as keyof typeof THRESHOLDS];
    if (value >= rule.high) return 'CRITICAL';
    if (value >= rule.medium) status = 'WARNING';
  }

  return status;
}

export const HEALTH_STYLES: Record<HealthStatus, { dot: string; text: string; badge: string; label: string }> = {
  OK: { dot: 'bg-emerald-500', text: 'text-emerald-400', badge: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30', label: 'OK' },
  WARNING: { dot: 'bg-amber-500', text: 'text-amber-400', badge: 'bg-amber-500/10 text-amber-400 border-amber-500/30', label: 'ADVERTENCIA' },
  CRITICAL: { dot: 'bg-red-500', text: 'text-red-400', badge: 'bg-red-500/10 text-red-400 border-red-500/30', label: 'CRÍTICO' },
  UNKNOWN: { dot: 'bg-slate-600', text: 'text-slate-400', badge: 'bg-slate-500/10 text-slate-400 border-slate-500/30', label: 'SIN DATOS' },
};

export const BACKUP_STYLES: Record<BackupResult, { badge: string; label: string }> = {
  SUCCESS: { badge: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30', label: 'ÉXITO' },
  WARNING: { badge: 'bg-amber-500/10 text-amber-400 border-amber-500/30', label: 'ADVERTENCIA' },
  FAILED: { badge: 'bg-red-500/10 text-red-400 border-red-500/30', label: 'FALLIDO' },
  NOT_CONFIGURED: { badge: 'bg-slate-500/10 text-slate-400 border-slate-500/30', label: 'NO CONFIGURADO' },
  UNKNOWN: { badge: 'bg-slate-500/10 text-slate-400 border-slate-500/30', label: 'SIN DATOS' },
};

export const BACKUP_METHOD_LABELS: Record<string, string> = {
  WINDOWS_SERVER_BACKUP: 'Windows Server Backup',
  WBADMIN: 'Backup and Restore (wbadmin)',
  NONE: 'Sin método detectado',
};

export const SEVERITY_STYLES: Record<Severity, string> = {
  LOW: 'bg-slate-500/10 text-slate-300 border-slate-500/30',
  MEDIUM: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30',
  HIGH: 'bg-orange-500/10 text-orange-400 border-orange-500/30',
  CRITICAL: 'bg-red-500/10 text-red-400 border-red-500/30',
};

export const EVENT_STATUS_STYLES: Record<EventStatus, { badge: string; label: string }> = {
  OPEN: { badge: 'bg-red-500/10 text-red-400 border-red-500/30', label: 'ABIERTA' },
  ACKNOWLEDGED: { badge: 'bg-amber-500/10 text-amber-400 border-amber-500/30', label: 'RECONOCIDA' },
  RESOLVED: { badge: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30', label: 'RESUELTA' },
};

export const MAINTENANCE_BADGE = 'bg-sky-500/10 text-sky-400 border-sky-500/30';
