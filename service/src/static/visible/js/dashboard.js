import { getUserState } from "./api.js";
import { LOCALE, t } from "./i18n.js";
import { renderNav } from "./nav.js";
import { formatDate, formatDateTime } from "./dates.js";
import { getPriceHistory, renderBoard } from "./price_board.js";

const ccaaSelect = document.getElementById("ccaaSelect");
const provSelect = document.getElementById("provinciaSelect");
const board = document.getElementById("board");
const chipList = document.getElementById("areaChips");
const compareButton = document.getElementById("compareButton");
const compareHint = document.getElementById("compareHint");
const rangeGroup = document.getElementById("rangeGroup");
const fuelGroup = document.getElementById("fuelGroup");
const chartTitle = document.getElementById("chartTitle");
const compareTable = document.getElementById("compareTable");
const rankingTitle = document.getElementById("rankingTitle");
const rankingList = document.getElementById("ranking");
const rankingNote = document.getElementById("rankingNote");
const weekdayNote = document.getElementById("weekdayNote");
const weekdayBox = document.getElementById("weekdayBox");

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_AREAS = 4;
// How far back each time window reaches, in days (null: everything).
const RANGES = { "7d": 7, "1m": 30, "3m": 91, "1y": 365, all: null };
const FUELS = {
	gasolina_95: { name: "Gasolina 95", value: (p) => p.gasolina_95 },
	gasoleo_a: { name: "Gasóleo A", value: (p) => p.gasoleo_a },
	// Gasoline minus diesel, in cents.
	spread: {
		name: t("Spread"),
		value: (p) => (p.gasolina_95 == null || p.gasoleo_a == null ? null : (p.gasolina_95 - p.gasoleo_a) * 100),
	},
};
// Monday first. 2024-01-01 was a Monday.
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6].map((d) =>
	new Date(2024, 0, 1 + d).toLocaleDateString(LOCALE, { weekday: "short" }),
);

// Same colours as the board's nozzle chips (see app.css); compared areas
// take the --series-* colours, one per slot.
const style = getComputedStyle(document.documentElement);
const css = (name) => style.getPropertyValue(name).trim();
const G95 = css("--g95");
const DIESEL = css("--diesel");
const INK = css("--ink");
const SERIES = [1, 2, 3, 4].map((n) => css(`--series-${n}`));
Chart.defaults.font.family = css("--font");
Chart.defaults.color = css("--muted");

let fuelChart;
let weekdayChart;
let geoData = { ccaa: [], provincias: [] };
// Only the latest request gets to draw, so fast filter changes can't race.
let requestId = 0;
const historyCache = new Map();
const rankingCache = new Map();

// Areas are keyed "" (Spain), "c:<region id>" or "p:<province id>". Each
// keeps its colour slot while others come and go. The selects edit the
// active area. Everything but `active` is mirrored in the URL.
const state = { areas: [{ key: "", slot: 0 }], active: 0, fuel: "both", range: "3m" };

// ---------- Areas ----------

function areaQuery(key) {
	if (key.startsWith("c:")) return { ccaa: key.slice(2) };
	if (key.startsWith("p:")) return { provincia: key.slice(2) };
	return {};
}

function areaName(key) {
	if (key.startsWith("c:")) return geoData.ccaa.find((c) => c.id === key.slice(2))?.name;
	if (key.startsWith("p:")) return geoData.provincias.find((p) => p.id === key.slice(2))?.name;
	return t("Spain");
}

// The region an area is in, or "" for Spain.
function areaRegion(key) {
	if (key.startsWith("c:")) return key.slice(2);
	if (key.startsWith("p:")) return geoData.provincias.find((p) => p.id === key.slice(2))?.ccaa ?? "";
	return "";
}

const activeArea = () => state.areas[state.active];
const comparing = () => state.areas.length > 1;
// "Both" draws one line per fuel, so it only fits a single area.
const chartFuel = () => (comparing() && state.fuel === "both" ? "gasolina_95" : state.fuel);

function freeSlot() {
	const used = new Set(state.areas.map((a) => a.slot));
	return [0, 1, 2, 3].find((s) => !used.has(s));
}

// Adds `key` as a new compared area (or activates it, if it's there).
function addArea(key) {
	const existing = state.areas.findIndex((a) => a.key === key);
	if (existing >= 0) {
		state.active = existing;
	} else if (state.areas.length < MAX_AREAS) {
		state.areas.push({ key, slot: freeSlot() });
		state.active = state.areas.length - 1;
	} else {
		activeArea().key = key;
	}
}

