// klanki Service Worker (PWA & Web Push) (N01, N02, N07)
const CACHE_PREFIX = "klanki-web-";
const CACHE_NAME = "klanki-web-v24";
const MAX_RUNTIME_CACHE_ENTRIES = 60;

const PRECACHE_URLS = [
    "/",
    "/index.html",
    "/manifest.webmanifest",
    "/favicon.png",
    "/favicon.ico",
    "/icons/icon-96.png",
    "/icons/icon-192.png",
    "/icons/icon-512.png",
    "/icons/icon-maskable-192.png",
    "/icons/icon-maskable-512.png",
    "/icons/apple-touch-icon.png",
    "/icons/badge-72.png",
    "/vendor/sql.js/sql-wasm.js",
    "/vendor/sql.js/sql-wasm.wasm",
    "/vendor/mathjax/precache-svg.json",
];

function isCacheableStaticPath(pathname) {
    return (
        pathname.startsWith("/assets/")
        || pathname.startsWith("/icons/")
        || pathname.startsWith("/vendor/")
        || pathname === "/manifest.webmanifest"
        || pathname.startsWith("/favicon")
    );
}

async function trimCache(cache, maxEntries) {
    // Keep the offline shell and all bundled math resources when trimming runtime assets.
    const keys = (await cache.keys()).filter(request => {
        const path = new URL(request.url).pathname;
        return !PRECACHE_URLS.includes(path) && !path.startsWith("/vendor/mathjax/");
    });
    if (keys.length > maxEntries) {
        const excess = keys.length - maxEntries;
        for (let i = 0; i < excess; i++) {
            await cache.delete(keys[i]);
        }
    }
}

// 1. Install lifecycle: pre-cache static shell & local WASM runtime
self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(async cache => {
            const manifest = await fetch("/vendor/mathjax/precache-svg.json");
            if (!manifest.ok) { throw new Error("Math assets unavailable"); }
            const mathUrls = await manifest.json();
            await cache.addAll([...PRECACHE_URLS, ...mathUrls]);
        }).then(() => self.skipWaiting()),
    );
});

// 2. Activate lifecycle: claim clients & prune only klanki-owned obsolete caches (N01)
self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames
                    .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
                    .map((name) => caches.delete(name)),
            );
        }).then(() => self.clients.claim()),
    );
});

// 3. Fetch handler: Approved same-origin static assets only with bounded eviction (N02)
self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);

    // Never intercept cross-origin requests (Clerk, OAuth, etc.)
    if (url.origin !== self.location.origin) {
        return;
    }

    // Never cache API, WebSocket, or OAuth callback requests
    if (
        url.pathname.startsWith("/api/")
        || url.pathname.startsWith("/sso-callback")
        || url.search.includes("__clerk")
        || event.request.headers.get("Upgrade") === "websocket"
    ) {
        return;
    }

    // Handle navigation requests (SPA HTML) — network first with offline shell fallback
    if (event.request.mode === "navigate") {
        event.respondWith(
            fetch(event.request).catch(() => caches.match("/index.html") || caches.match("/")),
        );
        return;
    }

    // Only cache approved static asset paths with bounded eviction (N02)
    if (!isCacheableStaticPath(url.pathname)) {
        return;
    }

    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            const fetchPromise = fetch(event.request)
                .then((networkResponse) => {
                    if (networkResponse && networkResponse.status === 200 && event.request.method === "GET") {
                        const responseToCache = networkResponse.clone();
                        caches.open(CACHE_NAME).then(async (cache) => {
                            await cache.put(event.request, responseToCache);
                            await trimCache(cache, MAX_RUNTIME_CACHE_ENTRIES);
                        });
                    }
                    return networkResponse;
                })
                .catch(() => cachedResponse);

            return cachedResponse || fetchPromise;
        }),
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
            timestamp: Date.now(),
        },
        vibrate: [100, 50, 100],
        actions: [
            { action: "study", title: "Review Now" },
            { action: "close", title: "Later" },
        ],
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
        }),
    );
});
