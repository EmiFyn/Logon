/* Service worker.
 *
 * Does two jobs:
 *   - keeps the app openable with no signal at all
 *   - on Android, sends anything left in the queue even after the app is closed
 *
 * Bump CACHE whenever you change any file in the app, otherwise phones keep the
 * old copy. That is the one piece of housekeeping this file needs.
 */

const CACHE = 'whereabouts-v6';

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './config.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Never cache the API. A stale logon list is worse than no list.
  if (url.pathname.startsWith('/api/')) return;
  if (e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(e.request).then((hit) => {
      if (hit) {
        // Serve the cached copy at once, then quietly refresh it for next time.
        e.waitUntil(
          fetch(e.request)
            .then((res) => res.ok && caches.open(CACHE).then((c) => c.put(e.request, res.clone())))
            .catch(() => {}),
        );
        return hit;
      }
      return fetch(e.request).catch(() => caches.match('./index.html'));
    }),
  );
});

// ---------------------------------------------------------------- background send

const DB_NAME = 'whereabouts';

function idb() {
  return new Promise((resolve, reject) => {
    // No version number on purpose: the page owns the schema, and asking for an
    // older version than the page has already created throws.
    const r = indexedDB.open(DB_NAME);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function getAll(d, store) {
  return new Promise((resolve, reject) => {
    const req = d.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function del(d, store, key) {
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function flushOutbox() {
  const d = await idb();
  const meta = await getAll(d, 'meta');
  const auth = (meta.find((m) => m.k === 'auth') || {}).v;
  if (!auth || !auth.token || !auth.api) return;

  // Phone and vehicle corrections first: they are small, and a logon is more use to
  // the office alongside an up-to-date number than the other way round.
  if (d.objectStoreNames.contains('edits')) {
    for (const e of await getAll(d, 'edits')) {
      const res = await fetch(auth.api + '/api/operatives/' + e.id + '/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + auth.token },
        body: JSON.stringify({ phone: e.phone, vehicle_reg: e.vehicle_reg }),
      });
      if (res.ok || res.status === 403) await del(d, 'edits', e.id);
      else if (res.status >= 500 || res.status === 429) throw new Error('retry later');
    }
  }

  for (const item of await getAll(d, 'outbox')) {
    const res = await fetch(auth.api + '/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + auth.token },
      body: JSON.stringify(item),
    });
    if (res.ok) {
      await del(d, 'outbox', item.id);
    } else if (res.status >= 500 || res.status === 429) {
      // Server trouble - throwing makes the browser retry this sync later.
      throw new Error('retry later');
    }
    // A 400/401/403 means retrying will not help; leave it queued so the crew
    // sees it still waiting and can tell the office.
  }

  for (const c of await self.clients.matchAll()) c.postMessage('flush-outbox');
}

self.addEventListener('sync', (e) => {
  if (e.tag === 'flush-outbox') e.waitUntil(flushOutbox());
});

// ---------------------------------------------------------------- the chase-up

/* The push that arrives carries no words at all - only a nudge. The names of people
 * who have not logged on are fetched from the API here, which keeps them off Google's
 * and Apple's servers and means the notification shows what is true at the moment the
 * phone looks, not when it was sent.
 *
 * A notification must be shown for every push received, or the browser eventually
 * stops delivering them, so every path below ends in showNotification - including the
 * one where the phone could not reach the API. */

async function showChase() {
  const fallback = {
    title: 'Check your logon',
    body: 'Tap to open the app and check who is logged on.',
  };

  let detail = fallback;
  try {
    const d = await idb();
    const meta = await getAll(d, 'meta');
    const auth = (meta.find((m) => m.k === 'auth') || {}).v;
    if (auth && auth.token && auth.api) {
      const res = await fetch(auth.api + '/api/chase', {
        headers: { Authorization: 'Bearer ' + auth.token },
      });
      if (res.ok) {
        const c = await res.json();
        if (c.count === 0) return;          // sorted itself out between send and arrival
        detail = { title: c.title, body: c.body };
      }
    }
  } catch {
    // No signal, or the token has been revoked. The fallback still gets somebody to
    // open the app, which is the whole point.
  }

  return self.registration.showNotification(detail.title, {
    body: detail.body,
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag: 'whereabouts-chase',             // a second nudge replaces the first
    renotify: true,
    requireInteraction: false,
    data: { url: './' },
  });
}

self.addEventListener('push', (e) => {
  e.waitUntil(showChase());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes(self.registration.scope)) return c.focus();
    }
    return self.clients.openWindow((e.notification.data && e.notification.data.url) || './');
  })());
});
