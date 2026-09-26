import {
	createTrip,
	createTripShare,
	deleteTrip,
	forgetSearch,
	getTrip,
	getTripShares,
	getTrips,
	revokeTripShare,
	routePageUrl,
	getUserState,
	updateTrip,
} from "./api.js";
import { actionButton, formatDate, showError } from "./certs_ui.js";
import { renderNav } from "./nav.js";
import { formatDistance, formatDuration } from "./route.js";

const message = document.getElementById("message");

function el(tag, className, text) {
	const e = document.createElement(tag);
	if (className) e.className = className;
	if (text != null) e.textContent = text;
	return e;
}

function button(text, onClick, className = "secondary") {
	const b = actionButton(text, onClick);
	b.className = className;
	return b;
}

// "Calle A → Calle B · 72.1 km · 55 min"
function routeLine(route) {
	if (!route) return "Route no longer available";
	const ends = route.from && route.to ? `${route.from} → ${route.to} · ` : "";
	return `${ends}${formatDistance(route.distance)} · ${formatDuration(route.duration)}`;
}

function item({ title, href, lines, actions = [], extra = null }) {
	const li = el("li", "item");
	const head = el("div", "item-head");
	const titleEl = el("div", "item-title");
	const link = el("a", "trip-link", title);
	link.href = href;
	titleEl.append(link);
	head.append(titleEl);
	li.append(head);
	for (const line of lines) li.append(el("div", "item-meta", line));
	if (actions.length) {
		const row = el("div", "trip-actions");
		row.append(...actions);
		li.append(row);
	}
	if (extra) li.append(extra);
	return li;
}

function empty(text) {
	return el("li", "empty", text);
}

async function saveAs(hash, route_idx, suggestedName, blacklist = [], max_distance = null) {
	const name = prompt("Trip name", suggestedName)?.trim();
	if (!name) return;
	const { id } = await createTrip({ hash, route_idx, name, blacklist, max_distance });
	location.assign(routePageUrl(hash, route_idx, id));
}

// Who a trip is shared with, and making/revoking links. Loaded on demand.
function sharesPanel(trip) {
	const details = el("details", "fold shares");
	details.append(el("summary", null, "Sharing"));
	const body = el("div");
	details.append(body);

	async function refresh() {
		const shares = await getTripShares(trip.id);
		const list = el("ul", "list");
		if (!shares.length) list.append(empty("Not shared with anyone."));
		for (const share of shares) {
			const li = el("li", "item");
			const head = el("div", "item-head");
			const who = share.claimed_by
				? `Shared with ${share.claimed_by}`
				: `Unused link, expires ${formatDate(share.expires_at)}`;
			head.append(
				el("div", "item-title", who),
				actionButton(share.claimed_by ? "Revoke" : "Cancel", async () => {
					try {
						await revokeTripShare(trip.id, share.id);
						await refresh();
					} catch (e) {
						showError(message, e);
					}
				}),
			);
			li.append(head);
			list.append(li);
		}

		const newLink = el("div", "invite-link");
		const create = button(
			"New share link",
			async () => {
				try {
					const { url } = await createTripShare(trip.id);
					const input = el("input");
					input.type = "text";
					input.readOnly = true;
					input.value = url;
					const copy = button("Copy", async () => {
						await navigator.clipboard?.writeText(url);
						copy.textContent = "Copied";
					});
					newLink.replaceChildren(
						input,
						copy,
						el(
							"p",
							"muted",
							"Works for one person only: the first to open it gets access, nobody else. It expires in 7 days if unused. The link isn't shown again.",
						),
					);
					input.select();
					await refresh();
				} catch (e) {
					showError(message, e);
				}
			},
			"",
		);
		newLink.append(create);

		body.replaceChildren(list, newLink);
	}

	details.addEventListener("toggle", () => {
		if (details.open) refresh().catch((e) => showError(message, e));
	});
	return details;
}

function savedItem(trip) {
	return item({
		title: trip.name,
		href: routePageUrl(trip.hash, trip.route_idx, trip.id),
		lines: [routeLine(trip.route), `Last opened ${formatDate(trip.last_used_at)}`],
		actions: [
			button("Rename", async () => {
				const name = prompt("Trip name", trip.name)?.trim();
				if (!name || name === trip.name) return;
				try {
					await updateTrip(trip.id, { name });
					await refresh();
				} catch (e) {
					showError(message, e);
				}
			}),
			actionButton("Delete", async () => {
				if (!confirm(`Delete "${trip.name}"? Its excluded stations and share links go with it.`)) return;
				try {
					await deleteTrip(trip.id);
					await refresh();
				} catch (e) {
					showError(message, e);
				}
			}),
		],
		extra: sharesPanel(trip),
	});
}

function sharedItem(trip) {
	return item({
		title: trip.name,
		href: routePageUrl(trip.hash, trip.route_idx, trip.id),
		lines: [routeLine(trip.route), `From ${trip.owner}`],
		actions: [
			button("Save a copy", async () => {
				try {
					const full = await getTrip(trip.id);
					await saveAs(trip.hash, trip.route_idx, trip.name, full.blacklist, full.max_distance);
				} catch (e) {
					showError(message, e);
				}
			}),
		],
	});
}

function searchItem(search) {
	const first = search.alternatives[0];
	const title = first?.from && first?.to ? `${first.from} → ${first.to}` : "Route";
	const li = el("li", "item");

	const head = el("div", "item-head");
	head.append(
		el("div", "item-title", title),
		actionButton("Remove", async () => {
			if (!confirm(`Remove "${title}" from your searches?`)) return;
			try {
				await forgetSearch(search.hash);
				await refresh();
			} catch (e) {
				showError(message, e);
			}
		}),
	);
	li.append(head, el("div", "item-meta", `Searched ${formatDate(search.searched_at)}`));

	// One line per alternative: open it in the planner, or save it as a trip.
	const alternatives = el("ul", "alternatives");
	search.alternatives.forEach((route, idx) => {
		const row = el("li", "alternative");
		const link = el(
			"a",
			"trip-link",
			`Route ${idx + 1} · ${formatDistance(route.distance)} · ${formatDuration(route.duration)}`,
		);
		link.href = routePageUrl(search.hash, idx);
		row.append(link);
		if (idx === search.last_route_idx) row.append(el("span", "tag", "last opened"));
		row.append(
			button("Save as trip", async () => {
				try {
					await saveAs(search.hash, idx, title);
				} catch (e) {
					showError(message, e);
				}
			}),
		);
		alternatives.append(row);
	});
	li.append(alternatives);
	return li;
}

async function refresh() {
	message.textContent = "";
	try {
		const { saved, shared_with_me, searches } = await getTrips();

		document
			.getElementById("saved")
			.replaceChildren(...(saved.length ? saved.map(savedItem) : [empty("No saved trips yet. Save one from a route's page.")]));

		document.getElementById("sharedCard").hidden = !shared_with_me.length;
		document.getElementById("shared").replaceChildren(...shared_with_me.map(sharedItem));

		document
			.getElementById("searches")
			.replaceChildren(
				...(searches.length
					? searches.map(searchItem)
					: [empty("No searches yet. Use the route button on the map to make one.")]),
			);
	} catch (e) {
		showError(message, e);
	}
}

getUserState().then((state) => renderNav(document.getElementById("nav"), state, "trips"));
refresh();
