// "My stations": the saved stations' prices against their province's
// average, their history (together and one by one), their price alerts, and
// the hidden ones.

import { deleteAlert, getAlerts, getChannels, getLatestPrices, getUserState, putAlert } from "./api.js";
import { averageBadge, provinceAverages } from "./area_average.js";
import { formatDateTime, parseFecha } from "./dates.js";
import { LOCALE, t, tn } from "./i18n.js";
import { getLogos } from "./logos.js";
import { MyStations } from "./my_stations.js";
import { renderNav } from "./nav.js";
import {
	DIESEL_COLOR,
	G95_COLOR,
	advice,
	escapeHtml,
	forecastsFor,
	formatPrice,
	getLogoKey,
	loadHideStale,
	logoBadge,
	priceDigits,
	rebuildHistory,
	sortLogos,
	staleSince,
	staleWarning,
} from "./stations.js";
import { gapSegment, timeAxis } from "./time_axis.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// The categorical palette (app.css) has eight colours: one per station on the chart.
const MAX_ON_CHART = 8;

const FUELS = {
	gasolina_95: { name: "Gasolina 95", className: "g95", color: G95_COLOR },
	gasoleo_a: { name: "Gasóleo A", className: "diesel", color: DIESEL_COLOR },
};

const style = getComputedStyle(document.documentElement);
const SERIES = Array.from({ length: MAX_ON_CHART }, (_, i) => style.getPropertyValue(`--series-${i + 1}`).trim());

const message = document.getElementById("message");
const fuelGroup = document.getElementById("fuelGroup");
const rangeGroup = document.getElementById("rangeGroup");
const chartCard = document.getElementById("chartCard");
const chartNote = document.getElementById("chartNote");
const legend = document.getElementById("legend");
const savedList = document.getElementById("saved");
const hiddenCard = document.getElementById("hiddenCard");
const hiddenList = document.getElementById("hidden");

const view = { fuel: "gasolina_95", range: 30 };
let mine = null;
let logos = null;
let logosSorted = null;
// Province averages over what the map would show, once every price is in.
let averages = null;
// Station id -> its colour's index, for the stations on the chart.
const slots = new Map();
// The ones the user took off the chart.
const dropped = new Set();
// The user's price alerts, and whether any device gets them (null: unknown).
let alerts = [];
let hasDevice = null;
// Stations whose alerts are open, so they stay open when the list is redrawn.
const alertsOpen = new Set();
// The server's limit on alerts per user.
const MAX_ALERTS = 50;

const saved = () => mine.ids("saved").map((id) => mine.get(id));
const hidden = () => mine.ids("hidden").map((id) => mine.get(id));

// Nickname, or brand and town, so two stations of a brand can be told apart.
function shortName(s) {
	return s.nickname ?? `${s.rotulo} · ${s.localidad ?? s.municipio ?? ""}`;
}

// ---------------------------------------------------------------------------
// History, fetched once per station and window
// ---------------------------------------------------------------------------

const histories = new Map();

function historyOf(id, days) {
	const key = `${id}:${days}`;
	if (!histories.has(key)) {
		const from = new Date(Date.now() - days * DAY_MS);
		const request = fetch(`/api/${id}/history?${new URLSearchParams({ from: from.toISOString() })}`)
			.then((r) => {
				if (!r.ok) throw new Error(t("Request failed (HTTP {status})", { status: r.status }));
				return r.json();
			})
			.then(({ snapshots, changes }) => rebuildHistory(snapshots, changes));
		// A failure can be retried by changing the window.
		request.catch(() => histories.delete(key));
		histories.set(key, request);
	}
	return histories.get(key);
}

