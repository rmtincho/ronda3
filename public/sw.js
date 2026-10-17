// Service worker mínimo: hace instalable la app y deja abrir la pantalla de entrar aunque la red tarde.
// Siempre va primero a la red (el juego necesita conexión); el caché es solo para emergencias.
const CACHE = 'ronda3-v2';
const SHELL = [
  '/play',
  '/shared/base.css',
  '/shared/common.js',
  '/shared/number.js',
  '/play/play.css',
  '/play/play.js',
  '/icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/audio/') || url.pathname.startsWith('/images/') || url.pathname === '/ws') return;

  event.respondWith(
    fetch(request).then((res) => {
      if (res.ok && SHELL.includes(url.pathname)) {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
      }
      return res;
    }).catch(async () => {
      const cached = await caches.match(request, { ignoreSearch: true });
      if (cached) return cached;
      if (request.mode === 'navigate' && url.pathname.startsWith('/play')) return caches.match('/play');
      return Response.error();
    }),
  );
});
