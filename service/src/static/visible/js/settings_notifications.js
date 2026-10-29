// Settings' Notifications card: turning them on for this device, a test,
// and the devices that get them.

import { deleteChannel, getChannels, sendTestNotification } from "./api.js";
import { formatDateTime } from "./dates.js";
import { t, tn } from "./i18n.js";
import { currentSubscription, disablePush, enablePush, pushSupport } from "./push.js";
import { escapeHtml } from "./stations.js";

const status = document.getElementById("pushStatus");
const toggle = document.getElementById("pushToggle");
const testButton = document.getElementById("pushTest");
const message = document.getElementById("pushMessage");
const channelsBox = document.getElementById("channelsBox");
const channelList = document.getElementById("channels");

let channels = [];
let endpoint = null;

function say(text, error = false) {
	message.textContent = text;
	message.className = error ? "error" : "";
}

const date = (ts) => formatDateTime(new Date(ts * 1000));

function render() {
	const support = pushSupport();
	const on = channels.some((c) => c.address === endpoint);
	status.textContent = {
		"ios-install": t("On iPhone and iPad, notifications only work in the app on the home screen: tap Share, then Add to Home Screen, and open it from there."),
		unsupported: t("This browser can't show notifications."),
		denied: t("Notifications are blocked for this site. Allow them in the browser's settings and try again."),
		ok: on ? t("This device gets notifications.") : t("This device doesn't get notifications."),
	}[support];
	toggle.hidden = support !== "ok";
	toggle.textContent = on ? t("Turn off on this device") : t("Turn on for this device");
	toggle.className = on ? "secondary" : "";
	testButton.hidden = channels.length === 0;

	channelsBox.hidden = channels.length === 0;
	channelList.replaceChildren(
		...channels.map((c) => {
			const li = document.createElement("li");
			li.className = "item";
			const last = c.last_ok_at ? t("Last one {date}", { date: date(c.last_ok_at) }) : t("None sent yet");
			li.innerHTML = `
				<div class="item-head">
					<div>
						<div class="item-title"><strong>${escapeHtml(c.label)}</strong>${c.address === endpoint ? ` <span class="pill">${t("This device")}</span>` : ""}</div>
						<div class="item-meta">${t("Added {date}", { date: date(c.created_at) })} · ${last}</div>
						${c.failures ? `<div class="item-meta channel-warning">${tn(c.failures, "The last one failed", "The last {n} failed")}</div>` : ""}
					</div>
					<button type="button" class="danger">${t("Remove")}</button>
				</div>`;
			li.querySelector("button").addEventListener("click", () =>
				run(async () => {
					if (c.address === endpoint) await disablePush(channels);
					else await deleteChannel(c.id);
				}),
			);
			return li;
		}),
	);
}

async function refresh() {
	[channels, endpoint] = await Promise.all([getChannels(), currentSubscription().then((s) => s?.endpoint ?? null)]);
	render();
}

// Runs `action` with the buttons disabled, then shows the new state.
// `action` can resolve to [text, isError] to show.
async function run(action) {
	toggle.disabled = testButton.disabled = true;
	say("");
	try {
		const [text = "", error = false] = (await action()) ?? [];
		say(text, error);
	} catch (e) {
		say(e.message, true);
	} finally {
		toggle.disabled = testButton.disabled = false;
		await refresh().catch((e) => say(e.message, true));
	}
}

toggle.addEventListener("click", () => {
	const on = channels.some((c) => c.address === endpoint);
	run(async () => {
		await (on ? disablePush(channels) : enablePush());
	});
});

testButton.addEventListener("click", () =>
	run(async () => {
		const { sent, failed, removed } = await sendTestNotification();
		const parts = [tn(sent, "Sent to 1 device.", "Sent to {n} devices.")];
		if (failed) parts.push(tn(failed, "1 failed.", "{n} failed."));
		if (removed) parts.push(tn(removed, "1 no longer existed and was removed.", "{n} no longer existed and were removed."));
		return [parts.join(" "), sent === 0];
	}),
);

refresh().catch((e) => say(e.message, true));
