/* 만화뷰어 service worker: cache-first, versioned, engine precache with progress */
const CACHE_VERSION = "mhv-pwa-v15";
// Engine files that did not change since the previous version can be copied from the old cache
// (fast update, works even on a weak connection). Files listed here are always re-downloaded.
const ENGINE_CHANGED = new Set(["./vendor/ffmpeg-worker.js"]);

const APP_ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/apple-touch-icon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

const ENGINE_ASSETS = [
  "./vendor/ffmpeg-core.js",
  "./vendor/ffmpeg-core.wasm",
  "./vendor/ffmpeg-worker.js",
  "./vendor/libarchive-factory.js",
  "./vendor/libarchive.wasm",
  "./vendor/libarchive-worker.js",
];

function toAbs(path) {
  return new URL(path, self.location).href;
}

async function broadcast(data) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  for (const c of clients) {
    try { c.postMessage(data); } catch (_) {}
  }
}

async function cacheWithProgress(cache, url, info) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error("Failed to fetch " + url + " (" + res.status + ")");
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body || !total) {
    await cache.put(url, res);
    await broadcast({
      type: "precache-progress",
      url,
      file: info.file,
      index: info.index,
      files: info.files,
      loaded: total,
      total,
      bytesLoaded: info.bytesLoaded + total,
      bytesTotal: info.bytesTotal,
    });
    return total;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  let lastNotify = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    const now = Date.now();
    if (now - lastNotify > 120) {
      lastNotify = now;
      await broadcast({
        type: "precache-progress",
        url,
        file: info.file,
        index: info.index,
        files: info.files,
        loaded,
        total,
        bytesLoaded: info.bytesLoaded + loaded,
        bytesTotal: info.bytesTotal,
      });
    }
  }
  const headers = new Headers(res.headers);
  const out = new Response(new Blob(chunks), { status: res.status, statusText: res.statusText, headers });
  await cache.put(url, out);
  await broadcast({
    type: "precache-progress",
    url,
    file: info.file,
    index: info.index,
    files: info.files,
    loaded,
    total,
    bytesLoaded: info.bytesLoaded + loaded,
    bytesTotal: info.bytesTotal,
  });
  return loaded;
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const appUrls = APP_ASSETS.map(toAbs);
    // bypass the HTTP cache so the new app shell is really the new one
    await cache.addAll(appUrls.map((u) => new Request(u, { cache: "reload" })));

    // reuse unchanged engine files from an older cache
    const reused = new Set();
    try {
      const olds = (await caches.keys()).filter((k) => k.startsWith("mhv-pwa-") && k !== CACHE_VERSION);
      for (const rel of ENGINE_ASSETS) {
        if (ENGINE_CHANGED.has(rel)) continue;
        const url = toAbs(rel);
        for (const k of olds) {
          const hit = await (await caches.open(k)).match(url, { ignoreSearch: true });
          if (hit && hit.ok) { await cache.put(url, hit); reused.add(rel); break; }
        }
      }
    } catch (_) {}
    await broadcast({ type: "precache-start", files: ENGINE_ASSETS.length });

    // Probe sizes (HEAD may be blocked; fall back to 0 and learn as we go)
    let bytesTotal = 0;
    const sizes = [];
    const todo = ENGINE_ASSETS.filter((rel) => !reused.has(rel));
    for (const rel of todo) {
      const url = toAbs(rel);
      let n = 0;
      try {
        const h = await fetch(url, { method: "HEAD", cache: "no-cache" });
        n = Number(h.headers.get("content-length")) || 0;
      } catch (_) {}
      sizes.push(n);
      bytesTotal += n;
    }

    let bytesLoaded = 0;
    for (let i = 0; i < todo.length; i++) {
      const rel = todo[i];
      const url = toAbs(rel);
      const got = await cacheWithProgress(cache, url, {
        file: rel.replace("./", ""),
        index: i + 1,
        files: todo.length,
        bytesLoaded,
        bytesTotal: bytesTotal || 1,
      });
      bytesLoaded += got;
      if (!sizes[i]) bytesTotal = Math.max(bytesTotal, bytesLoaded);
    }

    await broadcast({ type: "precache-complete", cache: CACHE_VERSION, bytesLoaded });
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
    await broadcast({ type: "sw-activated", cache: CACHE_VERSION });
  })());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(event.request, { ignoreSearch: true });
    if (cached) return cached;

    // Navigation fallback to the app shell
    if (event.request.mode === "navigate") {
      const shell = await cache.match(toAbs("./index.html")) || await cache.match(toAbs("./"));
      if (shell) return shell;
    }

    try {
      const res = await fetch(event.request);
      if (res && res.ok && url.origin === self.location.origin) {
        try { await cache.put(event.request, res.clone()); } catch (_) {}
      }
      return res;
    } catch (err) {
      if (event.request.mode === "navigate") {
        const shell = await cache.match(toAbs("./index.html")) || await cache.match(toAbs("./"));
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
