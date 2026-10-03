import PinSetup from './ops/PinSetup';
import AntiPhishingSetup from './AntiPhishingSetup';
import { useState } from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle, Check, ShieldCheck, X } from 'lucide-react';
import type { CurrentUser } from '../types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

type SetupState = { secret: string; qrCodeDataUrl: string } | null;

export default function AccountSettingsModal({
  user,
  onUserChanged,
  onClose,
  onLogout,
}: {
  user: CurrentUser;
  onUserChanged: (user: CurrentUser) => void;
  onClose: () => void;
  onLogout: () => void;
}) {
  const [setup, setSetup] = useState<SetupState>(null);
  const [setupCode, setSetupCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [disablePassword, setDisablePassword] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [showDisableForm, setShowDisableForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const startSetup = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/api/auth/2fa/setup`, { method: 'POST', credentials: 'include' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'No se pudo iniciar la configuración de 2FA');
      setSetup(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setBusy(false);
    }
  };

  const confirmSetup = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/api/auth/2fa/verify-setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ code: setupCode.trim() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Código incorrecto');
      setBackupCodes(body.backupCodes);
      setSetup(null);
      setSetupCode('');
      onUserChanged({ ...user, twoFactorEnabled: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setBusy(false);
    }
  };

  const handleDisable = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/api/auth/2fa/disable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ password: disablePassword, code: disableCode.trim() }),
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || 'No se pudo desactivar el 2FA');
      }
      onUserChanged({ ...user, twoFactorEnabled: false });
      setShowDisableForm(false);
      setDisablePassword('');
      setDisableCode('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setBusy(false);
    }
  };

  const handleLogoutAll = async () => {
    if (!window.confirm('Esto cierra la sesión en todos los dispositivos, incluido este. ¿Continuar?')) return;
    await fetch(`${API_URL}/api/auth/logout-all`, { method: 'POST', credentials: 'include' });
    onLogout();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.15 }}
        className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-xl border border-slate-200 bg-white p-6 shadow-2xl"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">Mi cuenta</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mb-4 text-xs text-slate-500">
          {user.name} <span className="text-slate-500">({user.email})</span>
        </p>

        {backupCodes ? (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
            <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-amber-700">
              <AlertTriangle className="h-4 w-4" />
              2FA activado — guardá estos códigos de respaldo ahora
            </p>
            <p className="mb-2 text-xs text-slate-500">
              Cada uno sirve una sola vez, para entrar si perdés el dispositivo con la app de autenticación. No se
              van a volver a mostrar.
            </p>
            <div className="grid grid-cols-2 gap-1 font-mono text-xs text-slate-800">
              {backupCodes.map((c) => (
                <span key={c}>{c}</span>
              ))}
            </div>
            <button
              onClick={() => setBackupCodes(null)}
              className="mt-3 rounded-lg border border-amber-200 px-3 py-1 text-xs text-amber-700 hover:bg-amber-50"
            >
              Ya los guardé
            </button>
          </div>
        ) : (
          <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-xs font-medium text-slate-600">
                <ShieldCheck className="h-3.5 w-3.5 text-slate-400" />
                Verificación en dos pasos (2FA)
              </span>
              <span
                className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] ${
                  user.twoFactorEnabled
                    ? 'border border-emerald-200 bg-emerald-50 text-emerald-700'
                    : 'border border-slate-300 bg-slate-50 text-slate-500'
                }`}
              >
                {user.twoFactorEnabled && <Check className="h-2.5 w-2.5" />}
                {user.twoFactorEnabled ? 'Activado' : 'Desactivado'}
              </span>
            </div>

            {!user.twoFactorEnabled && !setup && (
              <button
                onClick={startSetup}
                disabled={busy}
                className="w-full rounded-lg bg-brand-600 py-2 text-xs font-medium text-white transition-colors hover:bg-brand-700 disabled:opacity-50"
              >
                Activar 2FA
              </button>
            )}

            {setup && (
              <div className="space-y-2">
                <p className="text-xs text-slate-500">
                  Escaneá este código con Google Authenticator, Authy, etc., o ingresá el secreto a mano:
                </p>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={setup.qrCodeDataUrl} alt="Código QR de 2FA" className="mx-auto rounded-lg bg-white p-2" />
                <p className="break-all text-center font-mono text-[11px] text-slate-400">{setup.secret}</p>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="Código de 6 dígitos"
                  value={setupCode}
                  onChange={(e) => setSetupCode(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-center text-sm tracking-widest text-slate-900 outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10 transition-colors"
                />
                <button
                  onClick={confirmSetup}
                  disabled={busy || setupCode.length < 6}
                  className="w-full rounded-lg bg-brand-600 py-2 text-xs font-medium text-white transition-colors hover:bg-brand-700 disabled:opacity-50"
                >
                  Confirmar y activar
                </button>
              </div>
            )}

            {user.twoFactorEnabled && !showDisableForm && (
              <button
                onClick={() => setShowDisableForm(true)}
                className="w-full rounded-lg border border-red-200 py-2 text-xs text-red-700 transition-colors hover:bg-red-50"
              >
                Desactivar 2FA
              </button>
            )}

            {showDisableForm && (
              <div className="space-y-2">
                <input
                  type="password"
                  placeholder="Contraseña actual"
                  value={disablePassword}
                  onChange={(e) => setDisablePassword(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-800 outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10 transition-colors"
                />
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="Código 2FA o de respaldo"
                  value={disableCode}
                  onChange={(e) => setDisableCode(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-800 outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10 transition-colors"
                />
                <button
                  onClick={handleDisable}
                  disabled={busy}
                  className="w-full rounded-lg border border-red-200 py-2 text-xs text-red-700 transition-colors hover:bg-red-50 disabled:opacity-50"
                >
                  Confirmar desactivación
                </button>
              </div>
            )}
          </div>
        )}

        <PinSetup />

        <AntiPhishingSetup />

        {error && <p className="mb-4 text-xs text-red-700">{error}</p>}

        <button
          onClick={handleLogoutAll}
          className="w-full rounded-lg border border-slate-300 py-2 text-xs text-slate-600 transition-colors hover:bg-slate-100"
        >
          Cerrar sesión en todos los dispositivos
        </button>
      </motion.div>
    </div>
  );
}
