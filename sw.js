// Guarda la app en el teléfono para que abra sin internet.
const VERSION = "audiolibro-v16";
const ARCHIVOS = [
  "./", "index.html", "styles.css", "app.js", "db.js", "manifest.webmanifest",
  "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "kaggle.js",
  "vendor/fflate-0.8.2.js", "guia.html", "choro/", "choro/index.html", "choro/manifest.webmanifest", "choro/logo.png", "choro/logo-claro.png", "choro/icon-192.png", "choro/icon-512.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Red primero (para recibir actualizaciones), y si no hay internet, la copia guardada.
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request)
      .then(r => {
        if (r.ok && (r.type === "basic" || r.type === "cors")) {
          const copia = r.clone();
          caches.open(VERSION).then(c => c.put(e.request, copia));
        }
        return r;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match("index.html")))
  );
});
