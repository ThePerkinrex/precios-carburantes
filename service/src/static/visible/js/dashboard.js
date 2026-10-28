import { getUserState } from "./api.js";
import { LOCALE, t } from "./i18n.js";
import { renderNav } from "./nav.js";
import { formatDate, formatDateTime, parseFecha } from "./dates.js";
import { formatEuros } from "./money.js";
import { gapSegment, timeAxis } from "./time_axis.js";
import { getPriceHistory, renderBoard } from "./price_board.js";
import { SETTLE_DAYS, TAXES_PAGE, anyCutBetween, loadFuelTaxes, nextTaxChange, settling, taxChanges, untaxedPrice } from "./fuel_taxes.js";

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
const taxBox = document.getElementById("taxBox");
const taxList = document.getElementById("taxList");
const taxNext = document.getElementById("taxNext");
const taxSummary = document.getElementById("taxSummary");
const outlookCard = document.getElementById("outlookCard");
const outlookTable = document.getElementById("outlookTable");

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_AREAS = 4;
// How far back each time window reaches, in days (null: everything).
const RANGES = { "7d": 7, "1m": 30, "3m": 91, "1y": 365, "5y": 1826, all: null };
// Long windows only get the last snapshot of each day or week: the history
// goes back to 2007, one snapshot a day before 09/03/2026.
const STEPS = { "5y": "day", all: "week" };
// Snapshots further apart than this (by step) are a gap in the data. Every
// download is at most 9 h apart, one a day before 09/03/2026.
const MAX_GAP_DAYS = { none: 2, day: 3, week: 15 };
// The chart shows the forecast on windows short enough to see its 14 days.
const FORECAST_RANGES = new Set(["7d", "1m", "3m"]);
// Gasoline minus diesel.
const spread = (g95, diesel) => (g95 == null || diesel == null ? null : g95 - diesel);
// `untaxed` is the value without the temporary tax cuts (see fuel_taxes.js).
const FUELS = {
	gasolina_95: { name: "Gasolina 95", value: (p) => p.gasolina_95, untaxed: (p) => untaxedPrice(p, "gasolina_95") },
	gasoleo_a: { name: "Gasóleo A", value: (p) => p.gasoleo_a, untaxed: (p) => untaxedPrice(p, "gasoleo_a") },
	spread: {
		name: t("Spread"),
		value: (p) => spread(p.gasolina_95, p.gasoleo_a),
		untaxed: (p) => spread(untaxedPrice(p, "gasolina_95"), untaxedPrice(p, "gasoleo_a")),
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
const MUTED = css("--muted");
const PAPER = css("--paper");
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
// Spain's forecasts by `downloader forecast`; none until it has run.
const forecastRequest = fetch("/api/prices/forecast")
	.then((response) => (response.ok ? response.json() : []))
	.catch(() => []);

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
		// Alphabetical, with accented names where they belong ("Ávila" by "Asturias").
		const byName = (a, b) => a.name.localeCompare(b.name, "es");
		geoData.ccaa.sort(byName);
		geoData.provincias.sort(byName);
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
		const request = getPriceHistory({ ...areaQuery(key), from, step: STEPS[range] });
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

// Phones start with the long extras folded; wider screens show them open.
if (window.matchMedia("(min-width: 720px)").matches) {
	for (const details of document.querySelectorAll("details.collapsible")) details.open = true;
}

// The forecast's table: each fuel's expected change and 80 % range, a row
// per horizon (two columns fit a phone).
function renderOutlook(forecasts) {
	outlookCard.hidden = !forecasts.length;
	if (!forecasts.length) return;
	const horizons = [...new Set(forecasts.map((f) => f.horizonte))].sort((a, b) => a - b);
	const fuels = Object.keys(FUELS).filter((fuel) => forecasts.some((f) => f.combustible === fuel));
	outlookTable.tHead.rows[0].replaceChildren(
		Object.assign(document.createElement("th"), { scope: "col", textContent: t("In") }),
		...fuels.map((fuel) => {
			const th = document.createElement("th");
			th.scope = "col";
			th.innerHTML = `<span class="swatch"></span><span></span>`;
			th.querySelector(".swatch").style.background = fuel === "gasolina_95" ? G95 : DIESEL;
			th.lastChild.textContent = FUELS[fuel].name;
			return th;
		}),
	);
	outlookTable.tBodies[0].replaceChildren(
		...horizons.map((h) => {
			const row = document.createElement("tr");
			const name = document.createElement("th");
			name.scope = "row";
			name.textContent = h === 1 ? t("1 day") : t("{n} days", { n: h });
			row.append(name);
			for (const fuel of fuels) {
				const f = forecasts.find((x) => x.combustible === fuel && x.horizonte === h);
				const cell = document.createElement("td");
				if (f) {
					const flat = Math.abs(f.cambio) < 0.0005;
					const change = document.createElement("span");
					change.className = `outlook-change ${flat ? "" : f.cambio > 0 ? "up" : "down"}`;
					change.textContent = flat ? t("No change") : `${f.cambio > 0 ? "▲" : "▼"} ${formatEuros(Math.abs(f.cambio))}`;
					const range = document.createElement("span");
					range.className = "outlook-range";
					range.textContent = `${formatEuros(f.bajo, { signed: true })} … ${formatEuros(f.alto, { signed: true })}`;
					cell.append(change, range);
				} else {
					cell.textContent = "–";
				}
				row.append(cell);
			}
			return row;
		}),
	);
}

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
		// The weekday pattern needs every snapshot, so long windows take it
		// from the last year.
		const [forecasts, weekdayHistory, ...histories] = await Promise.all([
			forecastRequest,
			STEPS[state.range] ? fetchHistory(activeArea().key, "1y") : null,
			...state.areas.map((a) => fetchHistory(a.key, state.range)),
		]);
		if (id !== requestId) return;
		const active = histories[state.active];
		renderBoard(board, active, areaName(activeArea().key), { baseline: "start" });
		renderChart(histories, forecasts);
		renderTable(histories);
		renderOutlook(forecasts);
		renderWeekdays(weekdayHistory ?? active);
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

const formatValue = (v, fuel) => (fuel === "spread" ? `${formatEuros(v)}/L` : `${v.toFixed(3)} €/L`);

// Draws each tax change in `markers` on the chart: a dashed line where it
// starts, numbered as in the list under the chart, and a shade over the days
// prices take to settle.
function taxMarkerPlugin(markers) {
	return {
		id: "taxMarkers",
		beforeDatasetsDraw(chart) {
			const { ctx, chartArea: area, scales: { x } } = chart;
			ctx.save();
			for (const m of markers) {
				const start = x.getPixelForValue(m.date.getTime());
				const settled = Math.min(x.getPixelForValue(m.settled), area.right);
				ctx.fillStyle = PAPER;
				ctx.fillRect(start, area.top, settled - start, area.bottom - area.top);
				ctx.strokeStyle = MUTED;
				ctx.lineWidth = 1;
				ctx.setLineDash([3, 3]);
				ctx.beginPath();
				ctx.moveTo(start, area.top);
				ctx.lineTo(start, area.bottom);
				ctx.stroke();
				ctx.fillStyle = MUTED;
				ctx.font = `600 11px ${css("--font")}`;
				ctx.textAlign = "center";
				ctx.textBaseline = "bottom";
				ctx.fillText(m.number, start, area.top - 2);
			}
			ctx.restore();
		},
	};
}

// The tax changes within the snapshots, as chart markers.
function taxMarkers(snapshots) {
	if (snapshots.length < 2) return [];
	const first = snapshots[0][1];
	const last = snapshots.at(-1)[1];
	return taxChanges()
		.filter((c) => c.date > first && c.date <= last)
		.map((c, i) => ({ ...c, number: i + 1, settled: c.date.getTime() + SETTLE_DAYS * DAY_MS }));
}

// Lists the changes on the chart, the one in force when it starts and the
// planned ones.
function renderTaxChanges(snapshots, markers) {
	const first = snapshots[0]?.[1] ?? new Date();
	const last = snapshots.at(-1)?.[1] ?? new Date();
	const changes = taxChanges();
	const inForce = changes.findLast((c) => c.date <= first);
	const items = [
		...(inForce && anyCutBetween(first, first) ? [{ ...inForce, since: true }] : []),
		...markers,
		...changes.filter((c) => c.planned && c.date > last),
	];
	const next = nextTaxChange();
	taxNext.hidden = !next;
	if (next) {
		taxNext.querySelector("strong").textContent = t("As it stands, from {date}:", { date: next.label });
		taxNext.querySelector("span").textContent = next.text;
	}
	taxBox.hidden = !items.length && !next;
	taxSummary.textContent = items.length ? t("Fuel tax changes ({n})", { n: items.length }) : t("Fuel tax changes");
	taxList.replaceChildren(
		...items.map((c) => {
			const li = document.createElement("li");
			li.innerHTML = `<span class="tax-number"></span><span class="tax-date"></span><span class="tax-text"></span>`;
			li.querySelector(".tax-number").textContent = c.number ?? "";
			li.querySelector(".tax-date").textContent = c.since
				? t("Since {date}", { date: c.label })
				: c.planned ? t("{date}, planned", { date: c.label }) : c.label;
			li.querySelector(".tax-text").textContent = c.text;
			return li;
		}),
	);
}

function renderChart(histories, forecasts) {
	if (fuelChart) fuelChart.destroy();

	const snapshots = snapshotLabels(histories);
	const maxGap = MAX_GAP_DAYS[STEPS[state.range] ?? "none"] * DAY_MS;
	const fuel = chartFuel();
	// The forecast goes on Spain's chart, from the end of its origin day.
	const showForecast =
		!comparing() && activeArea().key === "" && FORECAST_RANGES.has(state.range) && fuel !== "spread" && forecasts.length > 0;
	const shownForecasts = showForecast ? forecasts : [];
	const origin = shownForecasts.length ? parseFecha(`${shownForecasts[0].origen} 23:59:59`).getTime() : null;
	const horizons = [...new Set(shownForecasts.map((f) => f.horizonte))];
	const ahead = horizons.map((h) => origin + h * DAY_MS);
	// Every line has a point at each snapshot and each forecast target, so
	// the tooltip lines up by index.
	const line = (label, history, value, color) => {
		const byFecha = new Map(history.map((p) => [p.fecha, p]));
		return {
			label,
			group: label,
			data: [
				...snapshots.map(([fecha, date]) => {
					const point = byFecha.get(fecha);
					return { x: date.getTime(), y: point ? value(point) : null };
				}),
				...ahead.map((x) => ({ x, y: null })),
			],
			borderColor: color,
			backgroundColor: color,
			borderWidth: 2,
			pointRadius: 0,
			pointHitRadius: 12,
			tension: 0.2,
			// Joins across an area's missing points, but not across a
			// stretch without snapshots.
			spanGaps: true,
			segment: gapSegment(maxGap),
		};
	};
	// Each line, followed by a dashed one without the tax cuts where they
	// change anything.
	const lines = (label, history, fuel, color) => {
		const solid = line(label, history, FUELS[fuel].value, color);
		const dashed = line(t("{name} without tax cuts", { name: label }), history, FUELS[fuel].untaxed, color);
		const lines = [...forecastLines(label, history, fuel, color)];
		if (dashed.data.every(({ y }, i) => y == null || Math.abs(y - solid.data[i].y) < 1e-9)) return [solid, ...lines];
		return [solid, { ...dashed, group: label, borderWidth: 1.5, borderDash: [6, 4], untaxed: true }, ...lines];
	};
	// The forecast as a dotted line from the latest price, over its 80 % range.
	const forecastLines = (label, history, fuel, color) => {
		const rows = shownForecasts.filter((f) => f.combustible === fuel);
		const latest = history.findLast((p) => p[fuel] != null);
		if (!rows.length || !latest) return [];
		const anchor = snapshots.findIndex(([fecha]) => fecha === latest.fecha);
		const points = (change) => [
			...snapshots.map(([, date], k) => ({ x: date.getTime(), y: k === anchor ? latest[fuel] : null })),
			...ahead.map((x, k) => {
				const row = rows.find((r) => r.horizonte === horizons[k]);
				return { x, y: row ? latest[fuel] + change(row) : null };
			}),
		];
		const shared = { group: label, spanGaps: true, pointRadius: 0, pointHitRadius: 12, tension: 0, forecast: true };
		const low = points((r) => r.bajo);
		const high = points((r) => r.alto);
		return [
			{
				...shared,
				label: t("{name} forecast", { name: label }),
				data: points((r) => r.cambio),
				range: low.map((p, k) => (p.y == null ? null : [p.y, high[k].y])),
				borderColor: color,
				backgroundColor: color,
				borderWidth: 2,
				borderDash: [2, 4],
				pointRadius: (ctx) => (ctx.dataIndex >= snapshots.length ? 3 : 0),
			},
			{ ...shared, band: true, data: low, borderWidth: 0, backgroundColor: "transparent" },
			{ ...shared, band: true, data: high, borderWidth: 0, backgroundColor: `${color}26`, fill: "-1" },
		];
	};

	let datasets;
	if (comparing()) {
		datasets = state.areas.flatMap((a, i) => lines(areaName(a.key), histories[i], fuel, SERIES[a.slot]));
		chartTitle.textContent = fuel === "spread"
			? t("Gasolina 95 minus Gasóleo A, by area")
			: t("{fuel}, by area", { fuel: FUELS[fuel].name });
	} else if (fuel === "both") {
		datasets = [
			...lines("Gasolina 95", histories[0], "gasolina_95", G95),
			...lines("Gasóleo A", histories[0], "gasoleo_a", DIESEL),
		];
		chartTitle.textContent = t("Average price over time");
	} else {
		const color = { gasolina_95: G95, gasoleo_a: DIESEL, spread: INK }[fuel];
		datasets = lines(FUELS[fuel].name, histories[0], fuel, color);
		chartTitle.textContent = fuel === "spread"
			? t("Gasolina 95 minus Gasóleo A")
			: t("{fuel} over time", { fuel: FUELS[fuel].name });
	}
	const valueFuel = fuel === "spread" ? "spread" : "price";
	const solidCount = datasets.filter((d) => !d.untaxed && !d.forecast).length;
	const markers = taxMarkers(snapshots);
	renderTaxChanges(snapshots, markers);

	fuelChart = new Chart(document.getElementById("historyChart"), {
		type: "line",
		data: { datasets },
		plugins: [taxMarkerPlugin(markers)],
		options: {
			responsive: true,
			maintainAspectRatio: false,
			interaction: { mode: "index", intersect: false },
			// Room for the markers' numbers, and for the last forecast point.
			layout: { padding: { top: markers.length ? 16 : 0, right: ahead.length ? 6 : 0 } },
			plugins: {
				// A single line is named by the title. Dashed lines and the
				// forecast go with their solid line, which toggles them too.
				legend: {
					display: solidCount > 1,
					position: "top",
					align: "start",
					labels: {
						usePointStyle: true,
						pointStyle: "rectRounded",
						boxHeight: 10,
						filter: (item, data) => !data.datasets[item.datasetIndex].untaxed && !data.datasets[item.datasetIndex].forecast,
					},
					onClick: (event, item, legend) => {
						const chart = legend.chart;
						const visible = !chart.isDatasetVisible(item.datasetIndex);
						const group = chart.data.datasets[item.datasetIndex].group;
						chart.data.datasets.forEach((d, i) => d.group === group && chart.setDatasetVisibility(i, visible));
						chart.update();
					},
				},
				tooltip: {
					filter: (item) => !item.dataset.band && !(item.dataset.forecast && item.dataIndex < snapshots.length),
					callbacks: {
						title: (items) => {
							const date = new Date(items[0].parsed.x);
							return STEPS[state.range] || items[0].dataIndex >= snapshots.length ? formatDate(date) : formatDateTime(date);
						},
						label: (item) => {
							const range = item.dataset.range?.[item.dataIndex];
							const text = `${item.dataset.label}: ${formatValue(item.parsed.y, fuel)}`;
							return range ? `${text} (${range[0].toFixed(3)}–${range[1].toFixed(3)})` : text;
						},
					},
				},
			},
			scales: {
				// The whole window, so missing data at either end shows too.
				x: timeAxis({
					min: RANGES[state.range] ? Date.now() - RANGES[state.range] * DAY_MS : undefined,
					max: ahead.length ? Math.max(...ahead) : RANGES[state.range] ? Date.now() : undefined,
					grid: { display: false },
					ticks: { autoSkipPadding: 16 },
				}),
				y: { ticks: { callback: (v) => (valueFuel === "spread" ? formatEuros(v) : `${v.toFixed(2)} €`) } },
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
	const change = (v) => formatEuros(v, { signed: true });
	const latest = (history) => history.findLast((p) => value(p) != null);
	const first = histories[0] && latest(histories[0]);

	compareTable.tHead.rows[0].cells[1].textContent = t("Now ({unit})", { unit: "€/L" });
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
				row.cells[1].textContent = value(now).toLocaleString(LOCALE, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
				row.cells[2].textContent = start !== now ? change(value(now) - value(start)) : "–";
				row.cells[3].textContent = i > 0 && first ? change(value(now) - value(first)) : "–";
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
				? formatEuros(value(r))
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
// them, in euros: the trend cancels out and the weekly pattern remains.
// Tax changes would show up as jumps, so `value` should undo the cuts, and
// weeks where prices were still settling after one are left out.
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
		if (settling(new Date(p.t), { before: half, after: half })) continue;
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
	if (STEPS[state.range]) weekdayNote.append(` ${t("Over the last year.")}`);
	if (history.length && anyCutBetween(history[0].date, history.at(-1).date)) {
		const link = document.createElement("a");
		link.href = TAXES_PAGE;
		link.textContent = t("temporary tax cuts");
		// The link goes where {link} is in the translated sentence.
		const [before, after] = t("Prices are taken without the {link}, leaving out the weeks around each change.").split("{link}");
		weekdayNote.append(` ${before}`, link, after);
	}

	const fuel = chartFuel();
	const bars = (label, key, color) => ({
		label,
		data: weekdayDeviations(history, FUELS[key].untaxed),
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
						label: (item) => `${item.dataset.label}: ${formatEuros(item.parsed.y, { signed: true, max: 4 })}`,
					},
				},
			},
			scales: {
				x: { grid: { display: false } },
				// Differences are often under a cent, so up to four decimals.
				y: { ticks: { callback: (v) => formatEuros(v, { max: 4 }) } },
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
// The safeguard clauses settle once INE's CPI is in; until then the known
// figures stand.
loadFuelTaxes()
	.then(update)
	.catch((err) => console.error("Failed to load the fuel CPI:", err));
