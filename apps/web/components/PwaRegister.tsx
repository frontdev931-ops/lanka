'use client';

import { useEffect } from 'react';
import { flushPendingRelease } from '../lib/push-device';

// Registers the service worker. It is not enabled in development so that caching does not get in the way of debugging.
export function PwaRegister() {
  // Push removals left by an offline sign-out are sent at every start and when the network comes back (no session needed)
  useEffect(() => {
    void flushPendingRelease();
    const again = () => void flushPendingRelease();
    window.addEventListener('online', again);
    return () => window.removeEventListener('online', again);
  }, []);
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
  }, []);
  return null;
}
