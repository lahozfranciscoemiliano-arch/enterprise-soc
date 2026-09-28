import { useRef, useState, type FormEvent } from 'react';
import { motion } from 'framer-motion';
import { Bot, Send, X } from 'lucide-react';
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
    <motion.div
      initial={{ opacity: 0, y: 16, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 16, scale: 0.96 }}
      transition={{ duration: 0.18 }}
      className="fixed bottom-4 right-4 z-50 flex h-[520px] w-96 flex-col rounded-xl border border-slate-200 bg-white shadow-2xl"
    >
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
          <Bot className="h-4 w-4 text-brand-600" />
          Asistente
        </h2>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="text-xs text-slate-400">
            Preguntame sobre las alertas abiertas, el estado de los servidores, o pedime ayuda para diagnosticar algo.
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`rounded-lg px-3 py-2 text-xs ${
              m.role === 'user' ? 'ml-6 bg-brand-600 text-white' : 'mr-6 bg-slate-50 text-slate-800'
            }`}
          >
            {m.content}
          </div>
        ))}
        {sending && <div className="mr-6 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">Pensando...</div>}
      </div>

      {error && <p className="border-t border-slate-200 px-4 py-2 text-xs text-red-700">{error}</p>}

      <form onSubmit={send} className="flex gap-2 border-t border-slate-200 p-3">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Escribí tu consulta..."
          className="flex-1 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-800 outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/10 transition-colors"
        />
        <button
          type="submit"
          disabled={sending || !input.trim()}
          className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-brand-700 disabled:opacity-50"
        >
          <Send className="h-3.5 w-3.5" />
          Enviar
        </button>
      </form>
      <p className="border-t border-slate-100 px-3 py-1.5 text-[10px] text-slate-400">
        🔒 Usuarios del AD, equipos, IPs, MACs y contraseñas se anonimizan antes de enviarse a la IA. No pegues credenciales.
      </p>
    </motion.div>
  );
}
