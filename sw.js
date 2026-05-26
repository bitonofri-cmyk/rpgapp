// ── Saga Service Worker ───────────────────────────────────────────────────────
// 1) Offline support: caches the app shell so Saga opens with no connection.
// 2) Background notifications: fires daily reminders even when the tab is closed.
//
// Bump CACHE_VERSION whenever index.html changes so users get the new build.
const CACHE_VERSION = 'saga-v2';
const SHELL_CACHE   = `${CACHE_VERSION}-shell`;
const NOTIF_CACHE   = 'saga-notif';      // notifications config (kept across versions)
const NOTIF_KEY     = 'notif-config';

// Files that make up the offline "app shell". Same-origin only.
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-96.png',
  './icon-192.png',
  './icon-512.png',
];

// ── Install: pre-cache the app shell ──────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_ASSETS).catch(() => {/* tolerate a missing asset */}))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: clean up old shell caches (but keep notif config) ───────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== SHELL_CACHE && k !== NOTIF_CACHE && k.startsWith('saga-'))
          .map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

// ── Fetch: serve the app offline ──────────────────────────────────────────────
// Strategy:
//  • Navigations / the HTML doc → network-first, fall back to cached index.html.
//    (Network-first means an updated build is fetched when online, so users are
//     never trapped on stale code — the cache is only a safety net for offline.)
//  • Same-origin static assets (icons, manifest) → cache-first.
//  • Cross-origin (fonts, Firebase CDN) → just pass through to the network.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // App document / navigations → network-first with offline fallback
  if (req.mode === 'navigate' || (sameOrigin && url.pathname.endsWith('.html'))) {
    e.respondWith(
      fetch(req)
        .then(resp => {
          const copy = resp.clone();
          caches.open(SHELL_CACHE).then(c => c.put('./index.html', copy)).catch(() => {});
          return resp;
        })
        .catch(() => caches.match('./index.html').then(r => r || caches.match('./')))
    );
    return;
  }

  // Same-origin static assets → cache-first
  if (sameOrigin) {
    e.respondWith(
      caches.match(req).then(cached => cached || fetch(req).then(resp => {
        const copy = resp.clone();
        caches.open(SHELL_CACHE).then(c => c.put(req, copy)).catch(() => {});
        return resp;
      }).catch(() => cached))
    );
    return;
  }

  // Cross-origin (Google Fonts, Firebase) → network, fall back to cache if present
  e.respondWith(fetch(req).catch(() => caches.match(req).then(r => r || new Response('', { status: 503 }))));
});

// ── Messages from the page (notification prefs + manual update) ───────────────
self.addEventListener('message', async e => {
  if (!e.data) return;

  if (e.data.type === 'SKIP_WAITING') { self.skipWaiting(); return; }

  if (e.data.type === 'SET_NOTIF') {
    const cache = await caches.open(NOTIF_CACHE);
    await cache.put(NOTIF_KEY, new Response(JSON.stringify({
      enabled:   e.data.enabled,
      time:      e.data.time,      // "HH:MM"
      lastFired: null,
    })));
    await checkAndNotify();
  }

  if (e.data.type === 'DISABLE_NOTIF') {
    const cache = await caches.open(NOTIF_CACHE);
    await cache.delete(NOTIF_KEY);
  }
});

// ── Periodic Background Sync (Chrome + installed PWA) ─────────────────────────
self.addEventListener('periodicsync', e => {
  if (e.tag === 'saga-daily-reminder') e.waitUntil(checkAndNotify());
});

// ── Notification click → focus or open the app ────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) { if ('focus' in client) return client.focus(); }
      return clients.openWindow(self.registration.scope || './');
    })
  );
});

// ── Core: check the time and fire the daily reminder ──────────────────────────
async function checkAndNotify() {
  const cache  = await caches.open(NOTIF_CACHE);
  const stored = await cache.match(NOTIF_KEY);
  if (!stored) return;

  let config;
  try { config = await stored.json(); } catch { return; }
  if (!config.enabled || !config.time) return;

  const now = new Date();
  const [hh, mm] = config.time.split(':').map(Number);
  const target = new Date(now);
  target.setHours(hh, mm, 0, 0);

  if (config.lastFired) {
    const lastDate = new Date(config.lastFired).toDateString();
    if (lastDate === now.toDateString()) return;   // already fired today
  }

  const diffMin = (now - target) / 60000;
  if (diffMin < 0 || diffMin > 30) return;          // only within 30 min of target

  const hour = now.getHours();
  const greetings = hour < 12
    ? ["Morning. Your quests won't do themselves. \u2694\uFE0F", "New day, new board. Let's go. \uD83D\uDD25"]
    : hour < 18
    ? ["Your daily quests are waiting. Don't break the streak. \uD83D\uDD25", "Mid-day check-in \u2014 how many quests done? \u2694\uFE0F"]
    : ["Evening. Finish strong \u2014 quests are still waiting. \uD83C\uDF06", "Don't sleep on your streak. Complete at least one quest. \u2694\uFE0F"];

  const body = greetings[Math.floor(Math.random() * greetings.length)];

  await self.registration.showNotification('\u2694\uFE0F Saga', {
    body,
    icon:  './icon-192.png',
    badge: './icon-96.png',
    tag:   'saga-daily',
    renotify: false,
    vibrate: [200, 100, 200],
    data: { url: self.registration.scope || './' },
  });

  config.lastFired = now.toISOString();
  await cache.put(NOTIF_KEY, new Response(JSON.stringify(config)));
}
