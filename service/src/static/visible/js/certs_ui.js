// Shared bits for the account and admin pages.

import { formatUnixDate } from "./dates.js";

const DAY = 24 * 60 * 60;
export const RENEW_WARNING_DAYS = 30;

export const formatDate = formatUnixDate;

// "‹ Back" returns to the page you came from (usually the map). Its href,
// the index, is only the fallback for when the page was opened directly.
export function setupBackLink() {
	document.querySelector("a.back")?.addEventListener("click", (e) => {
		const fromHere = document.referrer && new URL(document.referrer).origin === location.origin;
		if (fromHere && history.length > 1) {
			e.preventDefault();
			history.back();
		}
	});
}

// A message if a cert expiring at `notAfter` should be renewed soon, else null.
export function expiryWarning(notAfter) {
	const days = Math.floor((notAfter - Date.now() / 1000) / DAY);
	if (days > RENEW_WARNING_DAYS) return null;
	return days <= 0
		? "Your certificate for this device expires today."
		: `Your certificate for this device expires in ${days} day${days === 1 ? "" : "s"}.`;
}

export function showError(element, e) {
	element.textContent = e.message;
	element.className = "error";
}

function tag(text, className = "tag") {
	const span = document.createElement("span");
	span.className = className;
	span.textContent = text;
	return span;
}

// A small danger button that stays disabled while `onClick` runs, so a
// double tap doesn't fire the request twice.
export function actionButton(text, onClick) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "danger";
	button.textContent = text;
	button.addEventListener("click", async () => {
		button.disabled = true;
		try {
			await onClick();
		} finally {
			button.disabled = false;
		}
	});
	return button;
}

// One entry of a `.list`: title and tags on the first line with the action
// button next to them (so it's visible without scrolling sideways on a
// phone), then one line per entry of `lines`.
export function listItem({ title, tags = [], lines = [], action = null }) {
	const li = document.createElement("li");
	li.className = "item";

	const head = document.createElement("div");
	head.className = "item-head";
	const titleEl = document.createElement("div");
	titleEl.className = "item-title";
	const strong = document.createElement("strong");
	strong.textContent = title;
	titleEl.append(strong, ...tags);
	head.append(titleEl);
	if (action) head.append(action);
	li.append(head);

	for (const line of lines) {
		const div = document.createElement("div");
		div.className = `item-meta ${line.className ?? ""}`;
		div.textContent = line.text;
		li.append(div);
	}
	return li;
}

// A list item for one cert: label, status, expiry, serial, and a revoke
// button while it's active.
export function certItem(cert, { note, onRevoke }) {
	const tags = [];
	if (note) tags.push(tag(note));
	tags.push(tag(cert.status, `pill status-${cert.status}`));

	const when =
		cert.status === "revoked"
			? `Revoked ${formatDate(cert.revoked_at)}`
			: `${cert.status === "expired" ? "Expired" : "Expires"} ${formatDate(cert.not_after)}`;

	return listItem({
		title: cert.label,
		tags,
		lines: [{ text: when }, { text: cert.serial, className: "serial" }],
		action: cert.status === "active" ? actionButton("Revoke", onRevoke) : null,
	});
}

// Elements listing `certs`: active ones up front, expired and revoked ones
// folded away so they don't push everything else off screen on a phone.
export function certLists(certs, item) {
	const active = certs.filter((c) => c.status === "active");
	const old = certs.filter((c) => c.status !== "active");

	const list = document.createElement("ul");
	list.className = "list";
	fillList(list, active.map(item), "No active certificates.");
	if (!old.length) return [list];

	const details = document.createElement("details");
	details.className = "fold";
	const summary = document.createElement("summary");
	summary.textContent = `${old.length} expired or revoked`;
	const oldList = document.createElement("ul");
	oldList.className = "list";
	oldList.append(...old.map(item));
	details.append(summary, oldList);
	return [list, details];
}

// Fills `list` with `items`, or a placeholder line when there are none.
export function fillList(list, items, emptyText) {
	if (items.length) {
		list.replaceChildren(...items);
	} else {
		const li = document.createElement("li");
		li.className = "empty";
		li.textContent = emptyText;
		list.replaceChildren(li);
	}
}
