import './globals.css';
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });

export const metadata: Metadata = {
  title: 'SOC / NOC Central - Grupo Bistro',
  description: 'Panel de monitoreo NOC/SOC en tiempo real de Grupo Bistro',
  icons: { icon: '/logo-bistro.png' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={inter.variable}>
      <body className="bg-slate-50 font-sans text-slate-900 antialiased">{children}</body>
    </html>
  );
}
