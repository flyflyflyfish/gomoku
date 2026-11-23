// 果果五子棋 · Service Worker (浏览器推送, 与果果麻将共用同一 VAPID)
self.addEventListener('push', (event) => {
  let data = { title: '果果五子棋', body: '' };
  try { data = Object.assign(data, event.data.json()); } catch (e) {
    if (event.data) data.body = event.data.text();
  }
  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" fill="%23e8c98f"/><circle cx="38" cy="45" r="14" fill="%23000"/><circle cx="64" cy="58" r="14" fill="%23fff" stroke="%23999"/></svg>',
    tag: 'gg-wzq',
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: 'window' }).then(list => {
    for (const c of list) if (c.url.includes('/gmk')) return c.focus();
    return clients.openWindow('/gmk/');
  }));
});
