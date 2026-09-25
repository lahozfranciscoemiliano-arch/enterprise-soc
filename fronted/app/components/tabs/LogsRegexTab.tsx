import { Fragment, useCallback, useMemo, useState } from 'react';
import { EVENT_STATUS_STYLES, SEVERITY_STYLES } from '../../lib/health';
import type { EventStatus, Playbook, SecurityAlert } from '../../types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

const STATUS_FILTERS: { id: EventStatus | 'ALL'; label: string }[] = [
  { id: 'ALL', label: 'Todas' },
  { id: 'OPEN', label: 'Abiertas' },
  { id: 'ACKNOWLEDGED', label: 'Reconocidas' },
  { id: 'RESOLVED', label: 'Resueltas' },
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
    <div className="animate-fade-in px-6 py-6">
      <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-gray-200">
            ⌥ Historial de Logs Críticos{' '}
            <span className="font-normal text-gray-500">(búsqueda por expresiones regulares)</span>
          </h2>
          <div className="flex gap-1">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.id}
                onClick={() => setStatusFilter(f.id)}
                className={`rounded-lg px-2.5 py-1 text-xs transition-colors ${
                  statusFilter === f.id ? 'bg-blue-600 text-white' : 'text-gray-400 hover:bg-gray-800'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <input
          type="text"
          placeholder="Ej: CRITICAL|MEMORY|web-server..."
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          className="mb-2 w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 font-mono text-xs text-gray-200 outline-none focus:border-blue-500"
        />

        <div className="mb-2 flex flex-wrap items-center gap-2">
          <input
            type="text"
            placeholder="🤖 O preguntá en lenguaje natural: ej. 'problemas de backup de Kansas este mes'"
            value={nlQuery}
            onChange={(e) => setNlQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleNlSearch()}
            className="min-w-[280px] flex-1 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-gray-200 outline-none focus:border-blue-500"
          />
          <button
            onClick={handleNlSearch}
            disabled={nlLoading || !nlQuery.trim()}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
          >
            {nlLoading ? 'Buscando...' : 'Buscar con IA'}
          </button>
          {nlResultIds && (
            <button
              onClick={clearNlSearch}
              className="rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800"
            >
              Limpiar búsqueda IA
            </button>
          )}
        </div>
        {nlError && <p className="mb-2 text-xs text-red-400">{nlError}</p>}

        {regexError && <p className="mb-3 text-xs text-red-400">{regexError}</p>}
        {!regexError && <p className="mb-3 text-xs text-gray-600">{filtered.length} resultado(s)</p>}

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-gray-800 text-gray-500">
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
                  <td colSpan={7} className="py-6 text-center text-gray-500">
                    No hay coincidencias
                  </td>
                </tr>
              )}
              {filtered.map((a) => {
                const statusStyle = EVENT_STATUS_STYLES[a.status] ?? EVENT_STATUS_STYLES.OPEN;
                const playbook = playbookCache[a.type];
                return (
                  <Fragment key={a.id}>
                    <tr className="border-b border-gray-800/60 transition-colors hover:bg-gray-800/30">
                      <td className="py-2 pr-4 text-gray-400">{new Date(a.createdAt).toLocaleString('es-ES')}</td>
                      <td className="py-2 pr-4 text-gray-300">{a.serverName ?? '—'}</td>
                      <td className="py-2 pr-4 text-gray-300">{a.type}</td>
                      <td className="py-2 pr-4">
                        <span className={`rounded-full border px-2 py-0.5 text-[11px] ${SEVERITY_STYLES[a.severity]}`}>
                          {a.severity}
                        </span>
                      </td>
                      <td className="py-2 pr-4">
                        <span className={`rounded-full border px-2 py-0.5 text-[11px] ${statusStyle.badge}`}>
                          {statusStyle.label}
                        </span>
                        {a.acknowledgedByName && (
                          <p className="mt-0.5 text-[10px] text-gray-600">por {a.acknowledgedByName}</p>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-gray-400">
                        {a.description}
                        {a.aiTriage && (
                          <p className="mt-1 flex items-start gap-1 text-[11px] text-sky-300/90">
                            <span>🤖</span>
                            <span>{a.aiTriage}</span>
                          </p>
                        )}
                      </td>
                      <td className="py-2 pr-4">
                        <div className="flex gap-1">
                          <button
                            onClick={() => togglePlaybook(a.id, a.type)}
                            className="rounded-lg border border-sky-500/30 px-2 py-1 text-[11px] text-sky-300 transition-colors hover:bg-sky-500/10"
                          >
                            📘 Playbook
                          </button>
                          {a.status === 'OPEN' && (
                            <button
                              onClick={() => onUpdateStatus(a.id, 'ACKNOWLEDGED')}
                              className="rounded-lg border border-amber-500/30 px-2 py-1 text-[11px] text-amber-400 transition-colors hover:bg-amber-500/10"
                            >
                              Reconocer
                            </button>
                          )}
                          {a.status !== 'RESOLVED' && (
                            <button
                              onClick={() => onUpdateStatus(a.id, 'RESOLVED')}
                              className="rounded-lg border border-emerald-500/30 px-2 py-1 text-[11px] text-emerald-400 transition-colors hover:bg-emerald-500/10"
                            >
                              Resolver
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {openPlaybookFor === a.id && (
                      <tr className="border-b border-gray-800/60 bg-gray-950/70">
                        <td colSpan={7} className="px-4 py-3">
                          {loadingPlaybook === a.type && <p className="text-xs text-gray-500">Cargando playbook...</p>}
                          {loadingPlaybook !== a.type && playbook === 'NOT_FOUND' && (
                            <p className="text-xs text-gray-500">No hay un playbook cargado para el tipo &quot;{a.type}&quot;.</p>
                          )}
                          {loadingPlaybook !== a.type && playbook && playbook !== 'NOT_FOUND' && (
                            <div>
                              <p className="mb-1 text-xs font-semibold text-sky-300">{playbook.title}</p>
                              <pre className="whitespace-pre-wrap font-sans text-xs text-gray-300">{playbook.content}</pre>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
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
