/* Service worker de Skill-Link.
   - Permite instalar la app y abrirla aunque falle la conexión (muestra la última versión guardada).
   - Siempre intenta primero la red, para que cada actualización publicada en Render se vea de inmediato.
   - Las llamadas a Supabase, las fuentes y las librerías externas van directo a internet.
   - Ya trae el manejo de notificaciones push para cuando se activen. */

const CACHE = "skill-link-v2";
const SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/install.js",
  "/config.js",
  "/manifest.webmanifest",
  "/instalar.html",
  "/icons/favicon-32.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Uno por uno: si algún archivo falla, los demás igual se guardan.
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => undefined)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok && response.type === "basic") {
        const cache = await caches.open(CACHE);
        cache.put(request, response.clone());
      }
      return response;
    } catch (error) {
      const cached = await caches.match(request, { ignoreSearch: request.mode === "navigate" });
      if (cached) return cached;
      if (request.mode === "navigate") return (await caches.match("/index.html")) || Response.error();
      return Response.error();
    }
  })());
});

/* Notificaciones push (se activan en la siguiente etapa, con Supabase). */
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(self.registration.showNotification(data.title || "Skill-Link", {
    body: data.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/favicon-32.png",
    tag: data.tag || undefined,
    data: { url: data.url || "/#panel/compras" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = windows.find((client) => client.url.startsWith(self.location.origin));
    if (open) {
      await open.focus();
      if ("navigate" in open) await open.navigate(target);
      return;
    }
    await self.clients.openWindow(target);
  })());
});
