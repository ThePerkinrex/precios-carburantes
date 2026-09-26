import { mapFilterToArray, mapFilterToString } from "./filter.js";

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
	return await fetch(`${API_LOCATION}/route/${hash}/${idx}/prices?${params}`).then((x) => x.json());
}


// ---------------------------------------------------------------------------
// Client certificates
// ---------------------------------------------------------------------------

async function checkOk(response) {
	if (!response.ok) {
		throw new Error((await response.text()) || `HTTP ${response.status}`);
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
