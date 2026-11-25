'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

// Push on THIS device (2026-11-25). The rules:
// - it is switched on only inside the INSTALLED app launched as an app (display-mode standalone / fullscreen / minimal-ui /
//   window-controls-overlay, iOS navigator.standalone, an Android TWA). A browser tab never asks for permission: the app may well be installed
//   next to it, the tab only cannot tell, so it says "open LANKA as the app", never "not installed". A service worker, a stored subscription or
//   a granted permission prove nothing about installation.
// - permission is asked ONLY from the person's click on "switch on"; never on sign-in, page load or an update.
// - "on" means: permission granted AND a subscription on this device AND the server holds it for this person. Permission alone is not "on".
// - switching off is "off" only after the server confirmed it stopped sending here.
// Apple: Web Push works for Home Screen web apps on iOS/iPadOS 16.4+, permission only after a user gesture (webkit.org/blog/13878);
// detection by display-mode (web.dev/learn/pwa/detection).
export type PushState = 'loading' | 'server_off' | 'browser' | 'unsupported' | 'off' | 'denied' | 'granted_no_server' | 'on' | 'error';
export type Platform = 'ios' | 'android' | 'desktop_chromium' | 'desktop_safari' | 'desktop_firefox' | 'other';

const MARK = 'lanka_push_user';
const store = {
  get: () => {
    try {
      return localStorage.getItem(MARK);
    } catch {
      return null;
    }
  },
  set: (v: string | null) => {
    try {
      if (v) localStorage.setItem(MARK, v);
      else localStorage.removeItem(MARK);
    } catch {
      /* storage blocked: only the silent renewal is lost */
    }
  },
};

export function platform(): Platform {
  if (typeof navigator === 'undefined') return 'other';
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Firefox\//.test(ua)) return 'desktop_firefox';
  if (/Chrome|Chromium|Edg\//.test(ua)) return 'desktop_chromium';
  if (/Safari\//.test(ua)) return 'desktop_safari';
  return 'other';
}
// iOS/iPadOS version (null when not iOS or unknown)
export function iosVersion(): number | null {
  const m = /OS (\d+)_(\d+)/.exec(typeof navigator === 'undefined' ? '' : navigator.userAgent);
  return m ? Number(m[1]) + Number(m[2]) / 100 : null;
}
export function launchedAsApp(): boolean {
  if (typeof window === 'undefined') return false;
  const modes = ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay'];
  return modes.some((m) => window.matchMedia?.(`(display-mode: ${m})`).matches) || (navigator as { standalone?: boolean }).standalone === true || document.referrer.startsWith('android-app://');
}
const pushApis = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

const toKey = (b64: string) => {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
};
interface Device { available: boolean; publicKey: string | null; device: 'mine' | 'other' | 'none'; userKey: string; holderKey?: string }

async function registration() {
  return (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register('/sw.js', { scope: '/' }));
}
async function currentSub() {
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}
const keysOf = (s: PushSubscription) => s.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };

// ---------- the device's Push owner (shared with the service worker) ----------
// A small record in the Cache API (the one storage both the page and the service worker can read): owner = the opaque key of the person whose
// notifications this device may show (null after a sign-out), pending = subscriptions whose server removal still has to be sent, each with the
// key of the person it belonged to (the server removes it only while it still belongs to them, so a newer subscription is never touched). The
// owner is written only here, from the server's confirmation; never from an incoming notification.
const STATE_CACHE = 'lanka-push-state';
const STATE_URL = '/__lanka-push-state';
interface Pending { endpoint: string; u: string }
interface DeviceRecord { owner: string | null; pending: Pending[] }
const validPending = (x: unknown): x is Pending => !!x && typeof (x as Pending).endpoint === 'string' && typeof (x as Pending).u === 'string';
async function readRecord(): Promise<DeviceRecord | null> {
  try {
    const r = await (await caches.open(STATE_CACHE)).match(STATE_URL);
    if (!r) return null;
    const v = (await r.json()) as Partial<DeviceRecord>;
    if (!v || (v.owner !== null && typeof v.owner !== 'string') || !Array.isArray(v.pending)) return null;
    return { owner: v.owner, pending: v.pending.filter(validPending) };
  } catch {
    return null;
  }
}
async function writeRecord(rec: DeviceRecord) {
  try {
    await (await caches.open(STATE_CACHE)).put(STATE_URL, new Response(JSON.stringify(rec), { headers: { 'Content-Type': 'application/json' } }));
  } catch {
    /* no Cache API: the browser subscription is still removed */
  }
}
// add: a subscription to remove later (with whose it was); keep: the subscription the new owner uses now: a queued removal of the SAME person
// for it is dropped (they switched it on again), others stay (the server ignores them for a row that is no longer theirs)
async function setOwner(owner: string | null, o: { add?: Pending; keep?: string } = {}) {
  const cur = (await readRecord()) ?? { owner: null, pending: [] };
  let pending = cur.pending.filter((p) => !(o.keep && p.endpoint === o.keep && p.u === owner));
  if (o.add && !pending.some((p) => p.endpoint === o.add!.endpoint && p.u === o.add!.u)) pending = [...pending, o.add];
  await writeRecord({ owner, pending });
}
// Sends the removals that could not be sent before (no session needed: the endpoint proves the device). Called at every app start and when the
// network comes back; never throws.
export async function flushPendingRelease() {
  const rec = await readRecord();
  if (!rec?.pending.length) return;
  const done: Pending[] = [];
  for (const p of rec.pending) {
    const ok = await fetch('/backend/push/release', { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) })
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) done.push(p);
  }
  const now = (await readRecord()) ?? rec;
  await writeRecord({ owner: now.owner, pending: now.pending.filter((p) => !done.some((d) => d.endpoint === p.endpoint && d.u === p.u)) });
}

