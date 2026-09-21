const BORDER_COLORS: Record<string, string> = {
  emerald: 'border-emerald-500/60',
  blue: 'border-blue-500/60',
  red: 'border-red-500/60',
  amber: 'border-amber-500/60',
};

const ICON_BG: Record<string, string> = {
  emerald: 'bg-emerald-500/10 text-emerald-400',
  blue: 'bg-blue-500/10 text-blue-400',
  red: 'bg-red-500/10 text-red-400',
  amber: 'bg-amber-500/10 text-amber-400',
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
    <div
      className={`flex items-center gap-4 rounded-xl border-l-4 bg-gray-900/50 p-4 transition-transform hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/30 ${BORDER_COLORS[color]}`}
    >
      <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-lg text-xl ${ICON_BG[color]}`}>
        {icon}
      </div>
      <div>
        <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
        <p className="mt-1 text-2xl font-semibold text-gray-100">{value}</p>
      </div>
    </div>
  );
}
