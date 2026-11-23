import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import './globals.css';
import { I18nProvider } from '../lib/i18n';
import { PwaRegister } from '../components/PwaRegister';
import { SITE_URL } from '../lib/site';
import { display, text } from '../lib/fonts';

// The workspace theme (light by default, dark on the person's choice, see components/ThemeSwitch.tsx): set before the first paint so a dark page does
// not flash light. Only the workspace follows it; the landing (/, /ru, /en) and the public pages keep their own look.
const THEME_BOOT = `try{var p=location.pathname;if(!/^\\/(ru|en)?$/.test(p)&&!/^\\/(terms|privacy|data-deletion)/.test(p)&&localStorage.getItem('lanka_theme')==='dark')document.documentElement.dataset.theme='dark'}catch(e){}`;

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
  themeColor: '#0e7c66',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Set by middleware.ts from the address: /ru and /en are server-rendered in their own language
  const lang = (await headers()).get('x-lang') ?? 'uk';
  return (
    <html lang={lang} className={`${display.variable} ${text.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>
        <I18nProvider>{children}</I18nProvider>
        <PwaRegister />
      </body>
    </html>
  );
}