function chartOptions(from, legendLabel) {
	return {
		responsive: true,
		maintainAspectRatio: false,
		animation: false,
		interaction: { mode: "index", intersect: false },
		plugins: {
			legend: { display: false },
			tooltip: {
				itemSort: (a, b) => (a.parsed.y ?? Infinity) - (b.parsed.y ?? Infinity),
				callbacks: {
					title: (items) => formatDateTime(new Date(items[0].parsed.x)),
					label: (ctx) => (ctx.parsed.y == null ? null : `${legendLabel(ctx)}: ${formatPrice(ctx.parsed.y)} €`),
				},
			},
		},
		scales: {
			x: timeAxis({
				min: from,
				max: Date.now(),
				grid: { display: false },
				ticks: { color: "#6b7280", font: { size: 11 } },
			}),
			y: {
				grid: { color: "#e5e7eb" },
				border: { display: false },
				ticks: { maxTicksLimit: 5, color: "#6b7280", font: { size: 11 }, callback: (v) => v.toFixed(3) },
			},
		},
	};
}

function line(label, history, key, color) {
	return {
		label,
		data: history.map((x) => ({ x: parseFecha(x.fecha).getTime(), y: x[key] })),
		borderColor: color,
		backgroundColor: color,
		borderWidth: 2,
		pointRadius: 0,
		pointHoverRadius: 4,
		stepped: true,
		fill: false,
		segment: gapSegment(DAY_MS),
	};
}

// ---------------------------------------------------------------------------
// The comparison chart: one line per station, for one fuel
// ---------------------------------------------------------------------------

let compareChart = null;
let chartRequest = 0;

// First come, first coloured: the earliest saved get the colours, and a
// station keeps its colour while it stays on the chart.
function assignSlots() {
	const ids = new Set(mine.ids("saved"));
	for (const id of slots.keys()) if (!ids.has(id)) slots.delete(id);
	for (const id of ids) {
		if (slots.size >= MAX_ON_CHART || slots.has(id) || dropped.has(id)) continue;
		slots.set(id, freeSlot());
	}
}

function freeSlot() {
	const used = new Set(slots.values());
	return [...SERIES.keys()].find((i) => !used.has(i));
}

function renderLegend() {
	const stations = saved();
	legend.replaceChildren(
		...stations.map((s) => {
			const li = document.createElement("li");
			const button = document.createElement("button");
			button.type = "button";
			const on = slots.has(s.id);
			button.setAttribute("aria-pressed", String(on));
			button.disabled = !on && slots.size >= MAX_ON_CHART;
			button.innerHTML = `<span class="series-chip"${on ? ` style="background:${SERIES[slots.get(s.id)]}"` : ""}></span><span>${escapeHtml(shortName(s))}</span>`;
			button.title = on ? t("Remove from the chart") : t("Add to the chart");
			button.addEventListener("click", () => {
				if (slots.has(s.id)) {
					slots.delete(s.id);
					dropped.add(s.id);
				} else {
					slots.set(s.id, freeSlot());
					dropped.delete(s.id);
				}
				renderLegend();
				renderSaved();
				drawCompareChart();
			});
			li.append(button);
			return li;
		}),
	);
}

async function drawCompareChart() {
	const stations = saved().filter((s) => slots.has(s.id));
	chartCard.hidden = saved().length === 0;
	const request = ++chartRequest;
	const from = Date.now() - view.range * DAY_MS;
	let series;
	try {
		series = await Promise.all(stations.map((s) => historyOf(s.id, view.range)));
	} catch (e) {
		console.error("Couldn't load the price history", e);
		chartNote.textContent = t("Couldn't load the price history.");
		chartNote.hidden = false;
		return;
	}
	if (request !== chartRequest) return;

	const datasets = stations.map((s, i) => line(shortName(s), series[i], view.fuel, SERIES[slots.get(s.id)]));
	compareChart?.destroy();
	compareChart = new Chart(
		document.getElementById("compareChart"),
		{ type: "line", data: { datasets }, options: chartOptions(from, (ctx) => ctx.dataset.label) },
	);
	const more = saved().length - stations.length;
	const notes = [];
	if (datasets.length && datasets.every((d) => d.data.every((p) => p.y == null))) {
		notes.push(t("No prices in this window."));
	}
	if (more > 0) {
		notes.push(tn(more, "{n} station isn't on the chart: tap its name to add it.", "{n} stations aren't on the chart: tap their names to add them."));
	}
	chartNote.textContent = notes.join(" ");
	chartNote.hidden = !notes.length;
}

