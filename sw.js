// ── Saga Service Worker ───────────────────────────────────────────────────────
// Handles background notifications even when the browser tab is closed.
// Works best when the app is installed as a PWA (Add to Home Screen).

const CACHE_NAME = 'saga-sw-v1';
const NOTIF_KEY  = 'notif-config';

// ── Install & Activate ────────────────────────────────────────────────────────
self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e  => e.waitUntil(clients.claim()));

// ── Messages from the main page ───────────────────────────────────────────────
// The page sends SET_NOTIF whenever the user saves a notification preference.
self.addEventListener('message', async e => {
  if (!e.data) return;

  if (e.data.type === 'SET_NOTIF') {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(NOTIF_KEY, new Response(JSON.stringify({
      enabled:  e.data.enabled,
      time:     e.data.time,      // "HH:MM"
      lastFired: null,
    })));
    // Immediately attempt a check in case it's already time
    await checkAndNotify();
  }

  if (e.data.type === 'DISABLE_NOTIF') {
    const cache = await caches.open(CACHE_NAME);
    await cache.delete(NOTIF_KEY);
  }
});

// ── Periodic Background Sync ──────────────────────────────────────────────────
// Fires when the browser wakes the SW on a schedule (Chrome + PWA installed).
// Minimum interval is set to 1 hour; actual frequency is browser-controlled.
self.addEventListener('periodicsync', e => {
  if (e.tag === 'saga-daily-reminder') {
    e.waitUntil(checkAndNotify());
  }
});

// ── Notification click ────────────────────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Focus existing tab if open
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      // Otherwise open a new tab
      return clients.openWindow(self.location.origin + '/');
    })
  );
});

// ── Fetch passthrough ─────────────────────────────────────────────────────────
// We don't cache app resources — just pass everything through.
self.addEventListener('fetch', e => {
  e.respondWith(fetch(e.request).catch(() => new Response('', { status: 503 })));
});

// ── Core: check time and fire notification ────────────────────────────────────
async function checkAndNotify() {
  const cache  = await caches.open(CACHE_NAME);
  const stored = await cache.match(NOTIF_KEY);
  if (!stored) return;

  let config;
  try { config = await stored.json(); } catch { return; }
  if (!config.enabled || !config.time) return;

  const now  = new Date();
  const [hh, mm] = config.time.split(':').map(Number);
  const target   = new Date(now);
  target.setHours(hh, mm, 0, 0);

  // Don't fire twice on the same calendar day
  if (config.lastFired) {
    const lastDate = new Date(config.lastFired).toDateString();
    if (lastDate === now.toDateString()) return;
  }

  // Fire if we're within a 30-minute window of the target time
  const diffMin = (now - target) / 60000;
  if (diffMin < 0 || diffMin > 30) return;

  // Choose message based on time of day
  const hour = now.getHours();
  const greetings = hour < 12
    ? ["Morning. Your quests won't do themselves. ⚔️", "New day, new board. Let's go. 🔥"]
    : hour < 18
    ? ["Your daily quests are waiting. Don't break the streak. 🔥", "Mid-day check-in — how many quests done? ⚔️"]
    : ["Evening. Finish strong — quests are still waiting. 🌆", "Don't sleep on your streak. Complete at least one quest. ⚔️"];

  const body = greetings[Math.floor(Math.random() * greetings.length)];

  await self.registration.showNotification('⚔️ Saga', {
    body,
    icon:      '/icon-192.png',
    badge:     '/icon-96.png',
    tag:       'saga-daily',
    renotify:  false,
    vibrate:   [200, 100, 200],
    data:      { url: self.location.origin + '/' },
  });

  // Save last fired timestamp
  config.lastFired = now.toISOString();
  await cache.put(NOTIF_KEY, new Response(JSON.stringify(config)));
}
