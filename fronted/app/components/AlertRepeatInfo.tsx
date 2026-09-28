import { BellOff, CheckCircle2, Repeat } from 'lucide-react';
import { timeAgo } from '../lib/health';
import type { SecurityAlert } from '../types';

// Datos de deduplicacion de una alerta: cuantas veces se detecto la misma
// condicion mientras seguia activa, y si la cerro el sistema solo.
export default function AlertRepeatInfo({ alert, className = '' }: { alert: SecurityAlert; className?: string }) {
  const repeated = (alert.occurrences ?? 1) > 1;
  if (!repeated && !alert.autoResolved && !alert.silent) return null;

  return (
    <span className={`inline-flex flex-wrap items-center gap-1.5 ${className}`}>
      {alert.silent && (
        <span
          title="Alerta silenciosa: se ve en el NOC pero no envía notificaciones."
          className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-medium text-slate-500"
        >
          <BellOff className="h-2.5 w-2.5" />Silenciosa
        </span>
      )}
      {repeated && (
        <span
          title={`Misma condición detectada ${alert.occurrences} veces; no se repite la alerta ni la notificación.`}
          className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-600"
        >
          <Repeat className="h-2.5 w-2.5" />×{alert.occurrences} · última {timeAgo(alert.lastSeenAt)}
        </span>
      )}
      {alert.autoResolved && alert.status === 'RESOLVED' && (
        <span
          title="Se cerró sola al normalizarse la condición."
          className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700"
        >
          <CheckCircle2 className="h-2.5 w-2.5" />Auto-resuelta
        </span>
      )}
    </span>
  );
}
