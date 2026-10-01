'use client';

import { useId } from 'react';
import type { ServerProfile } from '../../lib/serverCatalog';

// Imagen del servidor generada a partir de la marca, el modelo y el formato
// (rack 1U/2U/4U, torre, blade, VM, NAS...). Se actualiza sola cuando el agente
// detecta el hardware o cuando se corrige la ficha a mano.

const STATUS_LED: Record<string, string> = { ONLINE: '#22c55e', DEGRADED: '#f59e0b', OFFLINE: '#ef4444' };

type P = { profile: ServerProfile; status: string; uid: string };

function Led({ cx, cy, color, r = 1.8, pulse = false }: { cx: number; cy: number; color: string; r?: number; pulse?: boolean }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r={r * 2.2} fill={color} opacity={0.18} />
      <circle cx={cx} cy={cy} r={r} fill={color} className={pulse ? 'animate-pulse' : undefined} />
    </g>
  );
}

// Bahia de disco con su manija y LED de actividad.
function Bay({ x, y, w, h, vertical, active, uid }: { x: number; y: number; w: number; h: number; vertical: boolean; active: boolean; uid: string }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={1.5} fill={`url(#${uid}-bay)`} stroke="#0b0e13" strokeWidth={0.8} />
      {vertical ? (
        <>
          <rect x={x + 2} y={y + 3} width={w - 4} height={h * 0.62} rx={1} fill={`url(#${uid}-grille)`} opacity={0.9} />
          <rect x={x + w / 2 - 2.2} y={y + h * 0.7} width={4.4} height={h * 0.24} rx={1} fill="#4b5563" />
          <circle cx={x + w / 2} cy={y + h - 2.6} r={1.1} fill={active ? '#4ade80' : '#475569'} />
        </>
      ) : (
        <>
          <rect x={x + 3} y={y + 3} width={w * 0.62} height={h - 6} rx={1} fill={`url(#${uid}-grille)`} opacity={0.9} />
          <rect x={x + w * 0.7} y={y + h / 2 - 2.2} width={w * 0.22} height={4.4} rx={1} fill="#4b5563" />
          <circle cx={x + w - 3} cy={y + 3.2} r={1.1} fill={active ? '#4ade80' : '#475569'} />
        </>
      )}
    </g>
  );
}

function Wordmark({ x, y, profile, size = 9, anchor = 'start', fill = '#e5e7eb' }: { x: number; y: number; profile: ServerProfile; size?: number; anchor?: 'start' | 'middle' | 'end'; fill?: string }) {
  // Las marcas largas (SUPERMICRO, GIGABYTE) se achican para entrar en el panel.
  const fit = profile.wordmark.length > 7 ? size * 0.68 : size;
  return (
    <text x={x} y={y} fontSize={fit} fontWeight={800} letterSpacing={profile.wordmark.length > 7 ? 0.2 : 1.2} fill={fill} textAnchor={anchor} fontFamily="Inter, ui-sans-serif, system-ui, sans-serif">
      {profile.wordmark}
    </text>
  );
}

