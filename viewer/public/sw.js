// Only here so the viewer can show notifications, which Android allows from a
// service worker alone. A click brings the viewer forward.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (open[0]) return open[0].focus();
    return self.clients.openWindow("/");
  })());
});
