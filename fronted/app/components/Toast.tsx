'use client';

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';

type ToastKind = 'error' | 'success' | 'info';
type ToastItem = { id: number; kind: ToastKind; message: string };

const STYLES: Record<ToastKind, { icon: typeof Info; bar: string; icon_: string }> = {
  error: { icon: AlertCircle, bar: 'bg-red-500', icon_: 'text-red-600' },
  success: { icon: CheckCircle2, bar: 'bg-emerald-500', icon_: 'text-emerald-600' },
  info: { icon: Info, bar: 'bg-sky-500', icon_: 'text-sky-600' },
};

const ToastContext = createContext<{ push: (kind: ToastKind, message: string) => void } | null>(null);

// Reemplaza los alert() nativos del navegador (feos, bloqueantes, y sin
// estilo posible) por un toast animado y no bloqueante -- misma info, mejor
// presentacion.
export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast debe usarse dentro de <ToastProvider>');
  const { push } = ctx;
  // Objeto estable (mismo push subyacente) para que los componentes puedan
  // listar "toast" en dependencias de useCallback sin invalidar la memoizacion
  // en cada render.
  return useMemo(
    () => ({
      error: (message: string) => push('error', message),
      success: (message: string) => push('success', message),
      info: (message: string) => push('info', message),
    }),
    [push]
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = ++idRef.current;
      setToasts((prev) => [...prev, { id, kind, message }]);
      setTimeout(() => dismiss(id), 6000);
    },
    [dismiss]
  );

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="pointer-events-none fixed bottom-5 left-1/2 z-[100] flex w-full max-w-sm -translate-x-1/2 flex-col gap-2 px-4 sm:left-auto sm:right-5 sm:translate-x-0">
        <AnimatePresence>
          {toasts.map((t) => {
            const style = STYLES[t.kind];
            const Icon = style.icon;
            return (
              <motion.div
                key={t.id}
                layout
                initial={{ opacity: 0, y: 20, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.15 } }}
                transition={{ type: 'spring', bounce: 0.25, duration: 0.4 }}
                className="pointer-events-auto relative overflow-hidden rounded-xl border border-slate-200 bg-white p-3.5 pr-9 shadow-lg"
              >
                <span className={`absolute inset-y-0 left-0 w-1 ${style.bar}`} />
                <div className="flex items-start gap-2.5 pl-1.5">
                  <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${style.icon_}`} />
                  <p className="text-sm text-slate-700">{t.message}</p>
                </div>
                <button
                  onClick={() => dismiss(t.id)}
                  className="absolute right-2.5 top-2.5 text-slate-300 transition-colors hover:text-slate-500"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
