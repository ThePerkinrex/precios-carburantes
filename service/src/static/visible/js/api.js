import { mapFilterToArray, mapFilterToString } from "./filter.js";
import { t } from "./i18n.js";

export const API_LOCATION = "/api";

export async function getLatestPrices() {
	return await fetch(API_LOCATION + "/prices").then((x) => x.json());
}

export async function getUserState() {
	return await fetch(API_LOCATION + "/user/state")
		.then((x) => x.json())
		.then(async (x) => ({
			...x,
			filter: await mapFilterToArray(x.filter),
		}));
}

export async function updateDisplayName(newDisplayName) {
	await fetch(API_LOCATION + "/user/name/display", {
		method: "PUT",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ display_name: newDisplayName }),
	});
}

export async function updateFilter(newFilter) {
	await fetch(API_LOCATION + "/user/filter", {
		method: "PUT",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ filter: await mapFilterToString(newFilter) }),
	});
}

// Kicks off route calculation for a list of [lat, lon] waypoints and
// returns { hash }. The backend computes (or reuses a cached) route
// synchronously, so the hash is immediately fetchable via getRoute().
export async function createRoute(waypoints) {
	return await fetch(API_LOCATION + "/route/", {
		method: "POST",

		headers: {
			"Content-Type": "application/json",
		},

		body: JSON.stringify({ waypoints }),
	}).then((x) => x.json());
}

// Fetches a previously computed route by hash:
// { waypoints, routes: [{ geometry, duration, distance }, ...] }
export async function getRoutes(hash) {
	return await fetch(`${API_LOCATION}/route/${hash}`).then((x) => x.json());
}

export async function getRoute(hash, idx) {
	return await fetch(`${API_LOCATION}/route/${hash}/${idx}`).then((x) => x.json());
}

export async function getPricesOnRoute(hash, idx, query = {}) {
	let params = new URLSearchParams(query)
	return await fetch(`${API_LOCATION}/route/${hash}/${idx}/prices?${params}`)
		.then(checkOk)
		.then((x) => x.json());
}

// { fuel, consumption, tank_size, stop_min, stop_max }; any of them may be null.
export async function updateCar(car) {
	await fetch(API_LOCATION + "/user/car", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(car),
	}).then(checkOk);
}

// ---------------------------------------------------------------------------
// Saved trips. Private to their owner; others only see one through a share
// link they claimed (single use: the first user to open it keeps it).
// ---------------------------------------------------------------------------

// Removes a route from the user's searches (and access to it, unless it's
// the route of one of their trips).
export async function forgetSearch(hash) {
	await fetch(`${API_LOCATION}/route/${hash}`, { method: "DELETE" }).then(checkOk);
}

// { saved: [...], shared_with_me: [...], searches: [...] }
export async function getTrips() {
	return await fetch(API_LOCATION + "/trips").then(checkOk).then((x) => x.json());
}

// { id, name, hash, route_idx, max_distance, owned, owner, blacklist: [station ids] }
export async function getTrip(id) {
	return await fetch(`${API_LOCATION}/trips/${id}`).then(checkOk).then((x) => x.json());
}

// -> { id }. Also how a shared trip is copied: pass the blacklist being shown.
export async function createTrip({ hash, route_idx, name, max_distance = null, blacklist = [] }) {
	return await fetch(API_LOCATION + "/trips", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ hash, route_idx, name, max_distance, blacklist }),
	})
		.then(checkOk)
		.then((x) => x.json());
}

