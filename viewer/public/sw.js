// Shows a turn as a notification, from a push even when the viewer is closed,
// or from the page itself (Android only allows that from here). A click brings
// the viewer forward.
self.addEventListener("push", (event) => {
  const { title, body } = event.data?.json() ?? { title: "Your turn", body: "" };
  event.waitUntil(self.registration.showNotification(title, {
    body, tag: "ridealong-turn", renotify: true, requireInteraction: true, icon: "/icon-192.png", badge: "/icon-192.png",
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (open[0]) return open[0].focus();
    return self.clients.openWindow("/");
  })());
});
