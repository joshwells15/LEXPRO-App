const CACHE_NAME = 'lexpro-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/home.html',
  '/outreach.html',
  '/contact.html',
  '/transactions.html',
  '/transaction-list.html',
  '/transaction.html',
  '/notifications.html',
  '/calendar.html'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.url.includes('api.anthropic.com') ||
      event.request.url.includes('supabase.co') ||
      event.request.url.includes('leadconnectorhq.com')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      return cached || fetch(event.request).catch(() => caches.match('/index.html'));
    })
  );
});
