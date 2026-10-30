import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: { absolute: 'Умови користування — LANKA' },
  description: 'Умови користування сервісом LANKA для клінік.',
  alternates: { canonical: '/terms' },
};

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
