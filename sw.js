// Offline worker. Bump SHELL on every release (match APP_VERSION in app.js);
// that is what makes phones pick up new files. The tile cache is kept across
// releases so runners don't have to download the map again.
const SHELL = 'shell-v15';
const TILES = 'tiles-v2';
const CORE = [
  './', 'index.html', 'app.js', 'manifest.json', 'icon-192.png', 'icon-512.png',
  'icon-maskable-192.png', 'icon-maskable-512.png', 'apple-touch-icon.png',
  'vendor/leaflet.js', 'vendor/leaflet.css', 'tiles-turaco26/index.json', 'tiles-harare/index.json', 'data/races/index.json',
  // Medical guide (made by tools/build-medical.mjs); keep in step with data/medical/.
  'data/medical.html', 'data/medical/image1.webp', 'data/medical/image2.webp', 'data/medical/image3.webp',
  'data/medical/image4.webp', 'data/medical/image5.webp', 'data/medical/image6.webp', 'data/medical/image7.webp',
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(SHELL).then(async cache => {
    const save = async url => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res.ok) await cache.put(url, res);
        else console.warn('[sw] skipped', url, res.status);
      } catch (err) { console.warn('[sw] skipped', url, err.message); }
    };
    await Promise.all(CORE.map(save));
    // Every race route in the race list, so any race can be chosen offline.
    try {
      const list = await (await cache.match('data/races/index.json')).json();
      await Promise.all(list.map(r => save(r.file)));
    } catch (err) { console.warn('[sw] race routes not saved', err.message); }
  }));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== TILES).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // The organisers' dashboard pages are separate from the runner app: always from the internet.
  if (/\/dashboard/.test(new URL(req.url).pathname)) return;

  // Map tiles: from the phone first; fetch and keep any that are missing.
  if (/\/tiles[\w-]*\//.test(req.url) && req.url.endsWith('.webp')) {
    e.respondWith((async () => {
      const cache = await caches.open(TILES);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch { return new Response('', { status: 504 }); }
    })());
    return;
  }

  // App files: always from the phone, so a weak signal can never stall startup.
  e.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const hit = req.mode === 'navigate'
      ? (await cache.match('index.html')) || (await cache.match('./'))
      : await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch {
      return new Response('Offline. Open the app once with internet first.', { status: 503 });
    }
  })());
});
