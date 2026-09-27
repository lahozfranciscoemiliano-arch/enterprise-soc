'use client';

import { motion } from 'framer-motion';

const ICON_BG: Record<string, string> = {
  emerald: 'bg-emerald-50 text-emerald-600',
  blue: 'bg-blue-50 text-blue-600',
  red: 'bg-red-50 text-red-600',
  amber: 'bg-amber-50 text-amber-600',
};

const VALUE_COLOR: Record<string, string> = {
  emerald: 'text-emerald-700',
  blue: 'text-slate-900',
  red: 'text-red-700',
  amber: 'text-amber-700',
};

export default function StatCard({
  label,
  value,
  color = 'blue',
  icon,
}: {
  label: string;
  value: string;
  color?: 'emerald' | 'blue' | 'red' | 'amber';
  icon: React.ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -2 }}
      transition={{ duration: 0.25 }}
      className="flex min-w-0 items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-card transition-shadow hover:shadow-card-hover sm:gap-4 sm:p-4"
    >
      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg sm:h-11 sm:w-11 [&>svg]:h-4 [&>svg]:w-4 sm:[&>svg]:h-5 sm:[&>svg]:w-5 ${ICON_BG[color]}`}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-[10px] font-medium uppercase leading-tight tracking-wide text-slate-400 sm:text-xs">{label}</p>
        <p className={`mt-0.5 truncate text-lg font-semibold leading-tight sm:text-2xl ${VALUE_COLOR[color]}`}>{value}</p>
      </div>
    </motion.div>
  );
}
