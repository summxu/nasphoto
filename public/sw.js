const VERSION = "v1";
const STATIC_CACHE = `nasphoto-static-${VERSION}`;
const MEDIA_CACHE = `nasphoto-media-${VERSION}`;
const META_CACHE = `nasphoto-meta-${VERSION}`;

const DEFAULT_CONFIG = {
  enabled: true,
  offlineCacheDays: 365,
  maxCacheEntries: 500,
};

const CORE_ASSETS = [
  "/",
  "/index.html",
  "/app.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-maskable.svg",
];

let runtimeConfig = { ...DEFAULT_CONFIG };

const readCachedConfig = async () => {
  const cache = await caches.open(META_CACHE);
  const response = await cache.match("/__pwa_config");
  if (!response) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const data = await response.json();
    return { ...DEFAULT_CONFIG, ...data };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
};

const saveConfig = async (config) => {
  const cache = await caches.open(META_CACHE);
  await cache.put(
    "/__pwa_config",
    new Response(JSON.stringify(config), {
      headers: { "content-type": "application/json" },
    }),
  );
};

const cacheFirst = async (request, cacheName) => {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) {
    return cached;
  }
  const response = await fetch(request);
  if (response && response.ok) {
    cache.put(request, response.clone());
  }
  return response;
};

const networkFirst = async (request, cacheName, fallbackUrl) => {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) {
      return cached;
    }
    if (fallbackUrl) {
      const fallback = await cache.match(fallbackUrl);
      if (fallback) {
        return fallback;
      }
    }
    throw new Error("offline");
  }
};

const getMaxAgeMs = () => {
  const days = Number(runtimeConfig.offlineCacheDays) || DEFAULT_CONFIG.offlineCacheDays;
  return Math.max(1, days) * 24 * 60 * 60 * 1000;
};

const pruneMediaCache = async () => {
  const maxEntries = Number(runtimeConfig.maxCacheEntries) || DEFAULT_CONFIG.maxCacheEntries;
  const cache = await caches.open(MEDIA_CACHE);
  const metaCache = await caches.open(META_CACHE);
  const keys = await cache.keys();
  if (keys.length === 0) {
    return;
  }

  const now = Date.now();
  const maxAge = getMaxAgeMs();
  const entries = await Promise.all(
    keys.map(async (request) => {
      const metaResponse = await metaCache.match(request);
      let timestamp = 0;
      if (metaResponse) {
        try {
          const data = await metaResponse.json();
          timestamp = Number(data.timestamp) || 0;
        } catch {
          timestamp = 0;
        }
      }
      return { request, timestamp };
    }),
  );

  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.timestamp || now - entry.timestamp > maxAge) {
        await cache.delete(entry.request);
        await metaCache.delete(entry.request);
      }
    }),
  );

  const remaining = await cache.keys();
  if (remaining.length <= maxEntries) {
    return;
  }

  const sorted = entries
    .filter((entry) => entry.timestamp)
    .sort((a, b) => a.timestamp - b.timestamp);
  const excess = remaining.length - maxEntries;
  for (let i = 0; i < excess && i < sorted.length; i += 1) {
    await cache.delete(sorted[i].request);
    await metaCache.delete(sorted[i].request);
  }
};

const cacheMedia = async (request) => {
  const cache = await caches.open(MEDIA_CACHE);
  const metaCache = await caches.open(META_CACHE);
  const cached = await cache.match(request);
  const maxAge = getMaxAgeMs();

  if (cached) {
    const metaResponse = await metaCache.match(request);
    if (metaResponse) {
      try {
        const { timestamp } = await metaResponse.json();
        if (timestamp && Date.now() - timestamp < maxAge) {
          return cached;
        }
      } catch {
        // ignore meta issues
      }
    }
  }

  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone());
      metaCache.put(
        request,
        new Response(JSON.stringify({ timestamp: Date.now() }), {
          headers: { "content-type": "application/json" },
        }),
      );
      pruneMediaCache();
    }
    return response;
  } catch {
    if (cached) {
      return cached;
    }
    throw new Error("offline");
  }
};

self.addEventListener("message", (event) => {
  if (!event.data || event.data.type !== "PWA_CONFIG") {
    return;
  }
  runtimeConfig = { ...DEFAULT_CONFIG, ...event.data.payload };
  saveConfig(runtimeConfig);
});

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      await cache.addAll(CORE_ASSETS);
      try {
        const response = await fetch("/api/pwa-config", { cache: "no-store" });
        if (response.ok) {
          const config = await response.json();
          runtimeConfig = { ...DEFAULT_CONFIG, ...config };
          await saveConfig(runtimeConfig);
        }
      } catch {
        // ignore
      }
      self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => ![STATIC_CACHE, MEDIA_CACHE, META_CACHE].includes(key))
          .map((key) => caches.delete(key)),
      );
      runtimeConfig = await readCachedConfig();
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") {
    return;
  }
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, STATIC_CACHE, "/index.html"));
    return;
  }

  if (CORE_ASSETS.includes(url.pathname)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  if (request.destination === "image" || url.pathname.startsWith("/media/thumb/")) {
    if (!runtimeConfig.enabled) {
      event.respondWith(fetch(request));
      return;
    }
    event.respondWith(cacheMedia(request));
    return;
  }
});
