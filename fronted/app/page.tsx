'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Dashboard from './components/Dashboard';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

export default function DashboardPage() {
  const [token, setToken] = useState<string | null>(null);
  const [checkedStorage, setCheckedStorage] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem('soc_token');
    if (stored) setToken(stored);
    setCheckedStorage(true);
  }, []);

  const handleLogin = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      setLoginError(null);
      setLoggingIn(true);

      try {
        const res = await fetch(`${API_URL}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });

        const body = await res.json();

        if (!res.ok) {
          throw new Error(body.error || 'No se pudo iniciar sesión');
        }

        window.localStorage.setItem('soc_token', body.token);
        setToken(body.token);
      } catch (err) {
        setLoginError(err instanceof Error ? err.message : 'Error desconocido');
      } finally {
        setLoggingIn(false);
      }
    },
    [email, password]
  );

  const handleLogout = useCallback(() => {
    window.localStorage.removeItem('soc_token');
    setToken(null);
  }, []);

  if (!checkedStorage) return null;

  if (!token) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gray-950 px-4">
        <form
          onSubmit={handleLogin}
          className="w-full max-w-sm animate-fade-in-scale rounded-xl border border-gray-800 bg-gray-900/60 p-8 shadow-xl"
        >
          <h1 className="mb-1 text-xl font-semibold text-gray-100">Enterprise SOC</h1>
          <p className="mb-6 text-sm text-gray-400">Inicia sesión para acceder al panel</p>

          <label className="mb-1 block text-xs font-medium text-gray-400">Email</label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mb-4 w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 outline-none transition-colors focus:border-blue-500"
          />

          <label className="mb-1 block text-xs font-medium text-gray-400">Contraseña</label>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mb-4 w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 outline-none transition-colors focus:border-blue-500"
          />

          {loginError && <p className="mb-4 text-sm text-red-400">{loginError}</p>}

          <button
            type="submit"
            disabled={loggingIn}
            className="w-full rounded-lg bg-blue-600 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
          >
            {loggingIn ? 'Ingresando...' : 'Ingresar'}
          </button>
        </form>
      </main>
    );
  }

  return <Dashboard token={token} onLogout={handleLogout} />;
}
