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
      className="flex items-center gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-card transition-shadow hover:shadow-card-hover"
    >
      <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${ICON_BG[color]}`}>{icon}</div>
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</p>
        <p className={`mt-0.5 text-2xl font-semibold ${VALUE_COLOR[color]}`}>{value}</p>
      </div>
    </motion.div>
  );
}
