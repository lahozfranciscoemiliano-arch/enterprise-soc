import { Fragment, useCallback, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Bot, BookOpen, CircleDot, CheckCircle2, Eye, ListFilter, Regex, Sparkles, X } from 'lucide-react';
import { EVENT_STATUS_STYLES, SEVERITY_STYLES } from '../../lib/health';
import type { EventStatus, Playbook, SecurityAlert } from '../../types';
import AlertRepeatInfo from '../AlertRepeatInfo';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

const STATUS_FILTERS: { id: EventStatus | 'ALL'; label: string; icon: typeof ListFilter }[] = [
  { id: 'ALL', label: 'Todas', icon: ListFilter },
  { id: 'OPEN', label: 'Abiertas', icon: CircleDot },
  { id: 'ACKNOWLEDGED', label: 'Reconocidas', icon: Eye },
  { id: 'RESOLVED', label: 'Resueltas', icon: CheckCircle2 },
];

export default function LogsRegexTab({
  alerts,
  onUpdateStatus,
}: {
  alerts: SecurityAlert[];
  onUpdateStatus: (id: string, status: 'ACKNOWLEDGED' | 'RESOLVED') => void;
}) {
  const [pattern, setPattern] = useState('');
  const [regexError, setRegexError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<EventStatus | 'ALL'>('ALL');
  const [openPlaybookFor, setOpenPlaybookFor] = useState<string | null>(null);
  const [playbookCache, setPlaybookCache] = useState<Record<string, Playbook | 'NOT_FOUND'>>({});
  const [loadingPlaybook, setLoadingPlaybook] = useState<string | null>(null);

  const [nlQuery, setNlQuery] = useState('');
  const [nlResultIds, setNlResultIds] = useState<Set<string> | null>(null);
  const [nlLoading, setNlLoading] = useState(false);
  const [nlError, setNlError] = useState<string | null>(null);

  const togglePlaybook = useCallback(
    async (alertId: string, eventType: string) => {
      if (openPlaybookFor === alertId) {
        setOpenPlaybookFor(null);
        return;
      }
      setOpenPlaybookFor(alertId);
      if (playbookCache[eventType]) return;

      setLoadingPlaybook(eventType);
      try {
        const res = await fetch(`${API_URL}/api/playbooks/${encodeURIComponent(eventType)}`, { credentials: 'include' });
        const value: Playbook | 'NOT_FOUND' = res.ok ? await res.json() : 'NOT_FOUND';
        setPlaybookCache((prev) => ({ ...prev, [eventType]: value }));
      } catch {
        setPlaybookCache((prev) => ({ ...prev, [eventType]: 'NOT_FOUND' }));
      } finally {
        setLoadingPlaybook(null);
      }
    },
    [openPlaybookFor, playbookCache]
  );

  const filtered = useMemo(() => {
    const byStatus = statusFilter === 'ALL' ? alerts : alerts.filter((a) => a.status === statusFilter);

    const byNl = nlResultIds ? byStatus.filter((a) => nlResultIds.has(a.id)) : byStatus;

    if (!pattern.trim()) {
      setRegexError(null);
      return byNl;
    }

    try {
      const re = new RegExp(pattern, 'i');
      setRegexError(null);
      return byNl.filter(
        (a) => re.test(a.type) || re.test(a.severity) || re.test(a.description) || re.test(a.serverName ?? '')
      );
    } catch {
      setRegexError('Expresión regular inválida');
      return byNl;
    }
  }, [alerts, pattern, statusFilter, nlResultIds]);

  const handleNlSearch = useCallback(async () => {
    if (!nlQuery.trim()) return;
    setNlLoading(true);
    setNlError(null);
    try {
      const byStatus = statusFilter === 'ALL' ? alerts : alerts.filter((a) => a.status === statusFilter);
      const res = await fetch(`${API_URL}/api/assistant/filter-events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          query: nlQuery,
          events: byStatus.map((a) => ({
            id: a.id,
            serverName: a.serverName ?? null,
            type: a.type,
            severity: a.severity,
            status: a.status,
            createdAt: a.createdAt,
            description: a.description,
          })),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'No se pudo procesar la búsqueda');
      setNlResultIds(new Set(body.ids));
    } catch (err) {
      setNlError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setNlLoading(false);
    }
  }, [nlQuery, alerts, statusFilter]);

  const clearNlSearch = () => {
    setNlQuery('');
    setNlResultIds(null);
    setNlError(null);
  };

  return (
    <div className="px-3 py-4 sm:px-6 sm:py-6">
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
            <Regex className="h-4 w-4 text-slate-400" />
            Historial de Logs Críticos{' '}
            <span className="font-normal text-slate-400">(búsqueda por expresiones regulares)</span>
          </h2>
          <div className="flex gap-1">
            {STATUS_FILTERS.map((f) => (
              <motion.button
                key={f.id}
                whileTap={{ scale: 0.96 }}
                onClick={() => setStatusFilter(f.id)}
                className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs transition-colors ${
                  statusFilter === f.id ? 'bg-brand-600 text-white' : 'text-slate-500 hover:bg-slate-100'
                }`}
              >
                <f.icon className="h-3.5 w-3.5" />
                {f.label}
              </motion.button>
            ))}
          </div>
        </div>

        <div className="relative mb-2">
          <Regex className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Ej: CRITICAL|MEMORY|web-server..."
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            className="w-full rounded-lg border border-slate-300 bg-slate-50 py-2 pl-8 pr-3 font-mono text-xs text-slate-800 outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10 transition-colors"
          />
        </div>

        <div className="mb-2 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[280px] flex-1">
            <Sparkles className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="O preguntá en lenguaje natural: ej. 'problemas de backup de Kansas este mes'"
              value={nlQuery}
              onChange={(e) => setNlQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleNlSearch()}
              className="w-full rounded-lg border border-slate-300 bg-slate-50 py-2 pl-8 pr-3 text-xs text-slate-800 outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10 transition-colors"
            />
          </div>
          <motion.button
            whileTap={{ scale: 0.97 }}
            onClick={handleNlSearch}
            disabled={nlLoading || !nlQuery.trim()}
            className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-700 disabled:opacity-50"
          >
            {nlLoading ? (
              <motion.span animate={{ rotate: 360 }} transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}>
                <Sparkles className="h-3.5 w-3.5" />
              </motion.span>
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {nlLoading ? 'Buscando...' : 'Buscar con IA'}
          </motion.button>
          <AnimatePresence>
            {nlResultIds && (
              <motion.button
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                onClick={clearNlSearch}
                className="flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100"
              >
                <X className="h-3 w-3" />
                Limpiar búsqueda IA
              </motion.button>
            )}
          </AnimatePresence>
        </div>
        {nlError && <p className="mb-2 text-xs text-red-700">{nlError}</p>}

        {regexError && <p className="mb-3 text-xs text-red-700">{regexError}</p>}
        {!regexError && (
          <p className="mb-3 text-xs text-slate-500">
            <span className="font-semibold text-slate-700">{filtered.length}</span> resultado(s)
          </p>
        )}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-left text-xs sm:min-w-0">
            <thead>
              <tr className="border-b border-slate-200 text-slate-400">
                <th className="py-2 pr-4 font-medium">Timestamp</th>
                <th className="py-2 pr-4 font-medium">Servidor</th>
                <th className="py-2 pr-4 font-medium">Tipo</th>
                <th className="py-2 pr-4 font-medium">Severidad</th>
                <th className="py-2 pr-4 font-medium">Estado</th>
                <th className="py-2 pr-4 font-medium">Detalles</th>
                <th className="py-2 pr-4 font-medium">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-6 text-center text-slate-400">
                    No hay coincidencias
                  </td>
                </tr>
              )}
              {filtered.map((a, i) => {
                const statusStyle = EVENT_STATUS_STYLES[a.status] ?? EVENT_STATUS_STYLES.OPEN;
                const playbook = playbookCache[a.type];
                return (
                  <Fragment key={a.id}>
                    <motion.tr
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: Math.min(i * 0.015, 0.3) }}
                      className="border-b border-slate-200 transition-colors hover:bg-slate-100/30"
                    >
                      <td className="py-2 pr-4 text-slate-500">{new Date(a.createdAt).toLocaleString('es-ES')}</td>
                      <td className="py-2 pr-4 text-slate-600">{a.serverName ?? '—'}</td>
                      <td className="py-2 pr-4 text-slate-600">{a.type}</td>
                      <td className="py-2 pr-4">
                        <span className={`rounded-full border px-2 py-0.5 text-[11px] ${SEVERITY_STYLES[a.severity]}`}>
                          {a.severity}
                        </span>
                      </td>
                      <td className="py-2 pr-4">
                        <span className={`rounded-full border px-2 py-0.5 text-[11px] ${statusStyle.badge}`}>
                          {statusStyle.label}
                        </span>
                        {a.acknowledgedByName && !a.autoResolved && (
                          <p className="mt-0.5 text-[10px] text-slate-500">por {a.acknowledgedByName}</p>
                        )}
                        <AlertRepeatInfo alert={a} className="mt-1" />
                      </td>
                      <td className="py-2 pr-4 text-slate-500">
                        {a.description}
                        {a.aiTriage && (
                          <p className="mt-1 flex items-start gap-1 text-[11px] text-sky-700/90">
                            <Bot className="mt-0.5 h-3 w-3 shrink-0" />
                            <span>{a.aiTriage}</span>
                          </p>
                        )}
                      </td>
                      <td className="py-2 pr-4">
                        <div className="flex gap-1">
                          <button
                            onClick={() => togglePlaybook(a.id, a.type)}
                            className="flex items-center gap-1 rounded-lg border border-sky-200 px-2 py-1 text-[11px] text-sky-700 transition-colors hover:bg-sky-50"
                          >
                            <BookOpen className="h-3 w-3" />
                            Playbook
                          </button>
                          {a.status === 'OPEN' && (
                            <button
                              onClick={() => onUpdateStatus(a.id, 'ACKNOWLEDGED')}
                              className="rounded-lg border border-amber-200 px-2 py-1 text-[11px] text-amber-700 transition-colors hover:bg-amber-50"
                            >
                              Reconocer
                            </button>
                          )}
                          {a.status !== 'RESOLVED' && (
                            <button
                              onClick={() => onUpdateStatus(a.id, 'RESOLVED')}
                              className="rounded-lg border border-emerald-200 px-2 py-1 text-[11px] text-emerald-700 transition-colors hover:bg-emerald-50"
                            >
                              Resolver
                            </button>
                          )}
                        </div>
                      </td>
                    </motion.tr>
                    <AnimatePresence initial={false}>
                      {openPlaybookFor === a.id && (
                        <tr className="border-b border-slate-200 bg-slate-50">
                          <td colSpan={7} className="p-0">
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: 'auto', opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.2 }}
                              className="overflow-hidden"
                            >
                              <div className="px-4 py-3">
                                {loadingPlaybook === a.type && <p className="text-xs text-slate-400">Cargando playbook...</p>}
                                {loadingPlaybook !== a.type && playbook === 'NOT_FOUND' && (
                                  <p className="text-xs text-slate-400">No hay un playbook cargado para el tipo &quot;{a.type}&quot;.</p>
                                )}
                                {loadingPlaybook !== a.type && playbook && playbook !== 'NOT_FOUND' && (
                                  <div>
                                    <p className="mb-1 text-xs font-semibold text-sky-700">{playbook.title}</p>
                                    <pre className="whitespace-pre-wrap font-sans text-xs text-slate-600">{playbook.content}</pre>
                                  </div>
                                )}
                              </div>
                            </motion.div>
                          </td>
                        </tr>
                      )}
                    </AnimatePresence>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
