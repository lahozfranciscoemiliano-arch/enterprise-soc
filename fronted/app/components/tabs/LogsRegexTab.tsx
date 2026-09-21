import { useMemo, useState } from 'react';
import { SEVERITY_STYLES } from '../../lib/health';
import type { SecurityAlert } from '../../types';

export default function LogsRegexTab({ alerts }: { alerts: SecurityAlert[] }) {
  const [pattern, setPattern] = useState('');
  const [regexError, setRegexError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    if (!pattern.trim()) {
      setRegexError(null);
      return alerts;
    }

    try {
      const re = new RegExp(pattern, 'i');
      setRegexError(null);
      return alerts.filter(
        (a) => re.test(a.type) || re.test(a.severity) || re.test(a.description) || re.test(a.serverName ?? '')
      );
    } catch {
      setRegexError('Expresión regular inválida');
      return alerts;
    }
  }, [alerts, pattern]);

  return (
    <div className="animate-fade-in px-6 py-6">
      <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">
        <h2 className="mb-4 text-sm font-semibold text-gray-200">
          ⌥ Historial de Logs Críticos <span className="font-normal text-gray-500">(búsqueda por expresiones regulares)</span>
        </h2>

        <input
          type="text"
          placeholder="Ej: CRITICAL|MEMORY|web-server..."
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          className="mb-1 w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 font-mono text-xs text-gray-200 outline-none focus:border-blue-500"
        />
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
                <th className="py-2 pr-4 font-medium">Detalles</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-gray-500">
                    No hay coincidencias
                  </td>
                </tr>
              )}
              {filtered.map((a) => (
                <tr key={a.id} className="border-b border-gray-800/60 transition-colors hover:bg-gray-800/30">
                  <td className="py-2 pr-4 text-gray-400">{new Date(a.createdAt).toLocaleString('es-ES')}</td>
                  <td className="py-2 pr-4 text-gray-300">{a.serverName ?? '—'}</td>
                  <td className="py-2 pr-4 text-gray-300">{a.type}</td>
                  <td className="py-2 pr-4">
                    <span className={`rounded-full border px-2 py-0.5 text-[11px] ${SEVERITY_STYLES[a.severity]}`}>
                      {a.severity}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-gray-400">{a.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
