'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Playbook } from '../types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

export default function PlaybooksAdmin() {
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ title: string; content: string }>({ title: '', content: '' });
  const [saving, setSaving] = useState(false);
  const [savedKey, setSavedKey] = useState<string | null>(null);

  const fetchPlaybooks = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/playbooks`, { credentials: 'include' });
      if (!res.ok) throw new Error((await res.json()).error || 'No se pudieron cargar los playbooks');
      setPlaybooks(await res.json());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPlaybooks();
  }, [fetchPlaybooks]);

  const openEditor = (p: Playbook) => {
    setExpandedKey((prev) => (prev === p.key ? null : p.key));
    setDraft({ title: p.title, content: p.content });
    setSavedKey(null);
  };

  const handleSave = useCallback(
    async (key: string) => {
      setSaving(true);
      setError(null);
      try {
        const res = await fetch(`${API_URL}/api/admin/playbooks/${encodeURIComponent(key)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(draft),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || 'No se pudo guardar el playbook');
        setPlaybooks((prev) => prev.map((p) => (p.key === key ? body : p)));
        setSavedKey(key);
        setTimeout(() => setSavedKey(null), 3000);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Error desconocido');
      } finally {
        setSaving(false);
      }
    },
    [draft]
  );

  if (loading) return <p className="text-sm text-gray-500">Cargando playbooks...</p>;

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-4">
      <h2 className="mb-1 text-sm font-semibold text-gray-200">📘 Playbooks de resolución</h2>
      <p className="mb-4 text-[11px] text-gray-500">
        Pasos sugeridos por tipo de alerta (internas y de Fortinet). Se muestran junto a cada alerta en la pestaña
        Logs Regex para estandarizar cómo se resuelve, sin depender de que alguien se acuerde el procedimiento.
      </p>

      {error && <p className="mb-3 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-400">{error}</p>}

      <div className="space-y-2">
        {playbooks.map((p) => (
          <div key={p.key} className="rounded-lg border border-gray-800 bg-gray-950/50">
            <button
              onClick={() => openEditor(p)}
              className="flex w-full items-center justify-between gap-2 px-4 py-2 text-left text-xs"
            >
              <span>
                <span className="font-mono text-gray-500">{p.key}</span>{' '}
                <span className="font-medium text-gray-200">{p.title}</span>
              </span>
              <span className="text-gray-500">{expandedKey === p.key ? '▲' : '▼'}</span>
            </button>

            {expandedKey === p.key && (
              <div className="border-t border-gray-800 p-4">
                <input
                  type="text"
                  value={draft.title}
                  onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                  placeholder="Título"
                  className="mb-2 w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-gray-200 outline-none focus:border-blue-500"
                />
                <textarea
                  value={draft.content}
                  onChange={(e) => setDraft((d) => ({ ...d, content: e.target.value }))}
                  rows={8}
                  placeholder="Pasos de resolución (texto plano o markdown simple)"
                  className="mb-2 w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 font-mono text-xs text-gray-200 outline-none focus:border-blue-500"
                />
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => handleSave(p.key)}
                    disabled={saving}
                    className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
                  >
                    {saving ? 'Guardando...' : 'Guardar'}
                  </button>
                  {savedKey === p.key && <span className="text-xs text-emerald-400">✓ Guardado</span>}
                  <span className="text-[11px] text-gray-600">Última edición: {new Date(p.updatedAt).toLocaleString('es-ES')}</span>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
