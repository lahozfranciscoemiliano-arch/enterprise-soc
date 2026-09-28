'use client';

import { useState } from 'react';
import { Check, Copy, Monitor } from 'lucide-react';

// Escritorio remoto DIRECTO desde la PC del operador a la IP interna del
// servidor: no pasa por el NOC ni por internet. Solo conecta si quien lo usa
// esta en la red de la empresa o con la VPN FortiClient conectada; afuera de
// eso la IP interna simplemente no es alcanzable.
function rdpFile(host: string, name: string): string {
  return [
    `full address:s:${host}`,
    `alternate full address:s:${host}`,
    'prompt for credentials:i:1',
    'authentication level:i:2',
    'enablecredsspsupport:i:1',
    'screen mode id:i:2',
    'use multimon:i:0',
    'redirectclipboard:i:1',
    'redirectprinters:i:0',
    'redirectdrives:i:0',
    'autoreconnection enabled:i:1',
    `title:s:${name}`,
    '',
  ].join('\r\n');
}

export default function RdpConnectButton({
  name,
  host,
  compact = false,
}: {
  name: string;
  host: string | null | undefined;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  if (!host) return null;

  const download = (e: React.MouseEvent) => {
    e.stopPropagation();
    const blob = new Blob([rdpFile(host, name)], { type: 'application/x-rdp' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.rdp`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(`mstsc /v:${host}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* navegador sin permiso de portapapeles */
    }
  };

  const hint = `Escritorio remoto a ${host}. Solo funciona desde la red interna o con la VPN FortiClient conectada.`;

  return (
    <span className="inline-flex items-center overflow-hidden rounded-lg border border-sky-200 text-sky-700" title={hint}>
      <button onClick={download} className={`flex items-center gap-1 transition-colors hover:bg-sky-50 ${compact ? 'px-2 py-1' : 'px-2.5 py-1.5'}`}>
        <Monitor className="h-3 w-3" />
        RDP
        {!compact && <span className="font-mono text-[10px] text-sky-500">{host}</span>}
      </button>
      <button onClick={copy} className="border-l border-sky-200 px-1.5 py-1 transition-colors hover:bg-sky-50" aria-label="Copiar comando mstsc">
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </button>
    </span>
  );
}
