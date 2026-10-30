import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import './globals.css';
import { I18nProvider } from '../lib/i18n';
import { PwaRegister } from '../components/PwaRegister';
import { SITE_URL } from '../lib/site';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
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

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Set by middleware.ts from the address: /ru and /en are server-rendered in their own language
  const lang = (await headers()).get('x-lang') ?? 'uk';
  return (
    <html lang={lang}>
      <body>
        <I18nProvider>{children}</I18nProvider>
        <PwaRegister />
      </body>
    </html>
  );
}
