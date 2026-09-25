'use client';

import { useCallback, useEffect, useState } from 'react';
import { BookOpen, Check } from 'lucide-react';
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

  if (loading) return <p className="text-sm text-slate-400">Cargando playbooks...</p>;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-card">
      <h2 className="mb-1 text-sm font-semibold text-slate-800"><BookOpen className="inline h-4 w-4 -mt-0.5 mr-1.5 text-slate-400" />Playbooks de resolución</h2>
      <p className="mb-4 text-[11px] text-slate-400">
        Pasos sugeridos por tipo de alerta (internas y de Fortinet). Se muestran junto a cada alerta en la pestaña
        Logs Regex para estandarizar cómo se resuelve, sin depender de que alguien se acuerde el procedimiento.
      </p>

      {error && <p className="mb-3 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">{error}</p>}

      <div className="space-y-2">
        {playbooks.map((p) => (
          <div key={p.key} className="rounded-lg border border-slate-200 bg-slate-50">
            <button
              onClick={() => openEditor(p)}
              className="flex w-full items-center justify-between gap-2 px-4 py-2 text-left text-xs"
            >
              <span>
                <span className="font-mono text-slate-400">{p.key}</span>{' '}
                <span className="font-medium text-slate-800">{p.title}</span>
              </span>
              <span className="text-slate-400">{expandedKey === p.key ? '▲' : '▼'}</span>
            </button>

            {expandedKey === p.key && (
              <div className="border-t border-slate-200 p-4">
                <input
                  type="text"
                  value={draft.title}
                  onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                  placeholder="Título"
                  className="mb-2 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-800 outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10 transition-colors"
                />
                <textarea
                  value={draft.content}
                  onChange={(e) => setDraft((d) => ({ ...d, content: e.target.value }))}
                  rows={8}
                  placeholder="Pasos de resolución (texto plano o markdown simple)"
                  className="mb-2 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-800 outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10 transition-colors"
                />
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => handleSave(p.key)}
                    disabled={saving}
                    className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-700 disabled:opacity-50"
                  >
                    {saving ? 'Guardando...' : 'Guardar'}
                  </button>
                  {savedKey === p.key && <span className="flex items-center gap-1 text-xs text-emerald-700"><Check className="h-3 w-3" />Guardado</span>}
                  <span className="text-[11px] text-slate-500">Última edición: {new Date(p.updatedAt).toLocaleString('es-ES')}</span>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
