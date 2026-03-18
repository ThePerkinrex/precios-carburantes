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
