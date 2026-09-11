const CACHE_VERSION = 'v4';
const CORE_CACHE = `dangwu-${CACHE_VERSION}-core`;
const ASSET_CACHE = `dangwu-${CACHE_VERSION}-assets`;
const GEOCODE_CACHE = `dangwu-${CACHE_VERSION}-geocode`;
const GEOCODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const GEOCODE_MAX = 100;

const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './src/styles.css',
  './src/main.js',
  './src/core/solar.js',
  './src/globe/Globe.js',
  './src/store/storage.js',
  './src/ui/clock.js',
  './src/ui/search.js',
  './src/ui/favorites.js',
  './src/ui/detail.js',
  './src/ui/presentation.js',
  './src/ui/about.js',
  './src/data/cities.json',
  './src/data/cities.meta.json',
  './vendor/three/three.module.js',
  './vendor/three/addons/controls/OrbitControls.js',
  './assets/earth_day_4096.jpg',
  './assets/earth_night_4096.jpg',
  // 8K 贴图（约 7.6MB）体积过大，不进安装预缓存；首次在线访问时
  // 由下方 fetch 处理器运行时缓存进 ASSET_CACHE，离线后仍可用。
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CORE_CACHE)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith('dangwu-') && ![CORE_CACHE, ASSET_CACHE, GEOCODE_CACHE].includes(key))
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

async function trimGeocodeCache(cache) {
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - GEOCODE_MAX)).map((key) => cache.delete(key)));
}

async function geocodeResponse(req) {
  const cache = await caches.open(GEOCODE_CACHE);
  const cached = await cache.match(req);
  if (cached) {
    const age = Date.now() - Number(cached.headers.get('X-Dangwu-Cached-At') || 0);
    if (age <= GEOCODE_TTL_MS) return cached;
    await cache.delete(req);
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(req, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok || !(response.headers.get('content-type') || '').includes('json')) return response;
    const headers = new Headers(response.headers);
    headers.set('X-Dangwu-Cached-At', String(Date.now()));
    const stored = new Response(await response.clone().blob(), { status: response.status, statusText: response.statusText, headers });
    await cache.put(req, stored.clone());
    await trimGeocodeCache(cache);
    return stored;
  } catch (error) {
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin !== self.location.origin) {
    if (url.origin === 'https://nominatim.openstreetmap.org' && url.pathname === '/search') {
      event.respondWith(geocodeResponse(req));
    }
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then(async (res) => {
      if (res.ok) await (await caches.open(CORE_CACHE)).put(req, res.clone());
      return res;
    }).catch(() => caches.match('./index.html'))));
    return;
  }

  // HTML/JS/CSS/JSON：网络优先、离线回退缓存——保证代码更新即时生效；
  // 图片等大体积静态资源：缓存优先——8K 贴图重复下载代价过高。
  const IMAGE_RE = /\.(png|jpe?g|webp|ico|svg)$/i;
  const cacheFirst = IMAGE_RE.test(url.pathname);
  event.respondWith((async () => {
    const cached = await caches.match(req);
    if (cacheFirst && cached) return cached;
    try {
      const res = await fetch(req);
      if (res.ok) await (await caches.open(ASSET_CACHE)).put(req, res.clone());
      return res;
    } catch (error) {
      if (cached) return cached;
      throw error;
    }
  })());
});