// `changes`: { name?, max_distance? }
export async function updateTrip(id, changes) {
	await fetch(`${API_LOCATION}/trips/${id}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(changes),
	}).then(checkOk);
}

export async function deleteTrip(id) {
	await fetch(`${API_LOCATION}/trips/${id}`, { method: "DELETE" }).then(checkOk);
}

export async function addTripBlacklist(id, stationId) {
	await fetch(`${API_LOCATION}/trips/${id}/blacklist/${stationId}`, { method: "PUT" }).then(checkOk);
}

export async function removeTripBlacklist(id, stationId) {
	await fetch(`${API_LOCATION}/trips/${id}/blacklist/${stationId}`, { method: "DELETE" }).then(checkOk);
}

// -> { url, expires_at }. The link works for the first user who opens it.
export async function createTripShare(id) {
	const share = await fetch(`${API_LOCATION}/trips/${id}/shares`, { method: "POST" })
		.then(checkOk)
		.then((x) => x.json());
	return { url: location.origin + share.path, expires_at: share.expires_at };
}

// [{ id, created_at, expires_at, claimed_by, claimed_at }]
export async function getTripShares(id) {
	return await fetch(`${API_LOCATION}/trips/${id}/shares`).then(checkOk).then((x) => x.json());
}

export async function revokeTripShare(id, shareId) {
	await fetch(`${API_LOCATION}/trips/${id}/shares/${shareId}`, { method: "DELETE" }).then(checkOk);
}

// -> { trip_id, hash, route_idx }
export async function claimTripShare(token) {
	return await fetch(`${API_LOCATION}/trips/claim/${token}`, { method: "POST" })
		.then(checkOk)
		.then((x) => x.json());
}

// The planner page for a route, optionally with a saved trip applied.
export function routePageUrl(hash, routeIdx, tripId = null) {
	const url = `/route/${hash}/${routeIdx}`;
	return tripId ? `${url}?trip=${encodeURIComponent(tripId)}` : url;
}


// ---------------------------------------------------------------------------
// Client certificates
// ---------------------------------------------------------------------------

// The server's error messages are in English; these are the ones with
// something filled in, so t() can't match them whole.
const SERVER_ERRORS = [
	[/^Password must be (\d+)-(\d+) characters$/, "Password must be {1}-{2} characters"],
	[/^Trip names must be 1-(\d+) characters$/, "Trip names must be 1-{1} characters"],
	[/^invalid name "(.*)": use 1-32 of a-z, 0-9, '-' and '_'$/, "Invalid name \"{1}\": use 1-32 of a-z, 0-9, '-' and '_'"],
	[/^(.*) already has an active cert labelled "(.*)"$/, "{1} already has an active certificate named \"{2}\""],
];

function serverErrorText(text) {
	for (const [pattern, key] of SERVER_ERRORS) {
		const match = pattern.exec(text);
		if (match) return t(key, { ...match });
	}
	return t(text);
}

async function checkOk(response) {
	if (!response.ok) {
		// A 404 comes back as the HTML "not found" page; don't show that as text.
		const isHtml = response.headers.get("Content-Type")?.includes("text/html");
		const text = !isHtml && (await response.text());
		const error = new Error(text ? serverErrorText(text) : t("Request failed (HTTP {status})", { status: response.status }));
		error.status = response.status;
		throw error;
	}
	return response;
}

// POSTs a urlencoded form that answers with a .p12 and saves it.
export async function downloadP12(url, fields) {
	const response = await fetch(url, {
		method: "POST",
		body: new URLSearchParams(fields),
	}).then(checkOk);
	const name =
		/filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ??
		"carburantes.p12";
	const link = document.createElement("a");
	link.href = URL.createObjectURL(await response.blob());
	link.download = name;
	link.click();
	URL.revokeObjectURL(link.href);
	return name;
}

// [{ serial, label, issued_at, not_after, status, revoked_at, current }]
export async function getMyCerts() {
	return await fetch(API_LOCATION + "/user/certs").then(checkOk).then((x) => x.json());
}

export async function revokeMyCert(serial) {
	await fetch(`${API_LOCATION}/user/certs/${serial}/revoke`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ reason: "cessation_of_operation" }),
	}).then(checkOk);
}

export async function renewMyCert(password, password2, label) {
	return await downloadP12(API_LOCATION + "/user/cert/renew", { password, password2, label });
}

// [{ cn, roles, certs: [...] }]
export async function adminListUsers() {
	return await fetch(API_LOCATION + "/admin/users").then(checkOk).then((x) => x.json());
}

// -> { url, expires_at }
export async function adminCreateInvite(cn, label, admin = false) {
	return await fetch(API_LOCATION + "/admin/invites", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ cn, label, admin }),
	})
		.then(checkOk)
		.then((x) => x.json());
}

// [{ id, cn, label, created_by, created_at, expires_at }]
export async function adminListInvites() {
	return await fetch(API_LOCATION + "/admin/invites").then(checkOk).then((x) => x.json());
}

export async function adminCancelInvite(id) {
	await fetch(`${API_LOCATION}/admin/invites/${id}`, { method: "DELETE" }).then(checkOk);
}

export async function adminRevokeCert(serial, reason) {
	await fetch(`${API_LOCATION}/admin/certs/${serial}/revoke`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ reason }),
	}).then(checkOk);
}
