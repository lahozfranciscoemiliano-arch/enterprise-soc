'use client';

import { KeyRound } from 'lucide-react';

/** PIN personal de 6 digitos para aprobar acciones sensibles. */
export default function PinInput({ value, onChange, autoFocus = false }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-1 text-[11px] font-medium text-slate-600">
        <KeyRound className="h-3 w-3" /> Tu PIN de aprobación (6 dígitos)
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
        inputMode="numeric"
        autoComplete="one-time-code"
        type="password"
        autoFocus={autoFocus}
        placeholder="••••••"
        className="w-36 rounded-lg border border-slate-300 bg-white px-3 py-2 text-center font-mono text-lg tracking-[0.4em] outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10"
      />
      <span className="mt-1 block text-[10px] text-slate-400">¿No tenés PIN? Configuralo en tu cuenta (arriba a la derecha).</span>
    </label>
  );
}
