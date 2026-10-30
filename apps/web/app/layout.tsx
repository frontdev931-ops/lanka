import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { I18nProvider } from '../lib/i18n';
import { PwaRegister } from '../components/PwaRegister';

export const metadata: Metadata = {
  title: 'LANKA — кабінет клініки',
  applicationName: 'LANKA',
  // iPhone: launch from the home screen without an address bar
  appleWebApp: { capable: true, title: 'LANKA', statusBarStyle: 'default' },
  formatDetection: { telephone: false },
};

// viewport-fit=cover: the app fills the whole screen; env(safe-area-inset-*) provides the padding for the notch and the bottom bar
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0d8075',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="uk">
      <body>
        <I18nProvider>{children}</I18nProvider>
        <PwaRegister />
      </body>
    </html>
  );
}