// The selects changed: the active area becomes what they show. If another
// chip already has that area, it's merged into the active one.
function setActiveKey(key) {
	const duplicate = state.areas.findIndex((a, i) => a.key === key && i !== state.active);
	if (duplicate >= 0) {
		state.areas.splice(duplicate, 1);
		if (duplicate < state.active) state.active--;
	}
	activeArea().key = key;
}

// ---------- URL ----------

function readUrl() {
	const params = new URLSearchParams(location.search);
	const valid = (key) => key === "" || areaName(key) !== undefined;
	const keys = [...new Set(params.getAll("area").filter(valid))].slice(0, MAX_AREAS);
	if (keys.length) state.areas = keys.map((key, slot) => ({ key, slot }));
	if (params.get("fuel") in FUELS || params.get("fuel") === "both") state.fuel = params.get("fuel");
	if (params.get("range") in RANGES) state.range = params.get("range");
}

function writeUrl() {
	const params = new URLSearchParams();
	for (const a of state.areas) params.append("area", a.key);
	params.set("fuel", state.fuel);
	params.set("range", state.range);
	history.replaceState(null, "", `?${params}`);
}

// ---------- Controls ----------

async function loadFilters() {
	try {
		const response = await fetch("/api/geo/filter");
		geoData = await response.json();
		for (const c of geoData.ccaa) ccaaSelect.add(new Option(c.name, c.id));
	} catch (err) {
		console.error("Failed to load filters:", err);
	}
}

// All provinces, or only those of the selected region.
function populateProvincias(ccaaId) {
	provSelect.replaceChildren(new Option(t("All provinces"), ""));
	for (const p of geoData.provincias) {
		if (!ccaaId || p.ccaa === ccaaId) provSelect.add(new Option(p.name, p.id));
	}
}

// Points the selects at the active area.
function syncSelects() {
	const key = activeArea().key;
	ccaaSelect.value = areaRegion(key);
	populateProvincias(ccaaSelect.value);
	provSelect.value = key.startsWith("p:") ? key.slice(2) : "";
}

function renderChips() {
	chipList.hidden = !comparing();
	chipList.replaceChildren(
		...state.areas.map((area, i) => {
			const li = document.createElement("li");
			li.className = "chip";
			li.style.setProperty("--swatch", SERIES[area.slot]);
			li.innerHTML = `<button type="button" class="chip-name"></button><button type="button" class="chip-remove">✕</button>`;
			const name = li.querySelector(".chip-name");
			name.textContent = areaName(area.key);
			name.setAttribute("aria-pressed", i === state.active);
			name.addEventListener("click", () => {
				state.active = i;
				update();
			});
			const remove = li.querySelector(".chip-remove");
			remove.setAttribute("aria-label", t("Stop comparing {area}", { area: areaName(area.key) }));
			remove.addEventListener("click", () => {
				state.areas.splice(i, 1);
				if (state.active >= i) state.active = Math.max(0, state.active - 1);
				update();
			});
			return li;
		}),
	);
	compareButton.disabled = state.areas.length >= MAX_AREAS;
	compareHint.hidden = !comparing();
}

function renderSegmented(group, attr, current, hidden = () => false) {
	for (const button of group.querySelectorAll("button")) {
		button.setAttribute("aria-checked", button.dataset[attr] === current);
		button.hidden = hidden(button.dataset[attr]);
	}
}

// ---------- Data ----------

function fetchHistory(key, range) {
	const cacheKey = `${key}|${range}`;
	if (!historyCache.has(cacheKey)) {
		const days = RANGES[range];
		const from = days ? new Date(Date.now() - days * DAY_MS) : undefined;
		const request = getPriceHistory({ ...areaQuery(key), from });
		// A failed request shouldn't stick in the cache.
		request.catch(() => historyCache.delete(cacheKey));
		historyCache.set(cacheKey, request);
	}
	return historyCache.get(cacheKey);
}

function fetchRanking(ccaa) {
	if (!rankingCache.has(ccaa)) {
		const params = new URLSearchParams();
		if (ccaa) params.set("ccaa_id", ccaa);
		const request = fetch(`/api/prices/provinces?${params}`).then((response) => {
			if (!response.ok) throw new Error(t("Couldn't load provinces (HTTP {status}).", { status: response.status }));
			return response.json();
		});
		request.catch(() => rankingCache.delete(ccaa));
		rankingCache.set(ccaa, request);
	}
	return rankingCache.get(ccaa);
}

