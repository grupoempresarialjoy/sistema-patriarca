/* ══════════════════════════════════════════════════════════════════════════
   Service worker — solo para recibir notificaciones push en el iPhone/Android
   del administrador (Web Push, sin pasar por Apple Developer ni FCM nativo).
   No cachea nada del portal: si algún día se agrega offline real, va aparte.
   ══════════════════════════════════════════════════════════════════════════ */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

/* ── número rojo sobre el ícono (Badging API) ─────────────────────────────
   El service worker se puede reiniciar entre una notificación y la
   siguiente, así que el contador no puede vivir en una variable normal —
   se guarda en Cache Storage, lo único persistente al alcance de un SW sin
   montar IndexedDB para esto. Se limpia solo cuando la app se abre/enfoca
   (ver chat.js, limpiarBadge()), no cuando se toca una notificación puntual
   — así uno sigue viendo "tienes 3 pendientes" aunque abra solo una. */
const BADGE_CACHE = 'patriarca-badge-v1';
const BADGE_KEY = new Request('https://patriarca.local/__badge_count__');

async function leerBadge() {
  try {
    const cache = await caches.open(BADGE_CACHE);
    const resp = await cache.match(BADGE_KEY);
    return resp ? (parseInt(await resp.text(), 10) || 0) : 0;
  } catch (e) { return 0; }
}

async function guardarBadge(n) {
  try {
    const cache = await caches.open(BADGE_CACHE);
    await cache.put(BADGE_KEY, new Response(String(n)));
  } catch (e) {}
}

self.addEventListener('push', event => {
  let datos = {};
  try { datos = event.data ? event.data.json() : {}; } catch (e) {}

  const titulo = datos.titulo || 'Patriarca';
  const opciones = {
    body: datos.cuerpo || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: (datos.datos && datos.datos.tipo) || 'patriarca',
    renotify: true,
    data: datos.datos || {}
  };

  event.waitUntil((async () => {
    await self.registration.showNotification(titulo, opciones);
    const n = (await leerBadge()) + 1;
    await guardarBadge(n);
    if (self.navigator.setAppBadge) { try { await self.navigator.setAppBadge(n); } catch (e) {} }
  })());
});

// La página avisa por acá cuando se abre/enfoca, para poner el contador de
// vuelta en cero (ver chat.js).
self.addEventListener('message', event => {
  if (event.data && event.data.tipo === 'limpiarBadge') {
    event.waitUntil(guardarBadge(0));
  }
});

// Al tocar la notificación: si ya hay una pestaña del portal abierta, la
// enfoca; si no, abre admin.html.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(lista => {
      for (const c of lista) {
        if ('focus' in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/admin.html');
    })
  );
});
