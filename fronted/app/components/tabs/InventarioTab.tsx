'use client';

import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle,
  Download,
  KeyRound,
  Lock,
  type LucideIcon,
  MonitorSmartphone,
  Network,
  Printer,
  ScrollText,
  Server,
  ShieldAlert,
  Users,
} from 'lucide-react';
import StatCard from '../StatCard';
import EndpointsView from '../inventory/EndpointsView';
import UsersView from '../inventory/UsersView';
import PrintersView from '../inventory/PrintersView';
import IpMapView from '../inventory/IpMapView';
import AuditView from '../inventory/AuditView';
import NetGuardView from '../inventory/NetGuardView';
import { API_URL, useLiveData } from '../inventory/useLiveData';
import { timeAgo } from '../../lib/health';
import type { InventorySummary } from '../../types';

type Section = 'equipos' | 'usuarios' | 'impresoras' | 'ips' | 'seguridad' | 'auditoria';

const SECTIONS: { id: Section; label: string; icon: LucideIcon }[] = [
  { id: 'equipos', label: 'Equipos (PC / laptops)', icon: MonitorSmartphone },
  { id: 'usuarios', label: 'Usuarios del AD', icon: Users },
  { id: 'impresoras', label: 'Impresoras', icon: Printer },
  { id: 'ips', label: 'Mapa de IPs', icon: Network },
  { id: 'seguridad', label: 'Seguridad de red', icon: ShieldAlert },
  { id: 'auditoria', label: 'Sesiones y auditoría', icon: ScrollText },
];

const EXPORTS = [
  { kind: 'equipos', label: 'Equipos' },
  { kind: 'usuarios', label: 'Usuarios' },
  { kind: 'impresoras', label: 'Impresoras' },
  { kind: 'ips', label: 'Mapa de IPs' },
];

export default function InventarioTab({ isAdmin = false, canWrite = false }: { isAdmin?: boolean; canWrite?: boolean }) {
  const [section, setSection] = useState<Section>('equipos');
  const { data: summary } = useLiveData<InventorySummary>('/api/inventory/summary');
  const reporter = summary?.reporters[0] ?? null;
  const info = reporter?.inventorySummary ?? null;
  const stale = reporter ? Date.now() - new Date(reporter.inventoryAt).getTime() > 20 * 60 * 1000 : false;

  return (
    <div className="space-y-4 px-3 py-4 sm:px-6 sm:py-6">
      <div
        className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4 shadow-card ${
          !reporter ? 'border-amber-200 bg-amber-50' : stale ? 'border-red-200 bg-red-50' : 'border-slate-200 bg-white'
        }`}
      >
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
            <Server className="h-5 w-5" />
          </div>
          {reporter && info ? (
            <div>
              <p className="text-sm font-semibold text-slate-800">
                Recolector: {reporter.name}
                <span className="ml-2 text-xs font-normal text-slate-500">
                  último inventario {timeAgo(reporter.inventoryAt)}
                  {info.durationSeconds ? ` · tardó ${Math.round(info.durationSeconds)} s` : ''} · {info.alive}/{info.scanned} IPs responden
                </span>
              </p>
              <div className="mt-1 flex flex-wrap gap-1.5 text-[10px]">
                {[
                  ['Active Directory', info.roles.ad],
                  ['DHCP', info.roles.dhcp],
                  ['Servidor de impresión', info.roles.printServer],
                ].map(([label, on]) => (
                  <span
                    key={label as string}
                    className={`rounded-full border px-2 py-0.5 ${on ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-slate-50 text-slate-400'}`}
                  >
                    {label as string}
                  </span>
                ))}
                {stale && <span className="rounded-full border border-red-200 bg-red-100 px-2 py-0.5 font-medium text-red-700">Sin datos nuevos hace más de 20 min</span>}
              </div>
              {info.errors.length > 0 && (
                <p className="mt-1 flex items-start gap-1 text-[11px] text-amber-700">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                  {info.errors.join(' · ')}
                </p>
              )}
            </div>
          ) : (
            <div className="text-xs text-amber-800">
              <p className="text-sm font-semibold">Todavía no llegó ningún inventario</p>
              <p>
                Se activa solo en el servidor con Active Directory / DHCP (BSFS2) cuando su agente se actualiza a la versión 1.4.0. El agente
                tiene que correr como servicio (cuenta SYSTEM) para poder leer el AD, el DHCP y el registro de seguridad.
              </p>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="flex items-center gap-1 text-[11px] text-slate-400">
            <Download className="h-3.5 w-3.5" /> Excel:
          </span>
          {EXPORTS.map((e) => (
            <a
              key={e.kind}
              href={`${API_URL}/api/inventory/export/${e.kind}.csv`}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] text-slate-600 transition-colors hover:bg-slate-50"
            >
              {e.label}
            </a>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
        <StatCard
          label="Equipos encendidos"
          value={summary ? `${summary.endpoints.online}/${summary.endpoints.total}` : '—'}
          color="blue"
          icon={<MonitorSmartphone className="h-5 w-5" />}
        />
        <StatCard
          label="Usuarios bloqueados"
          value={summary ? summary.users.locked.toString() : '—'}
          color={summary && summary.users.locked > 0 ? 'red' : 'emerald'}
          icon={<Lock className="h-5 w-5" />}
        />
        <StatCard
          label="Contraseñas vencen ≤ 7 días"
          value={summary ? summary.users.passwordExpiringSoon.toString() : '—'}
          color={summary && summary.users.passwordExpiringSoon > 0 ? 'amber' : 'emerald'}
          icon={<KeyRound className="h-5 w-5" />}
        />
        <StatCard
          label="Impresoras con problemas"
          value={summary ? `${summary.printers.withIssues}/${summary.printers.total}` : '—'}
          color={summary && summary.printers.withIssues > 0 ? 'amber' : 'emerald'}
          icon={<Printer className="h-5 w-5" />}
        />
        <StatCard
          label="IPs libres (DHCP / fijas)"
          value={summary ? `${summary.ips.freeDhcp} / ${summary.ips.freeStatic}` : '—'}
          color={summary && summary.ips.maxScopeUsage >= 85 ? 'red' : 'emerald'}
          icon={<Network className="h-5 w-5" />}
        />
      </div>

      <div className="rounded-xl border border-slate-200 bg-white shadow-card">
        <div className="flex gap-1 overflow-x-auto border-b border-slate-200 px-3">
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            const active = section === s.id;
            return (
              <button
                key={s.id}
                onClick={() => setSection(s.id)}
                className={`relative flex shrink-0 items-center gap-1.5 px-3 py-3 text-xs font-medium transition-colors ${
                  active ? 'text-brand-700' : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {s.label}
                {active && <motion.span layoutId="inventory-tab" className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-brand-600" />}
              </button>
            );
          })}
        </div>
        <div className="p-4">
          <AnimatePresence mode="wait">
            <motion.div key={section} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
              {section === 'equipos' && <EndpointsView />}
              {section === 'usuarios' && <UsersView />}
              {section === 'impresoras' && <PrintersView />}
              {section === 'ips' && <IpMapView />}
              {section === 'seguridad' && <NetGuardView isAdmin={isAdmin} canWrite={canWrite} />}
              {section === 'auditoria' && <AuditView />}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
