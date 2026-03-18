import { getLogos } from "./logos.js";

async function getLogoKeys() {
	let logos = await getLogos();
	let keys = new Set(Object.keys(logos));
	keys.add("other");
	return keys;
}

export async function mapFilterToArray(filter) {
	let keys = await getLogoKeys();
	if (filter == "all") {
		return keys;
	}
	let split = new Set(filter.split(","));
	return keys.intersection(split);
}

export async function mapFilterToString(filter) {
	let keys = await getLogoKeys();
	let intersection = keys.intersection(filter);

	if (intersection.size === keys.size) {
		return "all";
	} else {
		return [...intersection].join(",");
	}
}
