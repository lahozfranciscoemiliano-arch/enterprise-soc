'use client';

import { useEffect, useState } from 'react';
import { Check, KeyRound } from 'lucide-react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

/** Configurar / cambiar el PIN personal de 6 digitos (con la contraseña). */
export default function PinSetup() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`${API_URL}/api/account/pin`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : { configured: false }))
      .then((d) => setConfigured(Boolean(d.configured)))
      .catch(() => setConfigured(false));
  }, []);

  const save = async () => {
    if (pin !== pin2) {
      setMsg({ ok: false, text: 'Los PIN no coinciden' });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/api/account/pin`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, pin }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ ok: false, text: body.error ?? 'No se pudo guardar el PIN' });
        return;
      }
      setConfigured(true);
      setOpen(false);
      setPassword('');
      setPin('');
      setPin2('');
      setMsg({ ok: true, text: 'PIN guardado' });
    } finally {
      setBusy(false);
    }
  };

  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 6);
  const input = 'w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-800 outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10';

  return (
    <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-medium text-slate-600">
          <KeyRound className="h-3.5 w-3.5 text-slate-400" /> PIN de aprobación (6 dígitos)
        </span>
        {configured !== null && (
          <span
            className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] ${configured ? 'border border-emerald-200 bg-emerald-50 text-emerald-700' : 'border border-slate-300 bg-slate-50 text-slate-500'}`}
          >
            {configured && <Check className="h-2.5 w-2.5" />}
            {configured ? 'Configurado' : 'Sin configurar'}
          </span>
        )}
      </div>
      <p className="mb-2 text-[11px] text-slate-500">Personal e intransferible: aprueba remediaciones y cambios de estado de tickets. 5 errores = bloqueo de 15 min.</p>
      {!open ? (
        <button onClick={() => setOpen(true)} className="w-full rounded-lg bg-brand-600 py-2 text-xs font-medium text-white transition-colors hover:bg-brand-700">
          {configured ? 'Cambiar PIN' : 'Configurar PIN'}
        </button>
      ) : (
        <div className="space-y-2">
          <input type="password" placeholder="Contraseña actual" value={password} onChange={(e) => setPassword(e.target.value)} className={input} />
          <input type="password" inputMode="numeric" placeholder="Nuevo PIN (6 dígitos)" value={pin} onChange={(e) => setPin(digits(e.target.value))} className={`${input} text-center tracking-[0.4em]`} />
          <input type="password" inputMode="numeric" placeholder="Repetir PIN" value={pin2} onChange={(e) => setPin2(digits(e.target.value))} className={`${input} text-center tracking-[0.4em]`} />
          <button
            onClick={save}
            disabled={busy || !password || pin.length !== 6 || pin2.length !== 6}
            className="w-full rounded-lg bg-brand-600 py-2 text-xs font-medium text-white transition-colors hover:bg-brand-700 disabled:opacity-50"
          >
            Guardar PIN
          </button>
        </div>
      )}
      {msg && <p className={`mt-2 text-[11px] ${msg.ok ? 'text-emerald-700' : 'text-red-700'}`}>{msg.text}</p>}
    </div>
  );
}
