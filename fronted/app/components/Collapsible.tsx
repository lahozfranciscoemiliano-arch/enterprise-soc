'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

function readState(id: string, fallback: boolean): boolean {
  try {
    const v = window.localStorage.getItem(`soc:collapse:${id}`);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

function saveState(id: string, open: boolean) {
  try {
    window.localStorage.setItem(`soc:collapse:${id}`, open ? '1' : '0');
  } catch {
    /* navegador sin almacenamiento: solo dura la sesion */
  }
}

/**
 * Hace contraible una tarjeta existente sin tocar su contenido: el hijo debe
 * ser la tarjeta (un <div> con su encabezado como primer elemento). Contraida
 * queda visible solo el encabezado; un clic en el titulo (h2/h3) o en la
 * flecha la abre o la cierra. El estado se recuerda por navegador.
 */
export default function Collapsible({ id, children, defaultOpen = true }: { id: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setOpen(readState(id, defaultOpen));
  }, [id, defaultOpen]);

  const toggle = useCallback(() => {
    setOpen((o) => {
      saveState(id, !o);
      return !o;
    });
  }, [id]);

  useLayoutEffect(() => {
    const card = wrap.current?.firstElementChild as HTMLElement | null;
    const header = card?.firstElementChild as HTMLElement | null;
    if (!card || !header) return undefined;
    card.style.paddingRight = card.style.paddingRight || '3rem';
    const title = header.matches('h2,h3') ? header : (header.querySelector('h2,h3') as HTMLElement | null);
    if (title) {
      title.style.cursor = 'pointer';
      title.addEventListener('click', toggle);
    }
    // Contraida: se oculta todo lo que no es el encabezado.
    for (const el of Array.from(card.children) as HTMLElement[]) {
      if (el === header) continue;
      if (open) {
        if (el.dataset.socCollapsed) {
          el.style.display = el.dataset.socDisplay ?? '';
          delete el.dataset.socCollapsed;
          delete el.dataset.socDisplay;
        }
      } else if (!el.dataset.socCollapsed) {
        el.dataset.socCollapsed = '1';
        el.dataset.socDisplay = el.style.display;
        el.style.display = 'none';
      }
    }
    header.style.marginBottom = open ? '' : '0';
    return () => title?.removeEventListener('click', toggle);
  }, [open, toggle, children]);

  return (
    <div ref={wrap} className="relative">
      {children}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-label={open ? 'Contraer' : 'Expandir'}
        title={open ? 'Contraer' : 'Expandir'}
        className="absolute right-3 top-3 z-10 rounded-lg border border-slate-200 bg-white p-1 text-slate-400 transition-colors hover:bg-slate-50 hover:text-slate-700"
      >
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
    </div>
  );
}
