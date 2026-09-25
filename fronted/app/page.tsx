'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ShieldCheck, Lock, Mail, KeyRound, ArrowLeft, Activity, Radar, ServerCog } from 'lucide-react';
import Dashboard from './components/Dashboard';
import type { CurrentUser } from './types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

const FEATURES = [
  { icon: Activity, text: 'Telemetría en vivo de CPU, RAM, disco y red' },
  { icon: Radar, text: 'Detección de anomalías y triage de alertas con IA' },
  { icon: ServerCog, text: '21 servidores, 4 sistemas de punto de venta, un solo panel' },
];

export default function DashboardPage() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [checkedSession, setCheckedSession] = useState(false);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);

  // Paso 2FA: si el login devuelve requires2FA, guardamos el tempToken en
  // memoria (nunca en localStorage) hasta que se confirme el codigo.
  const [tempToken, setTempToken] = useState<string | null>(null);
  const [twoFaCode, setTwoFaCode] = useState('');

  const loadCurrentUser = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/auth/me`, { credentials: 'include' });
      if (res.ok) {
        setUser(await res.json());
      } else {
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      setCheckedSession(true);
    }
  }, []);

  useEffect(() => {
    loadCurrentUser();
  }, [loadCurrentUser]);

  const handleLogin = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      setLoginError(null);
      setLoggingIn(true);

      try {
        const res = await fetch(`${API_URL}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ email, password }),
        });

        const body = await res.json();

        if (!res.ok) {
          throw new Error(body.error || 'No se pudo iniciar sesión');
        }

        if (body.requires2FA) {
          setTempToken(body.tempToken);
          return;
        }

        setUser(body.user);
      } catch (err) {
        setLoginError(err instanceof Error ? err.message : 'Error desconocido');
      } finally {
        setLoggingIn(false);
      }
    },
    [email, password]
  );

  const handleVerify2fa = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!tempToken) return;
      setLoginError(null);
      setLoggingIn(true);

      try {
        const res = await fetch(`${API_URL}/api/auth/login/2fa`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ tempToken, code: twoFaCode.trim() }),
        });

        const body = await res.json();

        if (!res.ok) {
          throw new Error(body.error || 'Código incorrecto');
        }

        setUser(body.user);
        setTempToken(null);
        setTwoFaCode('');
      } catch (err) {
        setLoginError(err instanceof Error ? err.message : 'Error desconocido');
      } finally {
        setLoggingIn(false);
      }
    },
    [tempToken, twoFaCode]
  );

  const handleLogout = useCallback(async () => {
    try {
      await fetch(`${API_URL}/api/auth/logout`, { method: 'POST', credentials: 'include' });
    } catch {
      // si la request falla igual limpiamos el estado local
    }
    setUser(null);
    setTempToken(null);
    setEmail('');
    setPassword('');
  }, []);

  if (!checkedSession) return null;

  if (!user) {
    return (
      <main className="flex min-h-screen bg-slate-50">
        {/* Panel de marca: oculto en mobile, la identidad visual va en el panel del form ahi */}
        <div className="relative hidden w-[45%] flex-col justify-between overflow-hidden bg-slate-900 p-12 text-white lg:flex">
          <div
            className="pointer-events-none absolute inset-0 opacity-[0.07]"
            style={{
              backgroundImage:
                'radial-gradient(circle at 1px 1px, white 1px, transparent 0)',
              backgroundSize: '28px 28px',
            }}
          />
          <div
            className="pointer-events-none absolute -right-32 -top-32 h-96 w-96 rounded-full bg-brand-500/20 blur-3xl"
            aria-hidden
          />
          <div
            className="pointer-events-none absolute -bottom-40 -left-20 h-96 w-96 rounded-full bg-brand-700/20 blur-3xl"
            aria-hidden
          />

          <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
            <div className="flex items-center gap-2 text-sm font-medium tracking-wide text-slate-300">
              <ShieldCheck className="h-5 w-5 text-brand-400" />
              SOC / NOC CENTRAL
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.1 }}
            className="relative"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo-bistro.png" alt="Grupo Bistro" className="mb-8 h-12 w-auto brightness-0 invert" />
            <h2 className="mb-4 text-3xl font-semibold leading-tight text-white">
              Monitoreo unificado de toda la operación.
            </h2>
            <p className="max-w-sm text-sm leading-relaxed text-slate-400">
              Un único centro de operaciones para vigilar disponibilidad, seguridad y backups en tiempo real.
            </p>

            <ul className="mt-10 space-y-4">
              {FEATURES.map(({ icon: Icon, text }, i) => (
                <motion.li
                  key={text}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.4, delay: 0.3 + i * 0.1 }}
                  className="flex items-center gap-3 text-sm text-slate-300"
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/10">
                    <Icon className="h-4 w-4 text-brand-400" />
                  </span>
                  {text}
                </motion.li>
              ))}
            </ul>
          </motion.div>

          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.6 }}
            className="relative text-xs text-slate-500"
          >
            Acceso restringido a personal autorizado de Grupo Bistro.
          </motion.p>
        </div>

        {/* Panel del formulario */}
        <div className="flex flex-1 items-center justify-center px-6 py-12">
          <div className="w-full max-w-sm">
            <div className="mb-8 flex items-center gap-3 lg:hidden">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo-bistro.png" alt="Grupo Bistro" className="h-8 w-auto" />
              <span className="text-sm font-semibold text-slate-700">SOC / NOC Central</span>
            </div>

            <AnimatePresence mode="wait">
              {tempToken ? (
                <motion.form
                  key="2fa"
                  onSubmit={handleVerify2fa}
                  initial={{ opacity: 0, x: 12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -12 }}
                  transition={{ duration: 0.2 }}
                  className="rounded-2xl border border-slate-200 bg-white p-8 shadow-card"
                >
                  <div className="mb-6 flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
                    <KeyRound className="h-5 w-5" />
                  </div>
                  <h1 className="mb-1 text-xl font-semibold text-slate-900">Verificación en dos pasos</h1>
                  <p className="mb-6 text-sm text-slate-500">
                    Ingresá el código de tu app de autenticación (o un código de respaldo)
                  </p>

                  <label className="mb-1.5 block text-xs font-medium text-slate-600">Código</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    autoFocus
                    required
                    value={twoFaCode}
                    onChange={(e) => setTwoFaCode(e.target.value)}
                    className="mb-4 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2.5 text-center text-lg tracking-[0.3em] text-slate-900 outline-none transition-colors focus:border-brand-500 focus:bg-white focus:ring-4 focus:ring-brand-500/10"
                    placeholder="123456"
                  />

                  <AnimatePresence>
                    {loginError && (
                      <motion.p
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600"
                      >
                        {loginError}
                      </motion.p>
                    )}
                  </AnimatePresence>

                  <motion.button
                    whileTap={{ scale: 0.98 }}
                    type="submit"
                    disabled={loggingIn}
                    className="w-full rounded-lg bg-brand-600 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-brand-700 disabled:opacity-50"
                  >
                    {loggingIn ? 'Verificando...' : 'Verificar'}
                  </motion.button>
                  <button
                    type="button"
                    onClick={() => {
                      setTempToken(null);
                      setTwoFaCode('');
                      setLoginError(null);
                    }}
                    className="mt-3 flex w-full items-center justify-center gap-1.5 text-xs font-medium text-slate-500 transition-colors hover:text-slate-700"
                  >
                    <ArrowLeft className="h-3.5 w-3.5" />
                    Volver
                  </button>
                </motion.form>
              ) : (
                <motion.form
                  key="login"
                  onSubmit={handleLogin}
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 12 }}
                  transition={{ duration: 0.2 }}
                  className="rounded-2xl border border-slate-200 bg-white p-8 shadow-card"
                >
                  <div className="mb-6 flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
                    <ShieldCheck className="h-5 w-5" />
                  </div>
                  <h1 className="mb-1 text-xl font-semibold text-slate-900">Bienvenido de vuelta</h1>
                  <p className="mb-6 text-sm text-slate-500">Iniciá sesión para acceder al panel</p>

                  <label className="mb-1.5 block text-xs font-medium text-slate-600">Email</label>
                  <div className="relative mb-4">
                    <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                    <input
                      type="email"
                      required
                      autoFocus
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 bg-slate-50 py-2.5 pl-9 pr-3 text-sm text-slate-900 outline-none transition-colors focus:border-brand-500 focus:bg-white focus:ring-4 focus:ring-brand-500/10"
                      placeholder="tu@grupobistro.com"
                    />
                  </div>

                  <label className="mb-1.5 block text-xs font-medium text-slate-600">Contraseña</label>
                  <div className="relative mb-4">
                    <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                    <input
                      type="password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 bg-slate-50 py-2.5 pl-9 pr-3 text-sm text-slate-900 outline-none transition-colors focus:border-brand-500 focus:bg-white focus:ring-4 focus:ring-brand-500/10"
                      placeholder="••••••••"
                    />
                  </div>

                  <AnimatePresence>
                    {loginError && (
                      <motion.p
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600"
                      >
                        {loginError}
                      </motion.p>
                    )}
                  </AnimatePresence>

                  <motion.button
                    whileTap={{ scale: 0.98 }}
                    type="submit"
                    disabled={loggingIn}
                    className="w-full rounded-lg bg-brand-600 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-brand-700 disabled:opacity-50"
                  >
                    {loggingIn ? 'Ingresando...' : 'Ingresar'}
                  </motion.button>
                </motion.form>
              )}
            </AnimatePresence>
          </div>
        </div>
      </main>
    );
  }

  return <Dashboard user={user} onUserChanged={setUser} onLogout={handleLogout} />;
}
