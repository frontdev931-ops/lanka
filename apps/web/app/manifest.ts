import type { MetadataRoute } from 'next';

// App manifest: the phone offers "Install" and opens LANKA in its own window like a regular app.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'LANKA — кабінет клініки',
    short_name: 'LANKA',
    description: 'Звіти, переписка з пацієнтами та автоматизації для стоматологічної клініки',
    start_url: '/dashboard',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#f3f6f7',
    theme_color: '#0d8075',
    lang: 'uk',
    categories: ['business', 'medical', 'productivity'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Листування', url: '/inbox', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
      { name: 'Звіти', url: '/reports', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
      { name: 'Пацієнти', url: '/patients', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
    ],
  };
}
