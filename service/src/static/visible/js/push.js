// This browser's Web Push subscription: turning notifications on and off,
// for Settings and My stations. The service worker (/files/sw.js) shows them.

import { deleteChannel, getVapidKey, putPushSubscription } from "./api.js";
import { LANG, t } from "./i18n.js";

const SW_URL = "/files/sw.js";

const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () => navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;

// "ok", "ios-install" (iOS only allows it from a home screen app),
// "denied" (the user blocked notifications) or "unsupported".
export function pushSupport() {
	const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
	if (!supported) return isIos() && !isStandalone() ? "ios-install" : "unsupported";
	if (Notification.permission === "denied") return "denied";
	return "ok";
}

// A name for this device in the list of the ones that get notifications.
export function deviceLabel() {
	const ua = navigator.userAgent;
	const os = isIos()
		? (/iPad/.test(ua) || (navigator.maxTouchPoints > 1 && !/iPhone/.test(ua)) ? "iPad" : "iPhone")
		: /Android/.test(ua) ? "Android"
		: /Windows/.test(ua) ? "Windows"
		: /Mac OS X/.test(ua) ? "macOS"
		: /CrOS/.test(ua) ? "ChromeOS"
		: /Linux/.test(ua) ? "Linux"
		: "";
	const browser = isIos() && isStandalone() ? t("Home screen app")
		: /SamsungBrowser/.test(ua) ? "Samsung Internet"
		: /Edg\//.test(ua) ? "Edge"
		: /OPR\//.test(ua) ? "Opera"
		: /Firefox\//.test(ua) ? "Firefox"
		: /Chrome\//.test(ua) ? "Chrome"
		: /Safari\//.test(ua) ? "Safari"
		: t("Browser");
	return [os, browser].filter(Boolean).join(" · ");
}

async function registration() {
	return await navigator.serviceWorker.register(SW_URL);
}

// This browser's subscription, or null.
export async function currentSubscription() {
	if (pushSupport() !== "ok") return null;
	const reg = await navigator.serviceWorker.getRegistration(SW_URL);
	return (await reg?.pushManager.getSubscription()) ?? null;
}

function base64UrlToBytes(text) {
	const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
	return Uint8Array.from(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

function sameKey(buffer, bytes) {
	if (!buffer) return false;
	const a = new Uint8Array(buffer);
	return a.length === bytes.length && a.every((b, i) => b === bytes[i]);
}

// Asks for permission, subscribes and registers this browser. Call it from
// a tap: Safari only asks then. Returns the channel's { id }.
export async function enablePush() {
	// First, before anything else is awaited, or Safari won't ask.
	const permission = await Notification.requestPermission();
	if (permission !== "granted") {
		throw new Error(permission === "denied"
			? t("Notifications are blocked for this site. Allow them in the browser's settings and try again.")
			: t("Notifications weren't allowed."));
	}
	const [reg, key] = await Promise.all([registration(), getVapidKey()]);
	await navigator.serviceWorker.ready;
	const serverKey = base64UrlToBytes(key);
	let subscription = await reg.pushManager.getSubscription();
	// Made with another server key (it changed): it can't be used any more.
	if (subscription && !sameKey(subscription.options?.applicationServerKey, serverKey)) {
		await subscription.unsubscribe();
		subscription = null;
	}
	subscription ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey });
	return await putPushSubscription(subscription, deviceLabel(), LANG);
}

// Stops notifications on this browser. `channels`: what getChannels returned.
export async function disablePush(channels) {
	const subscription = await currentSubscription();
	if (!subscription) return;
	const channel = channels.find((c) => c.address === subscription.endpoint);
	if (channel) await deleteChannel(channel.id);
	await subscription.unsubscribe();
}