// ---------------------------------------------------------------------------
// The list of saved stations
// ---------------------------------------------------------------------------

// Its own chart in each open "Price history", by station id.
const stationCharts = new Map();

async function drawStationChart(s, canvas) {
	const from = Date.now() - view.range * DAY_MS;
	let history;
	try {
		history = await historyOf(s.id, view.range);
	} catch (e) {
		console.error("Couldn't load the price history", e);
		const note = document.createElement("p");
		note.className = "muted";
		note.textContent = t("Couldn't load the price history.");
		canvas.parentElement.replaceWith(note);
		return;
	}
	if (!canvas.isConnected) return;
	stationCharts.get(s.id)?.destroy();
	stationCharts.set(
		s.id,
		new Chart(canvas, {
			type: "line",
			data: {
				datasets: Object.entries(FUELS).map(([key, f]) => line(f.name, history, key, f.color)),
			},
			options: chartOptions(from, (ctx) => ctx.dataset.label),
		}),
	);
}

function priceCell(s, key) {
	const fuel = FUELS[key];
	const price = s[key];
	return `
		<div class="mine-price ${fuel.className}${key === view.fuel ? " selected" : ""}">
			<span class="fuel-name"><span class="fuel-chip"></span>${fuel.name}</span>
			<span class="digits">${price != null ? priceDigits(price) : "—"}</span>
			${averageBadge(price, averages?.[s.provincia]?.[key], s.provincia)}
		</div>`;
}

function warnings(s) {
	const out = [];
	if (!s.en_listado) {
		out.push(
			s.ultima_vez
				? t("No longer in the Ministry's list since {date}: it may have closed.", { date: formatDateTime(parseFecha(s.ultima_vez)) })
				: t("No longer in the Ministry's list: it may have closed."),
		);
	}
	if (s.rotulo_anterior) {
		out.push(
			t("It was {old} when you saved it; it's {new} since {date}.", {
				old: escapeHtml(s.rotulo_anterior),
				new: escapeHtml(s.rotulo),
				date: s.rotulo_desde ? formatDateTime(parseFecha(s.rotulo_desde)).slice(0, 10) : "?",
			}),
		);
	}
	return out.map((w) => `<p class="mine-warning">${w}</p>`).join("") + (s.en_listado ? staleWarning(s) : "");
}

