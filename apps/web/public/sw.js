// LANKA service worker. One job: the app opens as installed and shows a clear page when there is no network.
// Patient data is never cached: API requests (/backend/*) and pages with data always go to the network.
// Only the shell (the "no connection" page, icons) and the immutable build files /_next/static/ are cached.
// A new version replaces the old worker at once (skipWaiting + clients.claim); the push subscription belongs to the registration (scope '/'),
// so an update keeps it. Only the caches of the old version are dropped.
const VERSION = 'lanka-v7';
const SHELL = ['/offline.html', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      // the Push owner record (lanka-push-state) is not a cache of files: it survives an update
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== PUSH_STATE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Data and sign-in: network only, nothing is stored
  if (url.pathname.startsWith('/backend/')) return;

  // Build files with a hash in the name never change: take them from the cache, otherwise from the network and remember them
  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(VERSION).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Page navigation: always from the network (fresh data); with no connection show the "no connection" page
  if (req.mode === 'navigate') {
    // cache: 'no-store': take the page only from the network, not from the browser HTTP cache, otherwise a stale shell would open offline
    event.respondWith(fetch(req, { cache: 'no-store' }).catch(() => caches.match('/offline.html')));
  }
});

// Push notifications (2026-11-25). The server sends "<clinic> · <event>" and a short action, never patient data, money or messages; the only
// thing shown is what came. The same tag replaces an earlier notification instead of adding a second one. Nothing in the page shows notifications
// itself, so an open app never gets the same one twice.
// The device's Push owner, written ONLY by the page from the server's confirmation (lib/push-device.ts): { owner: <opaque key> | null,
// pending: [{ endpoint, u }] }. A notification is shown only when the record can be read, is well formed, names an owner, and the
// notification carries that same key. Anything else (no record, a broken one, a read error, no key, another key) shows nothing: a missing
// record is never read as "allowed", and nothing is ever taken from an incoming notification to set the owner.
const PUSH_STATE = 'lanka-push-state';
const PUSH_STATE_URL = '/__lanka-push-state';
async function pushRecord() {
  try {
    const r = await (await caches.open(PUSH_STATE)).match(PUSH_STATE_URL);
    if (!r) return null;
    const v = await r.json();
    if (!v || (v.owner !== null && typeof v.owner !== 'string') || !Array.isArray(v.pending)) return null;
    return { owner: v.owner, pending: v.pending.filter((p) => p && typeof p.endpoint === 'string' && typeof p.u === 'string') };
  } catch (e) {
    return null;
  }
}
const forOwner = (rec, d) => !!rec && typeof rec.owner === 'string' && rec.owner.length > 0 && !!d && typeof d.u === 'string' && d.u === rec.owner;
// A notification not shown here: the queued removals (made by the page, each with whose subscription it was) are sent now if the network allows.
// The browser's current subscription is NOT touched: it may already be the new person's. The server removes a queued row only while it still
// belongs to the person named, so a newer subscription on the same endpoint stays.
async function flushQueue(rec) {
  if (!rec || !rec.pending.length) return;
  const done = [];
  for (const p of rec.pending) {
    const ok = await fetch('/backend/push/release', { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: p.endpoint, u: p.u }) }).then((r) => r.ok).catch(() => false);
    if (ok) done.push(p);
  }
  if (!done.length) return;
  const now = (await pushRecord()) || rec;
  const left = now.pending.filter((p) => !done.some((x) => x.endpoint === p.endpoint && x.u === p.u));
  await (await caches.open(PUSH_STATE)).put(PUSH_STATE_URL, new Response(JSON.stringify({ owner: now.owner, pending: left }), { headers: { 'Content-Type': 'application/json' } })).catch(() => undefined);
}

const inApp = (u) => (typeof u === 'string' && u.startsWith('/') && !u.startsWith('//') && u.indexOf('\\') === -1 ? u : '/dashboard');

self.addEventListener('push', (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch (e) {
    d = {};
  }
  event.waitUntil(
    pushRecord().then((rec) => {
      // not this device's confirmed owner: its content is not shown (the platform may show its own generic notice when a push shows nothing; it
      // carries none of our data)
      if (!forOwner(rec, d)) return flushQueue(rec).catch(() => undefined);
      return self.registration.showNotification(d.title || 'LANKA', {
        body: d.body || '',
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: d.tag,
        data: { url: inApp(d.url), u: d.u },
      });
    }),
  );
});

// A tap opens the event's page (an "/open?..." link that checks the session and the clinic): in the app's window when one is open, otherwise
// a new one (the installed app opens its own window for its scope)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil(
    Promise.all([pushRecord(), self.clients.matchAll({ type: 'window', includeUncontrolled: true })]).then(async ([rec, list]) => {
      // a notification of a person who has signed out here since: it opens only the start page, never their event
      const url = forOwner(rec, data) ? inApp(data.url) : '/';
      const mine = list.filter((c) => new URL(c.url).origin === self.location.origin);
      for (const c of mine) {
        try {
          const focused = 'focus' in c ? await c.focus() : c;
          if (focused && 'navigate' in focused) {
            await focused.navigate(url);
            return;
          }
        } catch (e) {
          /* a window that cannot be navigated: try the next one, then a new window */
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});

// The browser renewed the subscription: the server moves this person's device to the new one (the session cookie identifies the person; the
// server accepts it only for a device that was already theirs). Without a key or a session nothing happens; the app re-checks at the next start.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const old = event.oldSubscription;
      const key = old && old.options && old.options.applicationServerKey;
      if (!old || !key) return;
      const sub = event.newSubscription || (await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
      const j = sub.toJSON();
      await fetch('/backend/push/renew', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ oldEndpoint: old.endpoint, endpoint: j.endpoint, keys: j.keys }) });
    })().catch(() => undefined),
  );
});
