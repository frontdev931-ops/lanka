'use client';

import { useEffect } from 'react';

// Registers the service worker. It is not enabled in development so that caching does not get in the way of debugging.
export function PwaRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  }, []);
  return null;
}