function savedItem(s) {
	const li = document.createElement("li");
	li.className = "item mine-station";
	li.dataset.id = s.id;
	const slot = slots.get(s.id);
	const place = [s.direccion, s.localidad ?? s.municipio, s.provincia].filter(Boolean).map(escapeHtml).join(" · ");
	li.innerHTML = `
		<div class="mine-head">
			${logoBadge(getLogoKey(s, logos, logosSorted).squareImage, s.rotulo, "mine-logo")}
			<div class="mine-title">
				${s.nickname ? `<div class="mine-nickname">${escapeHtml(s.nickname)}</div>` : ""}
				<div class="mine-rotulo">${slot != null ? `<span class="series-chip" style="background:${SERIES[slot]}" title="${t("Its colour on the chart")}"></span>` : ""}${escapeHtml(s.rotulo)}</div>
				<div class="item-meta">${place}</div>
			</div>
		</div>
		${s.en_listado ? `<div class="mine-prices">${Object.keys(FUELS).map((k) => priceCell(s, k)).join("")}</div>` : ""}
		${warnings(s)}
		${s.en_listado && s.ultimo_cambio ? `<p class="item-meta">${t("Prices last changed {date}", { date: formatDateTime(parseFecha(s.ultimo_cambio)) })}</p>` : ""}
		<div class="mine-advice" hidden></div>
		<div class="trip-actions">
			<a class="button-link" href="/files/map?station=${s.id}">${t("Show on map")}</a>
			<button type="button" class="secondary rename">${t("Rename")}</button>
			<button type="button" class="danger remove">${t("Remove")}</button>
		</div>
		<form class="mine-rename" hidden>
			<label>${t("Nickname")}
				<input type="text" maxlength="60" placeholder="${t("e.g. Home, Work")}" autocomplete="off" enterkeyhint="done">
			</label>
			<div class="trip-actions">
				<button type="submit" class="secondary">${t("Save")}</button>
				<button type="button" class="secondary cancel">${t("Cancel")}</button>
			</div>
		</form>
		<details class="fold mine-history">
			<summary>${t("Price history")}</summary>
			<div class="chart-box small"><canvas aria-label="${t("Price history")}"></canvas></div>
		</details>
		<details class="fold mine-alerts"${alertsOpen.has(s.id) ? " open" : ""}>
			<summary>${t("Price alerts")}<span class="pill alert-count" hidden></span></summary>
			<div class="alerts-box"></div>
		</details>`;

	const form = li.querySelector(".mine-rename");
	const input = form.querySelector("input");
	li.querySelector(".rename").addEventListener("click", () => {
		form.hidden = !form.hidden;
		input.value = s.nickname ?? "";
		if (!form.hidden) input.focus();
	});
	form.querySelector(".cancel").addEventListener("click", () => (form.hidden = true));
	form.addEventListener("submit", (e) => {
		e.preventDefault();
		act(() => mine.rename(s.id, input.value));
	});
	li.querySelector(".remove").addEventListener("click", () => {
		act(() => mine.remove(s.id)).then((ok) => ok && offerUndo(t("Removed {name}.", { name: shortName(s) }), () => mine.save(s, s.nickname)));
	});

	const details = li.querySelector(".mine-history");
	details.addEventListener("toggle", () => {
		if (details.open) drawStationChart(s, details.querySelector("canvas"));
	});

	const alertsFold = li.querySelector(".mine-alerts");
	alertsFold.addEventListener("toggle", () => {
		if (alertsFold.open) alertsOpen.add(s.id);
		else alertsOpen.delete(s.id);
	});
	fillAlerts(s, alertsFold);

	fillAdvice(s, li.querySelector(".mine-advice"));
	return li;
}

async function fillAdvice(s, box) {
	if (!s.en_listado || s[view.fuel] == null) return;
	const rows = (await forecastsFor(s)).filter((f) => f.combustible === view.fuel).sort((a, b) => a.horizonte - b.horizonte);
	if (!rows.length || !box.isConnected) return;
	const { verdict, label, text } = advice(rows);
	box.innerHTML = `<span class="advice-verdict ${verdict}">${label}</span> <span>${text}</span>`;
	box.hidden = false;
}

function renderSaved() {
	const fuel = view.fuel;
	const stations = saved().toSorted(
		(a, b) => (a.en_listado ? 0 : 1) - (b.en_listado ? 0 : 1) || (a[fuel] ?? Infinity) - (b[fuel] ?? Infinity),
	);
	for (const chart of stationCharts.values()) chart.destroy();
	stationCharts.clear();
	if (!stations.length) {
		const li = document.createElement("li");
		li.className = "empty";
		li.textContent = t("No saved stations yet. Open a station on the map and tap Save.");
		savedList.replaceChildren(li);
		return;
	}
	savedList.replaceChildren(...stations.map(savedItem));
}

function renderHidden() {
	const stations = hidden();
	hiddenCard.hidden = stations.length === 0;
	document.getElementById("hiddenTitle").textContent = t("Hidden stations ({n})", { n: stations.length });
	hiddenList.replaceChildren(
		...stations.map((s) => {
			const li = document.createElement("li");
			li.className = "item";
			li.innerHTML = `
				<div class="item-head">
					<div>
						<div class="item-title"><strong>${escapeHtml(s.rotulo)}</strong></div>
						<div class="item-meta">${[s.direccion, s.localidad ?? s.municipio, s.provincia].filter(Boolean).map(escapeHtml).join(" · ")}</div>
					</div>
					<button type="button" class="secondary">${t("Unhide")}</button>
				</div>`;
			li.querySelector("button").addEventListener("click", () => act(() => mine.remove(s.id)));
			return li;
		}),
	);
}

