// LANKA service worker. One job: the app opens as installed and shows a clear page when there is no network.
// Patient data is never cached: API requests (/backend/*) and pages with data always go to the network.
// Only the shell (the "no connection" page, icons) and the immutable build files /_next/static/ are cached.
const VERSION = 'lanka-v4';
const SHELL = ['/offline.html', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
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

// Push notifications for staff (a new request from a chat). The text carries no patient data: only the kind of event.
self.addEventListener('push', (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch (e) {
    d = {};
  }
  event.waitUntil(
    self.registration.showNotification(d.title || 'LANKA', {
      body: d.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: d.tag,
      data: { url: d.url || '/inbox' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/inbox';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          c.navigate(url);
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
