'use client';

import { motion } from 'framer-motion';
import {
  LineChart,
  MonitorCheck,
  Network,
  Map as MapIcon,
  DatabaseBackup,
  ScrollText,
  ShieldHalf,
  Moon,
  ShieldCheck,
  Wifi,
  Boxes,
  AppWindow,
  type LucideIcon,
} from 'lucide-react';
import type { TabId } from '../types';

const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: 'general', label: 'General', icon: LineChart },
  { id: 'monitoreo', label: 'Monitoreo', icon: MonitorCheck },
  { id: 'red', label: 'Red e Internet', icon: Wifi },
  { id: 'aplicaciones', label: 'Aplicaciones', icon: AppWindow },
  { id: 'inventario', label: 'Inventario', icon: Boxes },
  { id: 'topologia', label: 'Topología', icon: Network },
  { id: 'mapa', label: 'Mapa', icon: MapIcon },
  { id: 'backups', label: 'Backups', icon: DatabaseBackup },
  { id: 'logs', label: 'Logs Regex', icon: ScrollText },
  { id: 'fortinet', label: 'Fortinet', icon: ShieldHalf },
  { id: 'guardia', label: 'Guardia', icon: Moon },
];

const ADMIN_TAB: { id: TabId; label: string; icon: LucideIcon } = { id: 'admin', label: 'Admin', icon: ShieldCheck };

export default function TabNav({
  active,
  onChange,
  showAdmin,
}: {
  active: TabId;
  onChange: (tab: TabId) => void;
  showAdmin: boolean;
}) {
  const tabs = showAdmin ? [...TABS, ADMIN_TAB] : TABS;

  return (
    <nav className="no-scrollbar flex gap-1 overflow-x-auto border-b border-slate-200 bg-white px-3 py-2 sm:flex-wrap sm:overflow-visible sm:px-6">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const isActive = active === tab.id;
        return (
          <button
            key={tab.id}
            onClick={(e) => {
              onChange(tab.id);
              // En celular la fila se desliza: centrar la pestaña elegida.
              e.currentTarget.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
            }}
            className={`relative flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors duration-150 sm:gap-2 sm:px-4 sm:py-2 sm:text-sm ${
              isActive ? 'text-white' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'
            }`}
          >
            {isActive && (
              <motion.span
                layoutId="tab-nav-active"
                className="absolute inset-0 rounded-lg bg-brand-600 shadow-sm"
                transition={{ type: 'spring', bounce: 0.2, duration: 0.5 }}
              />
            )}
            <Icon className="relative z-10 h-4 w-4" />
            <span className="relative z-10">{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
