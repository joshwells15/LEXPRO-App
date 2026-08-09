// LEXPRO self-destructing service worker.
// Replaces the old cache-first worker: on activation it deletes every cache
// and unregisters itself. Any phone that loads the app once is permanently
// freed from stale-cache purgatory. Never re-add caching without versioned
// cache-busting.
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(c => c.navigate(c.url));
  })());
});
