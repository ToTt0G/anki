// Anki Web Service Worker (PWA & Web Push)
const CACHE_NAME = "klanki-web-v8";
const PRECACHE_URLS = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/favicon.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-192.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
  "/icons/badge-72.png"
];

// 1. Install lifecycle: pre-cache static shell & skip waiting
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_URLS).catch((err) => {
        console.warn("Pre-cache partially skipped:", err);
      });
    }).then(() => self.skipWaiting())
  );
});

// 2. Activate lifecycle: claim clients immediately & prune old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// 3. Fetch handler: Cache-first for static assets, Network-only for /api/ and WebSockets
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never cache API or WebSocket requests
  if (url.pathname.startsWith("/api/") || event.request.headers.get("Upgrade") === "websocket") {
    return;
  }

  // Handle navigation requests (SPA HTML)
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() => caches.match("/index.html") || caches.match("/"))
    );
    return;
  }

  // Static assets: Stale-While-Revalidate
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200 && event.request.method === "GET") {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseToCache);
            });
          }
          return networkResponse;
        })
        .catch(() => cachedResponse);

      return cachedResponse || fetchPromise;
    })
  );
});

// 4. Web Push Notification handler
self.addEventListener("push", (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (_err) {
      data = { body: event.data.text() };
    }
  }

  const title = data.title || "klanki Review Reminder";
  const options = {
    body: data.body || "You have cards due for review today!",
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-72.png",
    tag: data.tag || "klanki-due-review",
    renotify: true,
    data: {
      url: data.url || "/",
      timestamp: Date.now()
    },
    vibrate: [100, 50, 100],
    actions: [
      { action: "study", title: "Review Now" },
      { action: "close", title: "Later" }
    ]
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// 5. Notification Click handler: focus existing window or open new window
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  if (event.action === "close") {
    return;
  }

  const targetUrl = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          // If already on page, focus and optionally navigate
          if (client.url.includes(self.location.origin)) {
            client.focus();
            if (targetUrl !== "/") {
              client.navigate(targetUrl);
            }
            return;
          }
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
