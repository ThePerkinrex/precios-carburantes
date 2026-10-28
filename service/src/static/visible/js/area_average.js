// How a station's prices compare with the average of the stations shown in
// its province (whatever the brand and stale filters leave on screen).

import { t } from "./i18n.js";

export const AVERAGE_FUELS = ["gasolina_95", "gasoleo_a"];
// Fewer stations than this make too shaky an average to compare with.
const MIN_STATIONS = 5;

// { [provincia]: { gasolina_95: { mean, n }, gasoleo_a: { mean, n } } }
export function provinceAverages(stations) {
	const sums = {};
	for (const s of stations) {
		if (!s.provincia) continue;
		const area = (sums[s.provincia] ??= Object.fromEntries(AVERAGE_FUELS.map((f) => [f, { sum: 0, n: 0 }])));
		for (const fuel of AVERAGE_FUELS) {
			if (s[fuel] == null) continue;
			area[fuel].sum += s[fuel];
			area[fuel].n++;
		}
	}
	const averages = {};
	for (const [provincia, area] of Object.entries(sums)) {
		averages[provincia] = Object.fromEntries(
			AVERAGE_FUELS.map((f) => [f, area[f].n >= MIN_STATIONS ? { mean: area[f].sum / area[f].n, n: area[f].n } : null]),
		);
	}
	return averages;
}

// The price's difference from the average in cents, or null without one.
export function centsFromAverage(price, average) {
	return price == null || !average ? null : (price - average.mean) * 100;
}

// A small "−2.3 c" badge (class cheaper / dearer / even), or "".
export function averageBadge(price, average, provincia) {
	const cents = centsFromAverage(price, average);
	if (cents == null) return "";
	const rounded = Math.round(cents * 10) / 10;
	const kind = rounded < 0 ? "cheaper" : rounded > 0 ? "dearer" : "even";
	const text = rounded === 0 ? "=" : `${rounded > 0 ? "+" : "−"}${Math.abs(rounded).toFixed(1)} c`;
	const title = t("{diff} €/L against the average of the {n} stations shown in {area} ({mean} €/L)", {
		diff: `${rounded > 0 ? "+" : rounded < 0 ? "−" : "±"}${(Math.abs(rounded) / 100).toFixed(3)}`,
		n: average.n,
		area: provincia,
		mean: average.mean.toFixed(3),
	});
	return `<span class="avg-badge ${kind}" title="${escapeAttr(title)}">${text}</span>`;
}

const escapeAttr = (text) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
