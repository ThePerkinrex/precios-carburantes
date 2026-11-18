// The dashboard's wholesale card: Spain's average pump price before taxes,
// the New York futures for the same fuel and Brent crude, all in €/L
// (/api/prices/wholesale). The gap between the first two is what the
// forecast calls the gap over wholesale.

import { t } from "./i18n.js";
import { formatDate } from "./dates.js";
import { timeAxis, gapSegment } from "./time_axis.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const RANGES = { "3m": 91, "1y": 365, "5y": 1826, all: null };
// Weekends and holidays have no futures; longer than this is missing data.
const MAX_GAP = 6 * DAY_MS;
const FUTURES = { gasolina_95: "gasolina", gasoleo_a: "gasoleo" };

const cache = new Map();
const state = { fuel: "gasolina_95", range: "1y" };
let chart;

const isoDay = (date) =>
	`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const parseDay = (text) => {
	const [y, m, d] = text.split("-").map(Number);
	return new Date(y, m - 1, d);
};

function fetchRange(range) {
	if (!cache.has(range)) {
		const days = RANGES[range];
		const query = days ? `?desde=${isoDay(new Date(Date.now() - days * DAY_MS))}` : "";
		cache.set(
			range,
			fetch(`/api/prices/wholesale${query}`).then((response) => {
				if (!response.ok) throw new Error(t("Couldn't load the wholesale prices."));
				return response.json();
			}),
		);
		cache.get(range).catch(() => cache.delete(range));
	}
	return cache.get(range);
}

function select(group, attr, current) {
	for (const button of group.querySelectorAll("button")) button.setAttribute("aria-checked", button.dataset[attr] === current);
}

// Sets the card up; `colors` are the fuels' line colours and `muted` Brent's.
export function initWholesale(card, { colors, muted }) {
	const fuelGroup = card.querySelector("#wholesaleFuel");
	const rangeGroup = card.querySelector("#wholesaleRange");
	const canvas = card.querySelector("canvas");
	let request = 0;

	async function draw() {
		select(fuelGroup, "fuel", state.fuel);
		select(rangeGroup, "range", state.range);
		const id = ++request;
		let days;
		try {
			days = await fetchRange(state.range);
		} catch {
			return;
		}
		if (id !== request) return;
		card.hidden = !days.some((d) => d[FUTURES[state.fuel]] != null);
		if (card.hidden) return;
		render(canvas, days, colors[state.fuel], muted);
	}

	fuelGroup.addEventListener("click", (event) => {
		const fuel = event.target.closest("button")?.dataset.fuel;
		if (!fuel) return;
		state.fuel = fuel;
		draw();
	});
	rangeGroup.addEventListener("click", (event) => {
		const range = event.target.closest("button")?.dataset.range;
		if (!range) return;
		state.range = range;
		draw();
	});
	draw();
}

function render(canvas, days, color, muted) {
	if (chart) chart.destroy();
	const fuel = state.fuel;
	const xs = days.map((d) => parseDay(d.fecha).getTime());
	const series = (label, value, style) => ({
		label,
		data: days.map((d, k) => ({ x: xs[k], y: value(d) ?? null })),
		borderWidth: 2,
		pointRadius: 0,
		pointHitRadius: 12,
		tension: 0,
		spanGaps: true,
		segment: gapSegment(MAX_GAP),
		...style,
	});
	const pump = series(t("Pump price before taxes"), (d) => d[`neto_${fuel}`], { borderColor: color, backgroundColor: color });
	const futures = series(t("New York futures"), (d) => d[FUTURES[fuel]], {
		borderColor: color,
		backgroundColor: color,
		borderDash: [6, 4],
	});
	const brent = series(t("Brent crude"), (d) => d.brent, { borderColor: muted, backgroundColor: muted, borderWidth: 1.5 });
	const datasets = [pump, futures, brent];
	const euros = (v) => `${v.toFixed(3)} €/L`;
	const days_ = RANGES[state.range];

	chart = new Chart(canvas, {
		type: "line",
		data: { datasets },
		options: {
			responsive: true,
			maintainAspectRatio: false,
			interaction: { mode: "index", intersect: false },
			plugins: {
				legend: { position: "top", align: "start", labels: { boxHeight: 2, boxWidth: 24 } },
				tooltip: {
					filter: (item) => item.parsed.y != null,
					callbacks: {
						title: (items) => formatDate(new Date(items[0].parsed.x)),
						label: (item) => `${item.dataset.label}: ${euros(item.parsed.y)}`,
						footer: (items) => {
							const k = items[0]?.dataIndex;
							const p = pump.data[k]?.y;
							const f = futures.data[k]?.y;
							return p != null && f != null ? t("Gap: {gap}", { gap: euros(p - f) }) : "";
						},
					},
				},
			},
			scales: {
				x: timeAxis({
					min: days_ ? Date.now() - days_ * DAY_MS : undefined,
					max: Date.now(),
					grid: { display: false },
					ticks: { autoSkipPadding: 16 },
				}),
				y: { ticks: { callback: (v) => `${v.toFixed(2)} €` } },
			},
		},
	});
}
