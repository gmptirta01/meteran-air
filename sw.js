/**
 * Service worker — membuat aplikasi bisa dipakai OFFLINE.
 *
 * - Saat install: seluruh "app shell" (HTML, JS, TF.js, ikon) disimpan ke cache.
 * - Saat fetch  : file milik aplikasi dilayani dari cache (cepat & offline), sambil
 *                 diperbarui di latar belakang bila online (stale-while-revalidate).
 * - Permintaan ke Google Apps Script (POST, beda origin) TIDAK disentuh; antrean offline
 *   untuk data pembacaan ditangani di js/app.js.
 *
 * Setiap rilis: NAIKKAN VERSION agar cache lama dibersihkan dan HP memuat versi baru.
 */
const VERSION = 'v26';
const CACHE = `meter-air-${VERSION}`;
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'js/ocr.js',
  'js/detect.js',
  'js/xlsx.js',
  'js/qr.js',
  'js/config.js',
  'js/auth.js',
  'js/cnn.js',
  'js/app.js',
  'vendor/tf.min.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
];
// Disimpan saat pertama dipakai saja (tidak diunduh saat install): pembaca QR jsQR hanya untuk HP tanpa
// BarcodeDetector (mis. iPhone); js/qr.js memuatnya di waktu luang setelah login -> scan QR tetap jalan offline.
const LAZY = ['vendor/jsQR.js'];

self.addEventListener('install', (event) => {
  // cache: 'reload' -> lewati cache HTTP browser, ambil versi terbaru dari server
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('meter-air-') && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

// Halaman meminta versi baru langsung aktif (tombol "Muat ulang" di banner pembaruan)
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;   // biarkan Apps Script dll.

  // Navigasi halaman: selalu kembalikan index.html dari cache bila offline
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const fresh = await fetch(req);
        if (fresh.ok) cache.put('index.html', fresh.clone());
        return fresh;
      } catch {
        return (await cache.match('index.html')) || (await cache.match('./'));
      }
    })());
    return;
  }

  // Aset: stale-while-revalidate
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    const network = fetch(req).then((res) => {
      if (res.ok && SHELL.concat(LAZY).some((p) => url.pathname.endsWith(p.replace('./', '/')))) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    return cached || (await network) || new Response('Offline', { status: 503 });
  })());
});