// Called at sign-out, BEFORE the session ends. In this order, each step independent of the others:
// 1. the device stops showing this person's notifications at once (owner = none), and the ones already on screen are closed;
// 2. the server row is removed with the session; if that fails (offline, server down), the removal is queued and sent later without a session;
// 3. the browser subscription is cancelled (then the push service stops delivering here at all).
export async function releasePushOnSignOut() {
  // whose subscription this is: the confirmed owner of the device (or the person who switched it on here)
  const leaving = (await readRecord())?.owner ?? store.get();
  store.set(null);
  if (!pushApis()) return void (await setOwner(null));
  let sub: PushSubscription | null = null;
  try {
    sub = await currentSub();
  } catch {
    sub = null;
  }
  await setOwner(null);
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    for (const n of (await reg?.getNotifications()) ?? []) n.close();
  } catch {
    /* nothing shown or not supported */
  }
  if (!sub) return;
  const removed = await api<{ device: string }>('/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) })
    .then((d) => d.device !== 'mine')
    .catch(() => false);
  if (!removed && leaving) await setOwner(null, { add: { endpoint: sub.endpoint, u: leaving } });
  await sub.unsubscribe().catch(() => undefined);
}

export function usePushDevice(lang: string) {
  const [state, setState] = useState<PushState>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [srv, setSrv] = useState<Device | null>(null);
  // a subscription is in the browser but the device cannot confirm whose it is (e.g. switched on before the update): switch it on again
  const [reconfirm, setReconfirm] = useState(false);

  // Reads the real state of this device; repairs what it may without asking anything: a subscription of another person is dropped here, a
  // revoked permission stops the server, a subscription renewed by the browser is re-registered for the person who switched it on
  const check = useCallback(async () => {
    setError('');
    try {
      const base = await api<Device>('/push/device', { method: 'POST', body: '{}' });
      setSrv(base);
      if (!base.available || !base.publicKey) return setState('server_off');
      if (!launchedAsApp()) return setState('browser');
      const ios = iosVersion();
      if (!pushApis() || (platform() === 'ios' && ios !== null && ios < 16.4)) return setState('unsupported');
      let sub = await currentSub();
      const d = sub ? await api<Device>('/push/device', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) }) : base;
      if (sub && d.device === 'other') {
        // another person's subscription left on this device: never shown here (owner none), removed on the server without their session, and
        // cancelled in the browser; nothing of it is carried over to the person signed in now
        await setOwner(null, d.holderKey ? { add: { endpoint: sub.endpoint, u: d.holderKey } } : {});
        void flushPendingRelease();
        await sub.unsubscribe().catch(() => undefined);
        store.set(null);
        sub = null;
      }
      const perm = Notification.permission;
      if (perm !== 'granted') {
        if (sub && d.device === 'mine') {
          await api('/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => undefined);
          await sub.unsubscribe().catch(() => undefined);
          store.set(null);
        }
        return setState(perm === 'denied' ? 'denied' : 'off');
      }
      // the server confirms this subscription is the signed-in person's: the device owner is (re)written from that confirmation
      if (sub && d.device === 'mine') {
        await setOwner(base.userKey, { keep: sub.endpoint });
        setReconfirm(false);
        return setState('on');
      }
      // a subscription the server does not know: re-registered silently only for the person this device remembers switching it on, and only if it
      // is not queued for removal; otherwise the person is asked to switch it on again (an older device after the update lands here)
      const queued = !!sub && !!(await readRecord())?.pending.some((p) => p.endpoint === sub!.endpoint);
      if (sub && !queued && store.get() === base.userKey) {
        await api('/push/subscribe', { method: 'POST', body: JSON.stringify({ ...keysOf(sub), lang }) });
        await setOwner(base.userKey, { keep: sub.endpoint });
        setReconfirm(false);
        return setState('on');
      }
      setReconfirm(!!sub);
      return setState('granted_no_server');
    } catch (e) {
      setError((e as Error).message);
      setState('error');
    }
  }, [lang]);

  useEffect(() => {
    void check();
    // coming back to the app (after changing the permission in the settings of the device)
    const again = () => document.visibilityState === 'visible' && void check();
    document.addEventListener('visibilitychange', again);
    return () => document.removeEventListener('visibilitychange', again);
  }, [check]);

  // only from the person's click
  const enable = async () => {
    if (!srv?.publicKey) return;
    setBusy(true);
    setError('');
    setNote('');
    try {
      const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
      if (perm !== 'granted') {
        setState(perm === 'denied' ? 'denied' : 'off');
        return;
      }
      const reg = await registration();
      await navigator.serviceWorker.ready;
      // a subscription queued for removal (someone's offline sign-out) is not reused: a fresh one is made
      let existing = await reg.pushManager.getSubscription();
      if (existing && (await readRecord())?.pending.some((p) => p.endpoint === existing!.endpoint)) {
        await existing.unsubscribe().catch(() => undefined);
        existing = null;
      }
      const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(srv.publicKey) }));
      const d = await api<Device>('/push/subscribe', { method: 'POST', body: JSON.stringify({ ...keysOf(sub), lang }) });
      if (d.device !== 'mine') throw new Error('not saved');
      store.set(d.userKey);
      await setOwner(d.userKey, { keep: sub.endpoint });
      setReconfirm(false);
      setState('on');
    } catch (e) {
      setError((e as Error).message);
      setState('error');
    } finally {
      setBusy(false);
    }
  };

  // "off" only after the server confirmed it no longer holds this device for the person
  const disable = async () => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      const sub = await currentSub();
      if (sub) {
        const d = await api<Device>('/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) });
        if (d.device === 'mine') throw new Error('still on');
        await setOwner(null);
        const gone = await sub.unsubscribe().catch(() => false);
        if (!gone) setNote('browser_kept');
      }
      store.set(null);
      setState('off');
      setNote((n) => n || 'off_ok');
    } catch (e) {
      // the server may still be sending here: the state stays "on", with a retry
      setError((e as Error).message);
      setNote('off_failed');
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setError('');
    setNote('');
    const sub = await currentSub();
    if (!sub) return void (await check());
    try {
      const r = await api<{ sent: number }>('/push/test', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) });
      // accepted by the push service, or not (the subscription may be gone: the next check shows it)
      setNote(r.sent ? 'test_sent' : 'test_failed');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return { state, busy, error, note, reconfirm, enable, disable, test, retry: check, platform: platform() };
}
