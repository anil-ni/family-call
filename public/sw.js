/* Service worker: receives push messages when the app is closed or in the
   background and turns them into notifications on the lock screen. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'Family Call', body: 'You have a new notification' };
  }

  const isCall = payload.type === 'call';

  event.waitUntil(
    (async () => {
      // If the app is already open and on screen, the in-app ring or chat
      // bubble is enough — a second alert would just be noise.
      const clients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true
      });
      if (clients.some((c) => c.visibilityState === 'visible')) return;

      await self.registration.showNotification(payload.title || 'Family Call', {
        body: payload.body || '',
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        tag: isCall ? 'family-call-ring' : 'family-call-message',
        renotify: true,
        requireInteraction: isCall,
        vibrate: isCall ? [400, 200, 400, 200, 400] : [180],
        data: {
          type: payload.type,
          fromId: payload.fromId
        }
      });
    })()
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true
      });

      for (const client of clients) {
        if ('focus' in client) {
          client.postMessage({ type: 'notification-click', data });
          return client.focus();
        }
      }

      // App was fully closed — open it, passing along who it was about.
      const url = data.fromId ? `./?from=${encodeURIComponent(data.fromId)}` : './';
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })()
  );
});
