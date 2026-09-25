import { motion } from 'framer-motion';
import { Clock, LogOut, UserRound } from 'lucide-react';
import type { ConnectionStatus } from '../types';

export default function Header({
  status,
  lastSync,
  userEmail,
  onLogout,
  onOpenAccount,
}: {
  status: ConnectionStatus;
  lastSync: string | null;
  userEmail: string;
  onLogout: () => void;
  onOpenAccount: () => void;
}) {
  const statusLabel =
    status === 'connected' ? 'Conectado' : status === 'connecting' ? 'Conectando...' : 'Desconectado';
  const statusDot =
    status === 'connected' ? 'bg-emerald-500' : status === 'connecting' ? 'bg-amber-500' : 'bg-red-500';

  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="h-1 w-full animate-gradient-bar" />
      <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-3.5">
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-bistro.png" alt="Grupo Bistro" className="h-8 w-auto shrink-0 object-contain" />
          <div className="hidden h-8 w-px bg-slate-200 sm:block" />
          <div className="hidden sm:block">
            <h1 className="text-sm font-semibold leading-tight text-slate-900">SOC / NOC Central</h1>
            <p className="flex items-center gap-1 text-xs text-slate-500">
              <Clock className="h-3 w-3" />
              {lastSync ? new Date(lastSync).toLocaleString('es-ES') : 'Sin sincronizar'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-600">
            <span className="relative flex h-2 w-2">
              {status === 'connected' && (
                <motion.span
                  className={`absolute inline-flex h-full w-full rounded-full ${statusDot} opacity-75`}
                  animate={{ scale: [1, 1.8], opacity: [0.6, 0] }}
                  transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut' }}
                />
              )}
              <span className={`relative inline-flex h-2 w-2 rounded-full ${statusDot}`} />
            </span>
            {statusLabel}
          </div>
          <button
            onClick={onOpenAccount}
            className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-50"
            title={userEmail}
          >
            <UserRound className="h-3.5 w-3.5" />
            <span className="hidden md:inline">Mi cuenta</span>
          </button>
          <button
            onClick={onLogout}
            className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span className="hidden md:inline">Cerrar sesión</span>
          </button>
        </div>
      </div>
    </header>
  );
}
