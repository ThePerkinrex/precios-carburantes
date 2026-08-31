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

