import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Учёт склада', description: 'Управление складом' };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><body suppressHydrationWarning>{children}</body></html>;
}
