'use client';

import { motion } from 'framer-motion';
import {
  LineChart,
  MonitorCheck,
  Network,
  Map as MapIcon,
  ScrollText,
  ShieldHalf,
  Moon,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import type { TabId } from '../types';

const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: 'general', label: 'General', icon: LineChart },
  { id: 'monitoreo', label: 'Monitoreo', icon: MonitorCheck },
  { id: 'topologia', label: 'Topología', icon: Network },
  { id: 'mapa', label: 'Mapa', icon: MapIcon },
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
    <nav className="flex flex-wrap gap-1 border-b border-slate-200 bg-white px-6 py-2">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const isActive = active === tab.id;
        return (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            className={`relative flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors duration-150 ${
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