// ---------- Rendering ----------

async function update() {
	const id = ++requestId;
	writeUrl();
	syncSelects();
	renderChips();
	renderSegmented(rangeGroup, "range", state.range);
	renderSegmented(fuelGroup, "fuel", chartFuel(), (fuel) => fuel === "both" && comparing());

	const region = areaRegion(activeArea().key);
	fetchRanking(region)
		.then((rows) => id === requestId && renderRanking(rows, region))
		.catch((err) => id === requestId && showRankingError(err));

	try {
		const histories = await Promise.all(state.areas.map((a) => fetchHistory(a.key, state.range)));
		if (id !== requestId) return;
		const active = histories[state.active];
		renderBoard(board, active, areaName(activeArea().key), { baseline: "start" });
		renderChart(histories);
		renderTable(histories);
		renderWeekdays(active);
	} catch (err) {
		if (id !== requestId) return;
		board.innerHTML = `<p class="board-empty"></p>`;
		board.firstChild.textContent = err.message;
	}
}

// Every snapshot any of the histories has, oldest first.
function snapshotLabels(histories) {
	const byFecha = new Map();
	for (const history of histories) for (const p of history) byFecha.set(p.fecha, p.date);
	return [...byFecha].sort((a, b) => a[1] - b[1]);
}

const unitFor = (fuel) => (fuel === "spread" ? t("cents") : "€/L");
const formatValue = (v, fuel) => (fuel === "spread" ? `${v.toFixed(1)} c` : `${v.toFixed(3)} €/L`);

function renderChart(histories) {
	if (fuelChart) fuelChart.destroy();

	const snapshots = snapshotLabels(histories);
	const line = (label, history, value, color) => {
		const byFecha = new Map(history.map((p) => [p.fecha, p]));
		return {
			label,
			data: snapshots.map(([fecha]) => {
				const point = byFecha.get(fecha);
				return point ? value(point) : null;
			}),
			borderColor: color,
			backgroundColor: color,
			borderWidth: 2,
			pointRadius: 0,
			pointHitRadius: 12,
			tension: 0.2,
			spanGaps: true,
		};
	};

	const fuel = chartFuel();
	let datasets;
	if (comparing()) {
		datasets = state.areas.map((a, i) => line(areaName(a.key), histories[i], FUELS[fuel].value, SERIES[a.slot]));
		chartTitle.textContent = fuel === "spread"
			? t("Gasolina 95 minus Gasóleo A, by area")
			: t("{fuel}, by area", { fuel: FUELS[fuel].name });
	} else if (fuel === "both") {
		datasets = [
			line("Gasolina 95", histories[0], FUELS.gasolina_95.value, G95),
			line("Gasóleo A", histories[0], FUELS.gasoleo_a.value, DIESEL),
		];
		chartTitle.textContent = t("Average price over time");
	} else {
		const color = { gasolina_95: G95, gasoleo_a: DIESEL, spread: INK }[fuel];
		datasets = [line(FUELS[fuel].name, histories[0], FUELS[fuel].value, color)];
		chartTitle.textContent = fuel === "spread"
			? t("Gasolina 95 minus Gasóleo A")
			: t("{fuel} over time", { fuel: FUELS[fuel].name });
	}
	const valueFuel = fuel === "spread" ? "spread" : "price";

	fuelChart = new Chart(document.getElementById("historyChart"), {
		type: "line",
		data: { labels: snapshots.map(([, date]) => formatDate(date)), datasets },
		options: {
			responsive: true,
			maintainAspectRatio: false,
			interaction: { mode: "index", intersect: false },
			plugins: {
				// A single line is named by the title.
				legend: {
					display: datasets.length > 1,
					position: "top",
					align: "start",
					labels: { usePointStyle: true, pointStyle: "rectRounded", boxHeight: 10 },
				},
				tooltip: {
					callbacks: {
						title: (items) => formatDateTime(snapshots[items[0].dataIndex][1]),
						label: (item) => `${item.dataset.label}: ${formatValue(item.parsed.y, fuel)}`,
					},
				},
			},
			scales: {
				x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 16 } },
				y: { ticks: { callback: (v) => (valueFuel === "spread" ? `${v.toFixed(1)} c` : `${v.toFixed(2)} €`) } },
			},
		},
	});
}

