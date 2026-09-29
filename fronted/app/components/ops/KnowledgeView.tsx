'use client';

import { useState } from 'react';
import { BookOpen, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { useLiveData, API_URL } from '../inventory/useLiveData';
import { useToast } from '../Toast';
import type { KnowledgeArticle } from '../../types';

type Draft = { id?: string; title: string; problem: string; solution: string; tags: string; alertType: string };
const EMPTY: Draft = { title: '', problem: '', solution: '', tags: '', alertType: '' };

export default function KnowledgeView({ canWrite, isAdmin }: { canWrite: boolean; isAdmin: boolean }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const { data, reload } = useLiveData<KnowledgeArticle[]>(`/api/kb${query ? `?q=${encodeURIComponent(query)}` : ''}`, { event: 'soc:tickets', intervalMs: 300_000 });
  const [draft, setDraft] = useState<Draft | null>(null);

  const save = async () => {
    if (!draft) return;
    const body = {
      title: draft.title,
      problem: draft.problem,
      solution: draft.solution,
      tags: draft.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      alertType: draft.alertType.trim() || null,
    };
    const res = await fetch(`${API_URL}/api/kb${draft.id ? `/${draft.id}` : ''}`, {
      method: draft.id ? 'PUT' : 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      toast.error((await res.json().catch(() => ({}))).error ?? 'No se pudo guardar');
      return;
    }
    toast.success('Artículo guardado');
    setDraft(null);
    reload();
  };

  const remove = async (a: KnowledgeArticle) => {
    if (!window.confirm(`¿Borrar "${a.title}"?`)) return;
    const res = await fetch(`${API_URL}/api/kb/${a.id}`, { method: 'DELETE', credentials: 'include' });
    if (res.ok) reload();
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500">
          Cómo se resolvió cada problema. Se completa sola al cerrar tickets y se sugiere en las alertas parecidas (“Cómo se resolvió antes”).
        </p>
        <div className="flex items-center gap-2">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setQuery(q.trim());
            }}
            className="relative"
          >
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar solución..." className="w-56 rounded-lg border border-slate-300 py-1.5 pl-8 pr-3 text-xs outline-none focus:border-brand-500" />
          </form>
          {canWrite && (
            <button onClick={() => setDraft(EMPTY)} className="flex items-center gap-1 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700">
              <Plus className="h-3.5 w-3.5" /> Artículo
            </button>
          )}
        </div>
      </div>

      {draft && (
        <div className="space-y-2 rounded-xl border border-brand-200 bg-brand-50/40 p-3 text-xs">
          <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Título" className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5" />
          <textarea value={draft.problem} onChange={(e) => setDraft({ ...draft, problem: e.target.value })} rows={2} placeholder="Problema / síntoma" className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5" />
          <textarea value={draft.solution} onChange={(e) => setDraft({ ...draft, solution: e.target.value })} rows={4} placeholder="Solución paso a paso" className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5" />
          <div className="grid gap-2 sm:grid-cols-2">
            <input value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} placeholder="Etiquetas (separadas por coma)" className="rounded-lg border border-slate-300 px-2.5 py-1.5" />
            <input value={draft.alertType} onChange={(e) => setDraft({ ...draft, alertType: e.target.value })} placeholder="Tipo de alerta (ej. PRINTER_ISSUE)" className="rounded-lg border border-slate-300 px-2.5 py-1.5 font-mono" />
          </div>
          <div className="flex gap-2">
            <button onClick={save} className="rounded-lg bg-brand-600 px-3 py-1.5 font-medium text-white hover:bg-brand-700">
              Guardar
            </button>
            <button onClick={() => setDraft(null)} className="rounded-lg border border-slate-200 px-3 py-1.5 hover:bg-slate-50">
              Cancelar
            </button>
          </div>
        </div>
      )}

      {data === null ? (
        <p className="py-6 text-center text-sm text-slate-400">Cargando...</p>
      ) : data.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-xs text-slate-500">
          <BookOpen className="mx-auto mb-2 h-6 w-6 text-slate-300" />
          {query ? 'Sin resultados.' : 'Todavía no hay artículos. Se agregan solos al cerrar tickets con la solución.'}
        </p>
      ) : (
        <ul className="grid gap-2 lg:grid-cols-2">
          {data.map((a) => (
            <li key={a.id} className="rounded-xl border border-slate-200 bg-white p-3 text-xs">
              <div className="flex items-start justify-between gap-2">
                <p className="font-semibold text-slate-800">{a.title}</p>
                <span className="flex shrink-0 gap-1">
                  {canWrite && (
                    <button
                      onClick={() => setDraft({ id: a.id, title: a.title, problem: a.problem, solution: a.solution, tags: a.tags.join(', '), alertType: a.alertType ?? '' })}
                      className="rounded p-1 text-slate-400 hover:bg-slate-100"
                      aria-label="Editar"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                  )}
                  {isAdmin && (
                    <button onClick={() => remove(a)} className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600" aria-label="Borrar">
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </span>
              </div>
              <p className="mt-1 text-slate-500">{a.problem.length > 220 ? `${a.problem.slice(0, 217)}...` : a.problem}</p>
              <details className="mt-1.5">
                <summary className="cursor-pointer font-medium text-brand-700">Ver solución</summary>
                <p className="mt-1 whitespace-pre-wrap text-slate-700">{a.solution}</p>
              </details>
              <p className="mt-1.5 flex flex-wrap gap-1 text-[10px] text-slate-400">
                {a.alertType && <span className="rounded bg-slate-100 px-1 font-mono">{a.alertType}</span>}
                {a.tags.map((t) => (
                  <span key={t} className="rounded bg-slate-100 px-1">
                    {t}
                  </span>
                ))}
                <span>
                  · {a.createdByName} · usada {a.uses} vez/veces
                </span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
