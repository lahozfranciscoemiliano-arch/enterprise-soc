import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'SOC / NOC Central - Grupo Bistro',
  description: 'Panel de monitoreo NOC/SOC en tiempo real de Grupo Bistro',
  icons: { icon: '/logo-bistro.png' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className="dark">
      <body className="bg-gray-950 text-gray-100 antialiased">{children}</body>
    </html>
  );
}
