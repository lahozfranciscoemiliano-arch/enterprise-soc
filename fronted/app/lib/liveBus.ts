import type { LiveTelemetry } from '../types';

// Dashboard re-emite cada mensaje TELEMETRY del WebSocket como un evento de
// window, asi cualquier grafico (pestaña Monitoreo, modal de detalle) se
// actualiza en vivo sin pasar el socket por props.
const EVENT = 'soc:telemetry';

export function emitTelemetry(data: LiveTelemetry) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<LiveTelemetry>(EVENT, { detail: data }));
}

export function onTelemetry(handler: (data: LiveTelemetry) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<LiveTelemetry>).detail);
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
