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
    <header className="sticky top-0 z-20 border-b border-gray-800 bg-gray-950/95 backdrop-blur">
      <div className="h-1 w-full animate-gradient-bar" />
      <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-blue-500/10 text-2xl">
            🛰️
          </div>
          <div>
            <h1 className="text-lg font-semibold text-gray-100">
              Enterprise SOC <span className="text-blue-400">Command Center</span>
            </h1>
            <p className="flex items-center gap-1 text-xs text-gray-500">
              🕒 Última sincronización: {lastSync ? new Date(lastSync).toLocaleString('es-ES') : '—'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <span className={`h-2 w-2 rounded-full ${statusDot} ${status === 'connected' ? 'animate-pulse' : ''}`} />
            {statusLabel}
          </div>
          <button
            onClick={onOpenAccount}
            className="rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-300 transition-colors hover:bg-gray-800"
            title={userEmail}
          >
            👤 Mi cuenta
          </button>
          <button
            onClick={onLogout}
            className="rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-300 transition-colors hover:bg-gray-800"
          >
            Cerrar sesión
          </button>
        </div>
      </div>
    </header>
  );
}
