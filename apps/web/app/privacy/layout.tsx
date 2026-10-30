import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: { absolute: 'Політика конфіденційності — LANKA' },
  description: 'Як LANKA обробляє й захищає персональні дані.',
  alternates: { canonical: '/privacy' },
};

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
