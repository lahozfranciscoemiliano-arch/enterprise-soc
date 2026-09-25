import type { TabId } from '../types';

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: 'general', label: 'General', icon: '📈' },
  { id: 'monitoreo', label: 'Monitoreo', icon: '🖥️' },
  { id: 'topologia', label: 'Topología', icon: '🕸️' },
  { id: 'mapa', label: 'Mapa', icon: '🗺️' },
  { id: 'logs', label: 'Logs Regex', icon: '⌥' },
  { id: 'fortinet', label: 'Fortinet', icon: '🧱' },
  { id: 'guardia', label: 'Guardia', icon: '🌙' },
];

const ADMIN_TAB: { id: TabId; label: string; icon: string } = { id: 'admin', label: 'Admin', icon: '🛡️' };

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
    <nav className="flex flex-wrap gap-1 border-b border-gray-800 bg-gray-900/40 px-6 py-2">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-all duration-150 ${
            active === tab.id
              ? 'bg-blue-600 text-white shadow shadow-blue-900/40'
              : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
          }`}
        >
          <span>{tab.icon}</span>
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