function Defs({ uid, accent }: { uid: string; accent: string }) {
  return (
    <defs>
      <linearGradient id={`${uid}-metal`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#3a4250" />
        <stop offset="0.08" stopColor="#262c36" />
        <stop offset="0.92" stopColor="#171b22" />
        <stop offset="1" stopColor="#0d1015" />
      </linearGradient>
      <linearGradient id={`${uid}-side`} x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stopColor="#1f242d" />
        <stop offset="1" stopColor="#0c0f14" />
      </linearGradient>
      <linearGradient id={`${uid}-top`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#4b5565" />
        <stop offset="1" stopColor="#2b313c" />
      </linearGradient>
      <linearGradient id={`${uid}-bay`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#3b4352" />
        <stop offset="1" stopColor="#222832" />
      </linearGradient>
      <linearGradient id={`${uid}-accent`} x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stopColor={accent} stopOpacity={0} />
        <stop offset="0.5" stopColor={accent} />
        <stop offset="1" stopColor={accent} stopOpacity={0} />
      </linearGradient>
      <pattern id={`${uid}-grille`} width="3" height="3" patternUnits="userSpaceOnUse">
        <rect width="3" height="3" fill="#161a21" />
        <circle cx="1.5" cy="1.5" r="0.8" fill="#4a5363" />
      </pattern>
      <pattern id={`${uid}-hex`} width="6" height="5.2" patternUnits="userSpaceOnUse">
        <rect width="6" height="5.2" fill="#12161c" />
        <circle cx="1.5" cy="1.3" r="1.1" fill="#323a47" />
        <circle cx="4.5" cy="3.9" r="1.1" fill="#323a47" />
      </pattern>
      <radialGradient id={`${uid}-floor`} cx="0.5" cy="0.5" r="0.5">
        <stop offset="0" stopColor="#000" stopOpacity={0.35} />
        <stop offset="1" stopColor="#000" stopOpacity={0} />
      </radialGradient>
    </defs>
  );
}

// Chasis de rack visto de frente (1U, 2U o 4U).
function Rack({ profile, status, uid, units }: P & { units: 1 | 2 | 4 }) {
  const h = units === 1 ? 40 : units === 2 ? 80 : 146;
  const y = 100 - h / 2;
  const x = 14;
  const w = 292;
  const led = STATUS_LED[status] ?? '#64748b';
  const online = status !== 'OFFLINE';
  const leftW = units === 1 ? 44 : 56;
  const rightW = units === 1 ? 40 : 48;
  const bayX = x + leftW + 4;
  const bayW = w - leftW - rightW - 8;
  const bays: React.ReactNode[] = [];
  if (units === 1) {
    const n = 10;
    const bw = (bayW - (n - 1) * 2) / n;
    for (let i = 0; i < n; i++) bays.push(<Bay key={i} uid={uid} x={bayX + i * (bw + 2)} y={y + 3} w={bw} h={h - 6} vertical active={online && i % 3 !== 2} />);
  } else {
    const rows = units === 2 ? 2 : 3;
    const cols = 4;
    const bayArea = units === 4 ? h * 0.6 : h - 8;
    const bh = (bayArea - (rows - 1) * 3) / rows;
    const bw = (bayW - (cols - 1) * 3) / cols;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        bays.push(<Bay key={`${r}-${c}`} uid={uid} x={bayX + c * (bw + 3)} y={y + 4 + r * (bh + 3)} w={bw} h={bh} vertical={false} active={online && (r + c) % 3 !== 1} />);
  }
  return (
    <g>
      <ellipse cx={160} cy={y + h + 14} rx={150} ry={9} fill={`url(#${uid}-floor)`} />
      {/* Orejas de montaje */}
      {[x - 10, x + w].map((ex) => (
        <g key={ex}>
          <rect x={ex} y={y} width={10} height={h} rx={1.5} fill="#2b313b" stroke="#0b0e13" strokeWidth={0.6} />
          {Array.from({ length: units === 1 ? 1 : units === 2 ? 2 : 3 }).map((_, i, arr) => (
            <circle key={i} cx={ex + 5} cy={y + (h / (arr.length + 1)) * (i + 1)} r={1.8} fill="#0f1217" />
          ))}
        </g>
      ))}
      <rect x={x} y={y} width={w} height={h} rx={3} fill={`url(#${uid}-metal)`} stroke="#07090c" strokeWidth={1} />
      <rect x={x + 1} y={y + 1} width={w - 2} height={1.2} fill="#ffffff" opacity={0.12} />
      {/* Panel izquierdo: marca + LEDs */}
      <rect x={x + 3} y={y + 3} width={leftW - 2} height={h - 6} rx={2} fill={units === 4 ? `url(#${uid}-hex)` : '#14181f'} />
      <rect x={x + 3} y={y + 3} width={2.4} height={h - 6} rx={1} fill={profile.accent} />
      <Wordmark x={x + 9} y={y + (units === 1 ? 15 : 17)} profile={profile} size={units === 1 ? 7 : 8} />
      <Led cx={x + 11} cy={y + h - (units === 1 ? 9 : 11)} color={led} pulse={online} />
      <Led cx={x + 18} cy={y + h - (units === 1 ? 9 : 11)} color={online ? '#38bdf8' : '#334155'} r={1.4} />
      {bays}
      {units === 4 && (
        <rect x={bayX} y={y + 4 + h * 0.6 + 4} width={bayW} height={h * 0.4 - 12} rx={2} fill={`url(#${uid}-hex)`} stroke="#0b0e13" strokeWidth={0.6} />
      )}
      {/* Panel derecho: encendido, USB, VGA */}
      <rect x={x + w - rightW - 1} y={y + 3} width={rightW - 2} height={h - 6} rx={2} fill="#14181f" />
      <circle cx={x + w - rightW / 2 - 2} cy={y + (units === 1 ? h / 2 : 16)} r={units === 1 ? 5 : 6} fill="#0b0e13" stroke={online ? led : '#475569'} strokeWidth={1.4} />
      <path
        d={`M ${x + w - rightW / 2 - 2} ${y + (units === 1 ? h / 2 - 3 : 12.5)} v ${units === 1 ? 3 : 3.5}`}
        stroke={online ? led : '#475569'}
        strokeWidth={1.2}
        strokeLinecap="round"
      />
      {units !== 1 && (
        <>
          <rect x={x + w - rightW + 6} y={y + 30} width={10} height={4} rx={0.8} fill="#0b0e13" stroke="#3b4352" strokeWidth={0.5} />
          <rect x={x + w - rightW + 20} y={y + 30} width={10} height={4} rx={0.8} fill="#0b0e13" stroke="#3b4352" strokeWidth={0.5} />
          <rect x={x + w - rightW + 6} y={y + 40} width={24} height={7} rx={1.5} fill="#1e3a8a" opacity={0.7} />
        </>
      )}
      <rect x={x + 30} y={y + h - 1.6} width={w - 60} height={1.2} fill={`url(#${uid}-accent)`} opacity={0.9} />
    </g>
  );
}

// Torre (servidor de piso) o PC de escritorio, en perspectiva.
function Tower({ profile, status, uid, small }: P & { small?: boolean }) {
  const w = small ? 74 : 96;
  const h = small ? 130 : 168;
  const depth = small ? 26 : 34;
  const x = 160 - (w + depth) / 2;
  const y = 100 - h / 2 + 6;
  const led = STATUS_LED[status] ?? '#64748b';
  const online = status !== 'OFFLINE';
  const bayCount = small ? 0 : 4;
  return (
    <g>
      <ellipse cx={160} cy={y + h + 8} rx={(w + depth) * 0.75} ry={8} fill={`url(#${uid}-floor)`} />
      {/* lateral y tapa */}
      <polygon points={`${x + w},${y} ${x + w + depth},${y - depth * 0.45} ${x + w + depth},${y + h - depth * 0.45} ${x + w},${y + h}`} fill={`url(#${uid}-side)`} />
      <polygon points={`${x},${y} ${x + depth},${y - depth * 0.45} ${x + w + depth},${y - depth * 0.45} ${x + w},${y}`} fill={`url(#${uid}-top)`} />
      <rect x={x} y={y} width={w} height={h} rx={3} fill={`url(#${uid}-metal)`} stroke="#07090c" strokeWidth={1} />
      <rect x={x + 3} y={y + 3} width={w - 6} height={h - 6} rx={2} fill="#151920" />
      <rect x={x + 3} y={y + 3} width={2.4} height={h - 6} rx={1} fill={profile.accent} />
      <Wordmark x={x + w / 2 + 1} y={y + 17} profile={profile} size={small ? 7.5 : 9} anchor="middle" />
      {/* lectora optica */}
      <rect x={x + 10} y={y + 24} width={w - 20} height={small ? 8 : 10} rx={1.5} fill="#232934" stroke="#0b0e13" strokeWidth={0.6} />
      {Array.from({ length: bayCount }).map((_, i) => (
        <Bay key={i} uid={uid} x={x + 10} y={y + 40 + i * 17} w={w - 20} h={14} vertical={false} active={online && i !== 3} />
      ))}
      <rect
        x={x + 10}
        y={y + (small ? 40 : 112)}
        width={w - 20}
        height={small ? h - 60 : h - 132}
        rx={2}
        fill={`url(#${uid}-hex)`}
        stroke="#0b0e13"
        strokeWidth={0.6}
      />
      <circle cx={x + w - 16} cy={y + h - 10} r={4.6} fill="#0b0e13" stroke={online ? led : '#475569'} strokeWidth={1.3} />
      <Led cx={x + 14} cy={y + h - 10} color={led} pulse={online} />
      <Led cx={x + 21} cy={y + h - 10} color={online ? '#38bdf8' : '#334155'} r={1.4} />
    </g>
  );
}

function Blade({ profile, status, uid }: P) {
  const led = STATUS_LED[status] ?? '#64748b';
  const online = status !== 'OFFLINE';
  const x = 34;
  const y = 30;
  const w = 252;
  const h = 140;
  const n = 8;
  const bw = (w - 16 - (n - 1) * 3) / n;
  return (
    <g>
      <ellipse cx={160} cy={y + h + 10} rx={140} ry={8} fill={`url(#${uid}-floor)`} />
      <rect x={x} y={y} width={w} height={h} rx={3} fill={`url(#${uid}-metal)`} stroke="#07090c" />
      <Wordmark x={x + 10} y={y + 13} profile={profile} size={8} />
      <rect x={x + 8} y={y + 18} width={w - 16} height={1.4} fill={profile.accent} />
      {Array.from({ length: n }).map((_, i) => {
        const bx = x + 8 + i * (bw + 3);
        return (
          <g key={i}>
            <rect x={bx} y={y + 24} width={bw} height={h - 32} rx={1.5} fill={`url(#${uid}-bay)`} stroke="#0b0e13" strokeWidth={0.7} />
            <rect x={bx + 3} y={y + 30} width={bw - 6} height={h - 70} rx={1} fill={`url(#${uid}-grille)`} />
            <rect x={bx + bw / 2 - 3} y={y + h - 34} width={6} height={18} rx={1.5} fill="#4b5563" />
            <Led cx={bx + bw / 2} cy={y + h - 12} color={i === 0 ? led : online ? '#4ade80' : '#334155'} r={1.3} pulse={i === 0 && online} />
          </g>
        );
      })}
    </g>
  );
}

function Mini({ profile, status, uid }: P) {
  const led = STATUS_LED[status] ?? '#64748b';
  const online = status !== 'OFFLINE';
  const x = 92;
  const y = 104;
  const w = 136;
  const h = 34;
  const d = 40;
  return (
    <g>
      <ellipse cx={160 + d / 4} cy={y + h + 8} rx={110} ry={8} fill={`url(#${uid}-floor)`} />
      <polygon points={`${x},${y} ${x + d},${y - d * 0.55} ${x + w + d},${y - d * 0.55} ${x + w},${y}`} fill={`url(#${uid}-top)`} />
      <polygon points={`${x + w},${y} ${x + w + d},${y - d * 0.55} ${x + w + d},${y + h - d * 0.55} ${x + w},${y + h}`} fill={`url(#${uid}-side)`} />
      <rect x={x} y={y} width={w} height={h} rx={3} fill={`url(#${uid}-metal)`} stroke="#07090c" />
      <g transform={`translate(${x + w / 2 + d / 2} ${y - d * 0.28}) skewX(-36) scale(1 0.55)`}>
        <Wordmark x={0} y={6} profile={profile} size={13} anchor="middle" fill="#cbd5e1" />
      </g>
      <circle cx={x + 14} cy={y + h / 2} r={5} fill="#0b0e13" stroke={online ? led : '#475569'} strokeWidth={1.3} />
      {[0, 1, 2].map((i) => (
        <rect key={i} x={x + 30 + i * 16} y={y + h / 2 - 3} width={11} height={5} rx={1} fill="#0b0e13" stroke="#3b4352" strokeWidth={0.5} />
      ))}
      <rect x={x + 82} y={y + 8} width={w - 92} height={h - 16} rx={2} fill={`url(#${uid}-hex)`} />
      <rect x={x + 6} y={y + h - 3} width={w - 12} height={1.2} fill={`url(#${uid}-accent)`} />
    </g>
  );
}

function Nas({ profile, status, uid }: P) {
  const led = STATUS_LED[status] ?? '#64748b';
  const online = status !== 'OFFLINE';
  const x = 104;
  const y = 34;
  const w = 112;
  const h = 128;
  return (
    <g>
      <ellipse cx={160} cy={y + h + 8} rx={90} ry={8} fill={`url(#${uid}-floor)`} />
      <rect x={x} y={y} width={w} height={h} rx={8} fill={`url(#${uid}-metal)`} stroke="#07090c" />
      <Wordmark x={x + w / 2} y={y + 16} profile={profile} size={9} anchor="middle" />
      {[0, 1, 2, 3].map((i) => (
        <Bay key={i} uid={uid} x={x + 14 + i * 22} y={y + 26} w={18} h={h - 50} vertical active={online && i !== 3} />
      ))}
      <Led cx={x + 18} cy={y + h - 12} color={led} pulse={online} />
      <circle cx={x + w - 18} cy={y + h - 12} r={4.6} fill="#0b0e13" stroke={online ? led : '#475569'} strokeWidth={1.3} />
      <rect x={x + 30} y={y + h - 3} width={w - 60} height={1.2} fill={`url(#${uid}-accent)`} />
    </g>
  );
}

function Laptop({ profile, status, uid }: P) {
  const led = STATUS_LED[status] ?? '#64748b';
  return (
    <g>
      <ellipse cx={160} cy={160} rx={120} ry={8} fill={`url(#${uid}-floor)`} />
      <rect x={82} y={40} width={156} height={100} rx={6} fill={`url(#${uid}-metal)`} stroke="#07090c" />
      <rect x={89} y={47} width={142} height={84} rx={2} fill="#0b1220" />
      <rect x={89} y={47} width={142} height={84} rx={2} fill={profile.accent} opacity={0.18} />
      <Wordmark x={160} y={94} profile={profile} size={12} anchor="middle" fill="#e2e8f0" />
      <polygon points="66,150 254,150 238,140 82,140" fill={`url(#${uid}-top)`} stroke="#07090c" strokeWidth={0.6} />
      <rect x={66} y={150} width={188} height={5} rx={2} fill="#151920" />
      <Led cx={160} cy={145} color={led} r={1.4} pulse={status !== 'OFFLINE'} />
    </g>
  );
}

// Maquina virtual: pila de capas sobre el hipervisor.
function Virtual({ profile, status, uid }: P) {
  const led = STATUS_LED[status] ?? '#64748b';
  const layer = (cy: number, fill: string, opacity: number) => (
    <g>
      <polygon points={`160,${cy - 26} 236,${cy} 160,${cy + 26} 84,${cy}`} fill={fill} opacity={opacity} stroke="#ffffff" strokeOpacity={0.25} strokeWidth={0.8} />
      <polygon points={`84,${cy} 160,${cy + 26} 160,${cy + 34} 84,${cy + 8}`} fill="#0b1220" opacity={0.55} />
      <polygon points={`236,${cy} 160,${cy + 26} 160,${cy + 34} 236,${cy + 8}`} fill="#0b1220" opacity={0.35} />
    </g>
  );
  return (
    <g>
      <ellipse cx={160} cy={162} rx={110} ry={9} fill={`url(#${uid}-floor)`} />
      {layer(130, '#1e293b', 1)}
      {layer(104, profile.accent, 0.55)}
      {layer(78, profile.accent, 0.9)}
      <g transform="translate(160 78) scale(1 0.52) rotate(-45)">
        <rect x={-18} y={-18} width={36} height={36} rx={4} fill="none" stroke="#fff" strokeOpacity={0.7} strokeWidth={2} />
        <rect x={-8} y={-8} width={16} height={16} rx={2} fill="#fff" fillOpacity={0.75} />
      </g>
      <Wordmark x={160} y={182} profile={profile} size={11} anchor="middle" fill="#cbd5e1" />
      <Led cx={232} cy={70} color={led} r={2.4} pulse={status !== 'OFFLINE'} />
    </g>
  );
}

// Encuadre de cada formato: el equipo ocupa todo el espacio disponible.
const VIEWBOX: Partial<Record<ServerProfile['formFactor'], string>> = {
  rack1u: '-14 62 348 82',
  rack2u: '-14 46 348 120',
  rack4u: '-14 16 348 182',
  blade: '20 20 280 168',
  vm: '40 36 240 156',
  mini: '60 52 236 106',
  nas: '60 24 200 162',
  laptop: '50 30 220 140',
};

export default function ServerIllustration({ profile, status, className }: { profile: ServerProfile; status: string; className?: string }) {
  const uid = `srv${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const props = { profile, status, uid };
  let body: React.ReactNode;
  switch (profile.formFactor) {
    case 'rack1u':
      body = <Rack {...props} units={1} />;
      break;
    case 'rack2u':
      body = <Rack {...props} units={2} />;
      break;
    case 'rack4u':
      body = <Rack {...props} units={4} />;
      break;
    case 'blade':
      body = <Blade {...props} />;
      break;
    case 'vm':
      body = <Virtual {...props} />;
      break;
    case 'mini':
      body = <Mini {...props} />;
      break;
    case 'nas':
      body = <Nas {...props} />;
      break;
    case 'laptop':
      body = <Laptop {...props} />;
      break;
    case 'desktop':
      body = <Tower {...props} small />;
      break;
    default:
      body = <Tower {...props} />;
  }
  return (
    <svg viewBox={VIEWBOX[profile.formFactor] ?? "20 0 280 200"} className={className} role="img" aria-label={`${profile.brandLabel} ${profile.model}`.trim()}>
      <Defs uid={uid} accent={profile.accent} />
      {body}
    </svg>
  );
}
