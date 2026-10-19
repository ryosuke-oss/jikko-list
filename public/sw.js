// Keeps the app's own files on this device, so the app opens without a connection.
// Only requests to this site are handled: requests to any other host are never touched,
// and the connection test page always goes to the network.
// VERSION and FILES are written by `npm run stamp`; tests/sw.test.js checks they are up to date,
// so a changed file always comes with a new version (the new version replaces the old box).

const VERSION = 'v1.3-cac2c301';
const CACHE = 'jikko-list-' + VERSION;
const FILES = [
  '/app-icon.svg',
  '/apple-touch-icon.png',
  '/css/style.css',
  '/icons/alert-circle.svg',
  '/icons/archive.svg',
  '/icons/arrow-back-up.svg',
  '/icons/arrow-right.svg',
  '/icons/bolt.svg',
  '/icons/book.svg',
  '/icons/brain.svg',
  '/icons/brand-slack.svg',
  '/icons/building-store.svg',
  '/icons/building.svg',
  '/icons/calendar.svg',
  '/icons/cash.svg',
  '/icons/check.svg',
  '/icons/chevron-down.svg',
  '/icons/chevron-right.svg',
  '/icons/clipboard-text.svg',
  '/icons/clock.svg',
  '/icons/copy.svg',
  '/icons/crown.svg',
  '/icons/device-laptop.svg',
  '/icons/device-mobile.svg',
  '/icons/download.svg',
  '/icons/egg.svg',
  '/icons/external-link.svg',
  '/icons/eye-check.svg',
  '/icons/file-text.svg',
  '/icons/filter.svg',
  '/icons/grip-vertical.svg',
  '/icons/history.svg',
  '/icons/hourglass.svg',
  '/icons/id-badge-2.svg',
  '/icons/inbox.svg',
  '/icons/link.svg',
  '/icons/list-check.svg',
  '/icons/notes.svg',
  '/icons/pencil.svg',
  '/icons/plus.svg',
  '/icons/robot.svg',
  '/icons/scale.svg',
  '/icons/school.svg',
  '/icons/send.svg',
  '/icons/settings.svg',
  '/icons/speakerphone.svg',
  '/icons/star.svg',
  '/icons/sun.svg',
  '/icons/target.svg',
  '/icons/trash.svg',
  '/icons/upload.svg',
  '/icons/user.svg',
  '/icons/users-group.svg',
  '/icons/world.svg',
  '/icons/x.svg',
  '/',
  '/js/app.js',
  '/js/dom.js',
  '/js/dragon.js',
  '/js/parse.js',
  '/js/plan.js',
  '/js/store.js',
  '/js/tasks.js',
  '/js/ui.js',
  '/js/util.js',
  '/manifest.webmanifest',
  '/vendor/Sortable.min.js',
];

self.addEventListener('install', (event) => {
  // cache: 'reload' skips the browser's own cache, so the box gets the files of this version.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES.map((url) => new Request(url, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('jikko-list-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function networkOnly(url) {
  return url.origin !== self.location.origin ||
    url.pathname.startsWith('/connect-test') ||
    url.pathname.startsWith('/js/connect-test') ||
    url.pathname.startsWith('/css/connect-test');
}

const MATCH = { ignoreSearch: true, ignoreVary: true };

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (networkOnly(url)) return;
  event.respondWith((async () => {
    let cache = null;
    try {
      cache = await caches.open(CACHE);
      const hit = await cache.match(req, MATCH);
      if (hit) return hit;
    } catch (e) {
      // the box cannot be read: the network still works
    }
    try {
      return await fetch(req);
    } catch (e) {
      // no connection: a page of this site opens the app itself
      if (req.mode === 'navigate' && cache) {
        const app = await cache.match('/', MATCH).catch(() => null);
        if (app) return app;
      }
      throw e;
    }
  })());
});

self.addEventListener('message', (event) => {
  const m = event.data || {};
  if (m.type === 'skip-waiting') self.skipWaiting();
  if (m.type === 'version' && event.ports && event.ports[0]) event.ports[0].postMessage({ version: VERSION });
});
