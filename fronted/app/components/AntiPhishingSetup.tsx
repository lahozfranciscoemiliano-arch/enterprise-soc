'use client';

import { useEffect, useState } from 'react';
import { Check, MailCheck } from 'lucide-react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

/**
 * Codigo anti-phishing personal: aparece arriba de cada correo del NOC que
 * recibe este usuario. Si un mail "del NOC" no lo trae, no lo mando el NOC.
 */
export default function AntiPhishingSetup() {
  const [code, setCode] = useState<string | null | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`${API_URL}/api/account/anti-phishing`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : { code: null }))
      .then((d) => setCode(d.code ?? null))
      .catch(() => setCode(null));
  }, []);

  const save = async (value: string) => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`${API_URL}/api/account/anti-phishing`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, code: value }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ ok: false, text: body.error ?? 'No se pudo guardar el código' });
        return;
      }
      setCode(body.code ?? null);
      setOpen(false);
      setPassword('');
      setDraft('');
      setMsg({ ok: true, text: body.code ? 'Código guardado: va a aparecer en tus próximos correos del NOC' : 'Código eliminado' });
    } finally {
      setBusy(false);
    }
  };

  const input = 'w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-800 outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10';

  return (
    <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-medium text-slate-600">
          <MailCheck className="h-3.5 w-3.5 text-slate-400" /> Código anti-phishing
        </span>
        {code !== undefined && (
          <span
            className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] ${code ? 'border border-emerald-200 bg-emerald-50 text-emerald-700' : 'border border-slate-300 bg-slate-50 text-slate-500'}`}
          >
            {code && <Check className="h-2.5 w-2.5" />}
            {code ? 'Configurado' : 'Sin configurar'}
          </span>
        )}
      </div>
      <p className="mb-2 text-[11px] text-slate-500">
        Una palabra que solo vos conocés. Aparece arriba de cada correo que te manda el NOC (reportes, alertas, pruebas): si un correo &quot;del NOC&quot; no
        la muestra, es falso. No uses tu contraseña ni tu PIN.
      </p>
      {code && !open && (
        <p className="mb-2 rounded-lg border border-dashed border-brand-300 bg-white px-3 py-2 text-center font-mono text-sm font-semibold text-brand-800">{code}</p>
      )}
      {!open ? (
        <button
          onClick={() => {
            setOpen(true);
            setDraft(code ?? '');
            setMsg(null);
          }}
          className="w-full rounded-lg bg-brand-600 py-2 text-xs font-medium text-white transition-colors hover:bg-brand-700"
        >
          {code ? 'Cambiar código' : 'Configurar código'}
        </button>
      ) : (
        <div className="space-y-2">
          <input value={draft} onChange={(e) => setDraft(e.target.value.slice(0, 24))} placeholder="Ej: Tango Azul 47" className={`${input} font-mono`} autoFocus />
          <input type="password" placeholder="Contraseña actual (para confirmar)" value={password} onChange={(e) => setPassword(e.target.value)} className={input} />
          <div className="flex gap-2">
            <button
              onClick={() => save(draft.trim())}
              disabled={busy || draft.trim().length < 4 || !password}
              className="flex-1 rounded-lg bg-brand-600 py-2 text-xs font-medium text-white transition-colors hover:bg-brand-700 disabled:opacity-50"
            >
              {busy ? 'Guardando…' : 'Guardar'}
            </button>
            {code && (
              <button
                onClick={() => save('')}
                disabled={busy || !password}
                className="rounded-lg border border-red-200 px-3 py-2 text-xs text-red-700 transition-colors hover:bg-red-50 disabled:opacity-50"
              >
                Quitar
              </button>
            )}
            <button onClick={() => setOpen(false)} className="rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-600 hover:bg-slate-100">
              Cancelar
            </button>
          </div>
        </div>
      )}
      {msg && <p className={`mt-2 text-[11px] ${msg.ok ? 'text-emerald-700' : 'text-red-700'}`}>{msg.text}</p>}
    </div>
  );
}
