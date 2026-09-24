import { useRef, useState, type FormEvent } from 'react';
import type { AssistantChatMessage } from '../types';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

export default function AssistantPanel({ onClose }: { onClose: () => void }) {
  const [messages, setMessages] = useState<AssistantChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending) return;

    const next = [...messages, { role: 'user' as const, content: text }];
    setMessages(next);
    setInput('');
    setSending(true);
    setError(null);

    try {
      const res = await fetch(`${API_URL}/api/assistant/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ messages: next }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'No se pudo consultar al asistente');

      setMessages((prev) => [...prev, { role: 'assistant', content: body.reply }]);
      setTimeout(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }), 50);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed bottom-4 right-4 z-50 flex h-[520px] w-96 flex-col rounded-xl border border-gray-800 bg-gray-900 shadow-2xl">
      <div className="flex items-center justify-between border-b border-gray-800 px-4 py-3">
        <h2 className="text-sm font-semibold text-gray-100">🤖 Asistente</h2>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-300">
          ✕
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="text-xs text-gray-500">
            Preguntame sobre las alertas abiertas, el estado de los servidores, o pedime ayuda para diagnosticar algo.
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`rounded-lg px-3 py-2 text-xs ${
              m.role === 'user' ? 'ml-6 bg-blue-600 text-white' : 'mr-6 bg-gray-800 text-gray-200'
            }`}
          >
            {m.content}
          </div>
        ))}
        {sending && <div className="mr-6 rounded-lg bg-gray-800 px-3 py-2 text-xs text-gray-400">Pensando...</div>}
      </div>

      {error && <p className="border-t border-gray-800 px-4 py-2 text-xs text-red-400">{error}</p>}

      <form onSubmit={send} className="flex gap-2 border-t border-gray-800 p-3">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Escribí tu consulta..."
          className="flex-1 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-xs text-gray-200 outline-none focus:border-blue-500"
        />
        <button
          type="submit"
          disabled={sending || !input.trim()}
          className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
        >
          Enviar
        </button>
      </form>
    </div>
  );
}
