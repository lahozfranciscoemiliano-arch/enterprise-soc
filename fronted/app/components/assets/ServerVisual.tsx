'use client';

import { useEffect, useState } from 'react';
import ServerIllustration from './ServerIllustration';
import { API_URL } from '../inventory/useLiveData';
import type { ServerProfile } from '../../lib/serverCatalog';

// "Escenario" oscuro con la imagen del servidor: la foto propia si se subio
// una, si no la ilustracion automatica segun marca / modelo / formato.
export default function ServerVisual({
  serverId,
  photoAt,
  profile,
  status,
  className = '',
  compact = false,
}: {
  serverId: string;
  photoAt: string | null;
  profile: ServerProfile;
  status: string;
  className?: string;
  compact?: boolean;
}) {
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!photoAt) {
      setPhotoUrl(null);
      return;
    }
    let url: string | null = null;
    let cancelled = false;
    fetch(`${API_URL}/api/assets/${serverId}/photo?v=${encodeURIComponent(photoAt)}`, { credentials: 'include' })
      .then((res) => (res.ok ? res.blob() : null))
      .then((blob) => {
        if (!blob || cancelled) return;
        url = URL.createObjectURL(blob);
        setPhotoUrl(url);
      })
      .catch(() => setPhotoUrl(null));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [serverId, photoAt]);

  return (
    <div
      className={`relative overflow-hidden bg-slate-950 ${className}`}
      style={{ backgroundImage: `radial-gradient(120% 90% at 50% 0%, ${profile.accent}33 0%, transparent 55%), linear-gradient(180deg, #0f172a 0%, #020617 100%)` }}
    >
      {!compact && (
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{ backgroundImage: 'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)', backgroundSize: '22px 22px' }}
        />
      )}
      {photoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={photoUrl} alt={`${profile.brandLabel} ${profile.model}`} className="relative h-full w-full object-contain p-3" onError={() => setPhotoUrl(null)} />
      ) : (
        <ServerIllustration profile={profile} status={status} className="relative h-full w-full" />
      )}
    </div>
  );
}
