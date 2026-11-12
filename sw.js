// Offline worker. Bump SHELL on every release (match APP_VERSION in app.js);
// that is what makes phones pick up new files. The tile cache is kept across
// releases so runners don't have to download the map again.
const SHELL = 'shell-v21';
const TILES = 'tiles-v2';
const RC = 'rc-config';   // race control settings the app leaves here for notifications
const CORE = [
  './', 'index.html', 'app.js', 'manifest.json', 'icon-192.png', 'icon-512.png',
  'icon-maskable-192.png', 'icon-maskable-512.png', 'apple-touch-icon.png',
  'vendor/leaflet.js', 'vendor/leaflet.css', 'tiles-turaco26/index.json','data/races/index.json', 'data/indemnity.html',
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
    .then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== TILES && k !== RC).map(k => caches.delete(k))))
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

// Race control notifications. The push itself carries no text: collect the
// newest message for this runner's race (settings left by the app in RC)
// and show it. Phones must always show something for a push, so if the
// message can't be collected, a general "open the app" notice is shown.
async function rcGet(key) {
  try { const r = await (await caches.open(RC)).match(key); return r ? await r.json() : null; } catch { return null; }
}
self.addEventListener('push', e => {
  e.waitUntil((async () => {
    let title = 'Message from race control', body = 'Open SkyRunZim to read it.';
    try {
      const cfg = await rcGet('config');
      const res = await fetch(`${cfg.url}/rest/v1/rpc/get_messages`, {
        method: 'POST', headers: { apikey: cfg.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_race: cfg.race || '' }),
      });
      const list = await res.json();                       // newest first
      const seen = (await rcGet('seen')) || 0;             // newest message already notified
      const fresh = list.filter(m => m.id > seen);
      if (fresh.length) {
        body = fresh[0].body;
        if (fresh.length > 1) title = `${fresh.length} messages from race control`;
        await (await caches.open(RC)).put('seen', new Response(JSON.stringify(fresh[0].id)));
      }
    } catch (err) { console.warn('[sw] message not collected', err && err.message); }
    await self.registration.showNotification(title, { body, icon: 'icon-192.png', tag: 'race-control', renotify: true });
  })());
});
// Tapping the notification opens the app (or brings it forward) on the message.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const app = wins.find(c => !/\/dashboard/.test(new URL(c.url).pathname));
    if (app) { await app.focus(); app.postMessage('check-messages'); }
    else await self.clients.openWindow('./');
  })());
});