// One row per compared area: the latest value, its change over the window
// and its difference from the first area. Also the chart's table view.
function renderTable(histories) {
	compareTable.hidden = !comparing();
	if (!comparing()) return;

	const fuel = chartFuel();
	const value = FUELS[fuel].value;
	const toUnit = (v) => (fuel === "spread" ? v : v * 100);
	const cents = (v) => `${v > 0 ? "+" : ""}${v.toLocaleString(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} c`;
	const latest = (history) => history.findLast((p) => value(p) != null);
	const first = histories[0] && latest(histories[0]);

	compareTable.tHead.rows[0].cells[1].textContent = t("Now ({unit})", { unit: unitFor(fuel) });
	compareTable.tHead.rows[0].cells[3].textContent = t("vs {area}", { area: areaName(state.areas[0].key) });
	compareTable.tBodies[0].replaceChildren(
		...state.areas.map((area, i) => {
			const history = histories[i];
			const now = latest(history);
			const start = history.find((p) => value(p) != null);
			const row = document.createElement("tr");
			row.innerHTML = `<th scope="row"><span class="swatch"></span><span></span></th><td></td><td></td><td></td>`;
			row.querySelector(".swatch").style.background = SERIES[area.slot];
			row.cells[0].lastChild.textContent = areaName(area.key);
			if (now) {
				row.cells[1].textContent = fuel === "spread"
					? value(now).toFixed(1)
					: value(now).toLocaleString(LOCALE, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
				row.cells[2].textContent = start !== now ? cents(toUnit(value(now) - value(start))) : "–";
				row.cells[3].textContent = i > 0 && first ? cents(toUnit(value(now) - value(first))) : "–";
			} else {
				row.cells[1].textContent = t("No data");
			}
			return row;
		}),
	);
}

function renderRanking(rows, region) {
	const fuel = chartFuel() === "both" ? "gasolina_95" : chartFuel();
	const value = FUELS[fuel].value;
	const where = region ? geoData.ccaa.find((c) => c.id === region)?.name : t("Spain");
	rankingTitle.textContent = t("{fuel} by province, {where}", { fuel: FUELS[fuel].name, where });
	rankingNote.textContent = fuel === "spread"
		? t("Gasolina 95 minus Gasóleo A, lowest first. Tap one to compare it.")
		: t("Cheapest first. Tap one to compare it.");

	const ranked = rows.filter((r) => value(r) != null).sort((a, b) => value(a) - value(b));
	if (!ranked.length) {
		rankingList.innerHTML = `<li class="card-note"></li>`;
		rankingList.firstChild.textContent = t("No prices right now.");
		return;
	}
	const min = value(ranked[0]);
	const spanOf = value(ranked.at(-1)) - min || 1;
	const compared = new Set(state.areas.map((a) => a.key));

	rankingList.replaceChildren(
		...ranked.map((r) => {
			const key = `p:${r.id_provincia}`;
			const li = document.createElement("li");
			li.innerHTML = `<button type="button"><span class="name"></span><span class="value"></span><span class="bar"></span></button>`;
			const button = li.firstChild;
			button.querySelector(".name").textContent = areaName(key) ?? r.id_provincia;
			button.querySelector(".value").textContent = fuel === "spread"
				? `${value(r).toFixed(1)} c`
				: value(r).toLocaleString(LOCALE, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
			button.querySelector(".bar").style.setProperty("--fill", `${8 + (92 * (value(r) - min)) / spanOf}%`);
			button.title = t("{n} stations", { n: r.estaciones });
			if (compared.has(key)) button.setAttribute("aria-current", "true");
			button.addEventListener("click", () => {
				addArea(key);
				update();
			});
			return li;
		}),
	);
}

function showRankingError(err) {
	rankingList.innerHTML = `<li class="card-note"></li>`;
	rankingList.firstChild.textContent = err.message;
}

// For each weekday, how far prices sit from the centred 7-day average around
// them, in cents: the trend cancels out and the weekly pattern remains.
function weekdayDeviations(history, value) {
	const points = history.filter((p) => value(p) != null).map((p) => ({ t: p.date.getTime(), v: value(p), day: p.date.getDay() }));
	const sums = new Array(7).fill(0);
	const counts = new Array(7).fill(0);
	if (!points.length) return sums;
	const half = 3.5 * DAY_MS;
	const firstT = points[0].t;
	const lastT = points.at(-1).t;
	let lo = 0;
	let hi = 0;
	let windowSum = 0;
	for (const p of points) {
		while (hi < points.length && points[hi].t <= p.t + half) windowSum += points[hi++].v;
		while (points[lo].t < p.t - half) windowSum -= points[lo++].v;
		// Only points with a full week around them.
		if (p.t - half < firstT || p.t + half > lastT) continue;
		const mean = windowSum / (hi - lo);
		sums[p.day] += p.v - mean;
		counts[p.day]++;
	}
	// Sunday is getDay() 0; the chart starts on Monday.
	const byDay = sums.map((s, d) => (counts[d] ? s / counts[d] : null));
	return [...byDay.slice(1), byDay[0]];
}

function renderWeekdays(history) {
	if (weekdayChart) weekdayChart.destroy();
	weekdayChart = undefined;

	const tooShort = RANGES[state.range] !== null && RANGES[state.range] < 90;
	weekdayBox.hidden = tooShort;
	weekdayNote.textContent = tooShort
		? t("Choose 3M or longer to see which weekdays are cheaper.")
		: t("Price on each weekday compared with the average of the week around it. Below zero is cheaper.");
	if (tooShort) return;

	const fuel = chartFuel();
	const toCents = fuel === "spread" ? (v) => v : (v) => v * 100;
	const bars = (label, key, color) => ({
		label,
		data: weekdayDeviations(history, (p) => {
			const v = FUELS[key].value(p);
			return v == null ? null : toCents(v);
		}),
		backgroundColor: color,
		borderRadius: 4,
		borderSkipped: "start",
		maxBarThickness: 28,
	});
	const datasets = fuel === "both"
		? [bars("Gasolina 95", "gasolina_95", G95), bars("Gasóleo A", "gasoleo_a", DIESEL)]
		: [bars(FUELS[fuel].name, fuel, { gasolina_95: G95, gasoleo_a: DIESEL, spread: INK }[fuel])];

	weekdayChart = new Chart(document.getElementById("weekdayChart"), {
		type: "bar",
		data: { labels: WEEKDAYS, datasets },
		options: {
			responsive: true,
			maintainAspectRatio: false,
			interaction: { mode: "index", intersect: false },
			plugins: {
				legend: {
					display: datasets.length > 1,
					position: "top",
					align: "start",
					labels: { usePointStyle: true, pointStyle: "rectRounded", boxHeight: 10 },
				},
				tooltip: {
					callbacks: {
						label: (item) =>
							`${item.dataset.label}: ${t("{amount} cents", { amount: `${item.parsed.y > 0 ? "+" : ""}${item.parsed.y.toFixed(2)}` })}`,
					},
				},
			},
			scales: {
				x: { grid: { display: false } },
				// Differences are often under a cent, so no fixed rounding.
				y: { ticks: { callback: (v) => `${+v.toFixed(2)} c` } },
			},
		},
	});
}

// ---------- Events ----------

ccaaSelect.addEventListener("change", () => {
	setActiveKey(ccaaSelect.value ? `c:${ccaaSelect.value}` : "");
	update();
});
provSelect.addEventListener("change", () => {
	setActiveKey(provSelect.value ? `p:${provSelect.value}` : ccaaSelect.value ? `c:${ccaaSelect.value}` : "");
	update();
});
compareButton.addEventListener("click", () => {
	// Start the new area from the active one's region, so picking a
	// neighbouring province is one change away.
	const region = areaRegion(activeArea().key);
	const candidates = [region ? `c:${region}` : "", "", ...geoData.ccaa.map((c) => `c:${c.id}`)];
	const taken = new Set(state.areas.map((a) => a.key));
	addArea(candidates.find((key) => !taken.has(key)));
	update();
});
rangeGroup.addEventListener("click", (event) => {
	const range = event.target.closest("button")?.dataset.range;
	if (!range) return;
	state.range = range;
	update();
});
fuelGroup.addEventListener("click", (event) => {
	const fuel = event.target.closest("button")?.dataset.fuel;
	if (!fuel) return;
	state.fuel = fuel;
	update();
});

getUserState().then((s) => renderNav(document.getElementById("nav"), s, "dashboard"));
await loadFilters();
readUrl();
update();
