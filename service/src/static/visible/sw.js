// The service worker. It only shows notifications (price alerts): pages
// aren't cached, so the site works as it does without it.
//
// Served from /files/, so it controls the pages under /files/.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// The server sends { title, body, url }, already in the user's language.
self.addEventListener("push", (event) => {
	let message;
	try {
		message = event.data.json();
	} catch {
		message = { title: "Precios carburantes", body: event.data?.text() ?? "" };
	}
	event.waitUntil(
		self.registration.showNotification(message.title, {
			body: message.body,
			icon: "/files/images/icon-192.png",
			badge: "/files/images/badge-96.png",
			data: { url: message.url ?? "/files/stations" },
		}),
	);
});

// Opens the notification's page, in a window of the app if one is open.
self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const url = new URL(event.notification.data?.url ?? "/files/stations", self.location.origin).href;
	event.waitUntil(
		(async () => {
			const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
			const open = windows.find((w) => w.url === url) ?? windows[0];
			if (open) {
				if (open.url !== url) await open.navigate(url);
				return open.focus();
			}
			return self.clients.openWindow(url);
		})(),
	);
});

// The browser replaced the subscription (keys rotate now and then): register
// the new one in the old one's place, so notifications keep coming.
self.addEventListener("pushsubscriptionchange", (event) => {
	event.waitUntil(
		(async () => {
			const options = event.oldSubscription?.options;
			const subscription =
				event.newSubscription ??
				(options ? await self.registration.pushManager.subscribe(options) : null);
			if (!subscription) return;
			await fetch("/api/notifications/channels/webpush", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ...subscription.toJSON(), old_endpoint: event.oldSubscription?.endpoint ?? null }),
			});
		})(),
	);
});