// ---------------------------------------------------------------------------
// Price alerts
// ---------------------------------------------------------------------------

const cents = (value) => value.toLocaleString(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function alertText(a) {
	const fuel = FUELS[a.fuel].name;
	if (a.kind === "any_drop") return t("{fuel}: whenever it drops", { fuel });
	// A no-break space keeps the unit with its number.
	if (a.kind === "drop_by") return t("{fuel}: when it drops {cents} c", { fuel, cents: cents(a.value) }).replace(/ c$/, "\u00a0c");
	return t("{fuel}: when it goes below {price} €", { fuel, price: formatPrice(a.value) });
}

function alertNote(a) {
	if (a.kind !== "drop_by") return "";
	return a.ref_price != null
		? t("From {price} €, its price when you added it or it last told you.", { price: formatPrice(a.ref_price) })
		: t("From its next price: it has none now.");
}

// The alerts of saved station `s` in its fold, and the form to add one.
function fillAlerts(s, fold) {
	const mineAlerts = alerts.filter((a) => a.station_id === s.id);
	const count = fold.querySelector(".alert-count");
	count.hidden = mineAlerts.length === 0;
	count.textContent = mineAlerts.length;

	const box = fold.querySelector(".alerts-box");
	const left = MAX_ALERTS - alerts.length;
	box.innerHTML = `
		${mineAlerts.length ? `<ul class="alert-list">${mineAlerts.map((a) => `
			<li data-id="${a.id}">
				<span>${escapeHtml(alertText(a))}<span class="item-meta">${escapeHtml(alertNote(a))}</span></span>
				<button type="button" class="danger">${t("Remove")}</button>
			</li>`).join("")}</ul>` : `<p class="muted">${t("Get a notification when this station's price drops.")}</p>`}
		${hasDevice === false ? `<p class="mine-warning">${t("None of your devices gets notifications yet.")} <a href="/files/settings">${t("Turn them on in Settings.")}</a></p>` : ""}
		<form class="alert-form">
			<label>${t("Fuel")}
				<select name="fuel">${Object.entries(FUELS).map(([key, f]) => `<option value="${key}"${key === view.fuel ? " selected" : ""}>${f.name}</option>`).join("")}</select>
			</label>
			<label>${t("Tell me")}
				<select name="kind">
					<option value="any_drop">${t("Whenever it drops")}</option>
					<option value="drop_by">${t("When it drops by")}</option>
					<option value="below">${t("When it goes below")}</option>
				</select>
			</label>
			<label class="value" hidden><span></span>
				<input name="value" type="number" inputmode="decimal" required>
			</label>
			<div class="button-row">
				<button type="submit" class="secondary"${left > 0 ? "" : " disabled"}>${t("Add alert")}</button>
			</div>
			<p class="item-meta">${left > 0 ? tn(left, "You can add 1 more alert.", "You can add {n} more alerts.") : t("You have the most alerts you can: remove one to add another")}</p>
		</form>`;

	for (const li of box.querySelectorAll(".alert-list li")) {
		li.querySelector("button").addEventListener("click", () =>
			act(async () => {
				const id = Number(li.dataset.id);
				await deleteAlert(id);
				alerts = alerts.filter((a) => a.id !== id);
				refreshAlerts();
			}),
		);
	}

	const form = box.querySelector("form");
	const valueLabel = form.querySelector(".value");
	const input = form.elements.value;
	const showValue = () => {
		const kind = form.elements.kind.value;
		valueLabel.hidden = kind === "any_drop";
		input.disabled = kind === "any_drop";
		const price = s[form.elements.fuel.value];
		if (kind === "drop_by") {
			valueLabel.firstElementChild.textContent = t("Cents");
			Object.assign(input, { min: 0.1, max: 50, step: 0.1, placeholder: "3" });
		} else if (kind === "below") {
			valueLabel.firstElementChild.textContent = t("Price (€/l)");
			Object.assign(input, { min: 0.5, max: 5, step: 0.001, placeholder: price != null ? (price - 0.02).toFixed(3) : "1.400" });
		}
	};
	form.addEventListener("change", showValue);
	showValue();
	form.addEventListener("submit", (e) => {
		e.preventDefault();
		const kind = form.elements.kind.value;
		const value = kind === "any_drop" ? null : Number(input.value.replace(",", "."));
		act(async () => {
			const alert = await putAlert(s.id, form.elements.fuel.value, kind, value);
			alerts = [...alerts.filter((a) => a.id !== alert.id), alert];
			refreshAlerts();
		});
	});
}

// Redraws every station's alerts (the count left changes for all of them).
function refreshAlerts() {
	for (const fold of savedList.querySelectorAll(".mine-alerts")) {
		const id = Number(fold.closest(".mine-station").dataset.id);
		fillAlerts(mine.get(id), fold);
	}
}

async function loadAlerts() {
	try {
		const [list, channels] = await Promise.all([getAlerts(), getChannels()]);
		alerts = list;
		hasDevice = channels.length > 0;
		refreshAlerts();
	} catch (e) {
		console.error("Couldn't load your price alerts", e);
	}
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

// Runs a change, showing why it failed if it did. Resolves to whether it worked.
async function act(change) {
	message.replaceChildren();
	message.className = "";
	try {
		await change();
		return true;
	} catch (e) {
		message.textContent = e.message;
		message.className = "error";
		return false;
	}
}

function offerUndo(text, undo) {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "secondary";
	button.textContent = t("Undo");
	button.addEventListener("click", () => act(undo));
	message.className = "mine-undo";
	message.replaceChildren(document.createTextNode(text + " "), button);
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function renderSegmented(group, attr, current) {
	for (const b of group.querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset[attr] === String(current)));
}

fuelGroup.addEventListener("click", (e) => {
	const b = e.target.closest("button");
	if (!b) return;
	view.fuel = b.dataset.fuel;
	renderSegmented(fuelGroup, "fuel", view.fuel);
	renderSaved();
	drawCompareChart();
});

rangeGroup.addEventListener("click", (e) => {
	const b = e.target.closest("button");
	if (!b) return;
	view.range = Number(b.dataset.range);
	renderSegmented(rangeGroup, "range", view.range);
	drawCompareChart();
	for (const details of savedList.querySelectorAll(".mine-history[open]")) {
		const id = Number(details.closest(".mine-station").dataset.id);
		const canvas = details.querySelector("canvas");
		if (canvas) drawStationChart(mine.get(id), canvas);
	}
});

function renderAll() {
	// Unsaving a station deletes its alerts.
	alerts = alerts.filter((a) => mine.isSaved(a.station_id));
	assignSlots();
	renderLegend();
	renderSaved();
	renderHidden();
	drawCompareChart();
}

// The averages over what the map would show: the saved stations, and the
// brands in the user's filter without hidden stations, nor stale ones if the
// map hides them.
function computeAverages(all, filter) {
	const hideStale = loadHideStale();
	return provinceAverages(
		all.filter(
			(s) =>
				mine.isSaved(s.id) ||
				(filter.has(getLogoKey(s, logos, logosSorted).logoKey) && !mine.isHidden(s.id) && !(hideStale && staleSince(s))),
		),
	);
}

async function load() {
	const prices = getLatestPrices();
	let state;
	[state, mine, logos] = await Promise.all([getUserState(), MyStations.load(), getLogos()]);
	logosSorted = sortLogos(logos);
	renderNav(document.getElementById("nav"), state, "stations");

	view.fuel = state.car?.fuel === "diesel" ? "gasoleo_a" : "gasolina_95";
	renderSegmented(fuelGroup, "fuel", view.fuel);
	renderSegmented(rangeGroup, "range", view.range);
	renderAll();
	mine.on(renderAll);
	loadAlerts();

	try {
		averages = computeAverages(await prices, state.filter);
		renderSaved();
	} catch (e) {
		console.error("Couldn't load the prices to average", e);
	}
}

load().catch((e) => {
	message.textContent = e.message;
	message.className = "error";
});
