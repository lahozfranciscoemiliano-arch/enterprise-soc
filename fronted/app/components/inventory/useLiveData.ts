'use client';

import { useCallback, useEffect, useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

// Carga un endpoint de la API y lo vuelve a pedir solo cuando el backend avisa
// por WebSocket que llego un inventario nuevo (evento 'soc:inventory', ver
// Dashboard) o cada `intervalMs` como respaldo.
export function useLiveData<T>(path: string | null, { event = 'soc:inventory', intervalMs = 120_000 } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}${path}`, { credentials: 'include' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'No se pudieron cargar los datos');
      setData(await res.json());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    load();
    // Pestaña oculta (NOC en segundo plano): no se consulta al backend.
    const t = setInterval(() => !document.hidden && load(), intervalMs);
    const onEvent = () => load();
    window.addEventListener(event, onEvent);
    return () => {
      clearInterval(t);
      window.removeEventListener(event, onEvent);
    };
  }, [load, event, intervalMs]);

  return { data, error, loading, reload: load };
}

export { API_URL };
