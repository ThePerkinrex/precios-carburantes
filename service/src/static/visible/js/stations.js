import { formatDate, formatDateTime, parseFecha } from "./dates.js";
import { getStatus, formatOpenCloseDate } from "./schedules.js";
import { updateFilter } from "./api.js";
import { fitToScreen, onlyOneOpen } from "./map_panels.js";
import { t } from "./i18n.js";
import { gapSegment, timeAxis } from "./time_axis.js";
import { averageBadge, provinceAverages } from "./area_average.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// Downloads are at most 9 h apart: a longer stretch without any is a gap.
const MAX_GAP_MS = DAY_MS;
// A station whose prices haven't changed in this long may have stopped
// updating them: the map can hide it, and its popup says so.
const STALE_DAYS = 7;
const STALE_STORAGE_KEY = "hideStaleStations";

// When the station's prices last changed, if that's STALE_DAYS or more ago.
export function staleSince(eess) {
	if (!eess.ultimo_cambio) return null;
	const since = parseFecha(eess.ultimo_cambio);
	return Date.now() - since.getTime() >= STALE_DAYS * DAY_MS ? since : null;
}

export function staleWarning(eess) {
	const since = staleSince(eess);
	if (!since) return "";
	const days = Math.floor((Date.now() - since.getTime()) / DAY_MS);
	return `<p class="station-stale">${t("Prices unchanged since {date} ({days} days): they may be out of date.", { date: formatDate(since), days })}</p>`;
}

// Whether the map hides stale stations: the viewer's last choice, on by default.
export function loadHideStale() {
	try {
		return localStorage.getItem(STALE_STORAGE_KEY) !== "false";
	} catch {
		return true;
	}
}

function saveHideStale(hide) {
	try {
		localStorage.setItem(STALE_STORAGE_KEY, String(hide));
	} catch {
		// Not remembered; it still applies until the page reloads.
	}
}

// Same colours as the --g95 / --diesel tokens (map_base.css), for Chart.js.
export const G95_COLOR = "#16a34a";
export const DIESEL_COLOR = "#1f2937";

// Prices always show 3 decimal places (e.g. 1.5 -> "1.500").
export function formatPrice(price) {
	return price.toFixed(3);
}

/**
 * A price as board digits: "1.45<small>9</small>", the thousandths set
 * smaller like on the signs. Wrap it in an element with class "digits".
 */
export function priceDigits(price) {
	const text = formatPrice(price);
	return `${text.slice(0, -1)}<small>${text.slice(-1)}</small>`;
}

export function escapeHtml(text) {
	return String(text ?? "").replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
	);
}

// Square brand logo URL of each station record (null: no known brand),
// filled in by createStationsLayer so the popup and the station list can
// show it.
const stationLogos = new WeakMap();

export function stationLogo(eess) {
	return stationLogos.get(eess) ?? null;
}

/**
 * The brand's logo in a small box, or the station's initial when the brand
 * has no logo. `className` is the box's class.
 */
export function logoBadge(image, name, className) {
	return image
		? `<span class="${className}"><img src="${image}" alt=""></span>`
		: `<span class="${className} no-logo" aria-hidden="true">${escapeHtml(String(name ?? "?").trim().charAt(0).toUpperCase())}</span>`;
}

// ---------------------------------------------------------------------------
// Popup content
// ---------------------------------------------------------------------------

function blacklistButtonContent(blacklisted) {
	return blacklisted
		? `<span aria-hidden="true">&#10003;</span> ${t("Include again")}`
		: `<span aria-hidden="true">&#10005;</span> ${t("Exclude")}`;
}

function blacklistButtonTitle(blacklisted) {
	return t(blacklisted ? "Remove from the excluded stations" : "Add to the excluded stations");
}

/**
 * Renders the button shown in a station popup so the user can add or remove
 * that station from the blacklist. Returns "" when no blacklist is in use
 * (feature is fully optional).
 */
function buildBlacklistToggle(eess, blacklist) {
	if (!blacklist) return "";
	const blacklisted = blacklist.has(eess.id);
	return `<button type="button" class="blacklist-toggle ${blacklisted ? "unblacklist" : "blacklist"}" title="${blacklistButtonTitle(blacklisted)}">${blacklistButtonContent(blacklisted)}</button>`;
}

function statusPills(eess) {
	const status = getStatus(eess.horario, new Date());
	const closeText = (d) => (d ? t("closes {when}", { when: formatOpenCloseDate(d) }) : "24 h");
	let pill = "";
	if (status.status == "open") {
		pill = `<span class="pill open">${t("Open")} · ${closeText(status.nextClose)}</span>`;
	} else if (status.status == "opensSoon") {
		pill = `<span class="pill open soon">${t("Opens soon")} · ${formatOpenCloseDate(status.nextOpen)}</span>`;
	} else if (status.status == "closed") {
		pill = status.nextOpen
			? `<span class="pill closed">${t("Closed")} · ${t("opens {when}", { when: formatOpenCloseDate(status.nextOpen) })}</span>`
			: `<span class="pill closed">${t("Closed")}</span>`;
	} else if (status.status == "closesSoon") {
		pill = `<span class="pill closed soon">${t("Closes soon")} · ${closeText(status.nextClose)}</span>`;
	}
	if (status.uncertain) {
		pill += `<span class="pill uncertain" title="${t("The published hours only cover Monday; the same hours are assumed every day")}">${t("Uncertain hours")}</span>`;
	}
	return pill;
}

export function navigationLinks(eess) {
	const where = `${eess.latitud},${eess.longitud}`;
	const links = [
		{
			// https://www.google.com/maps/search/?api=1&query=47.5951518%2C-122.3316393
			href: `https://www.google.com/maps/search/?${new URLSearchParams({ api: "1", query: where })}`,
			icon: "/files/images/google_maps.svg",
			text: "Google Maps",
		},
		{
			// https://waze.com/ul?ll=<lat>,<lng>
			href: `https://waze.com/ul?${new URLSearchParams({ ll: where })}`,
			icon: "/files/images/waze.svg",
			text: "Waze",
		},
		{
			// https://maps.apple.com/?daddr=<lat>,<lng>
			href: `https://maps.apple.com/?${new URLSearchParams({ daddr: where })}`,
			icon: "/files/images/apple_maps.png",
			text: "Apple Maps",
		},
	];
	return links
		.map(
			(l) =>
				`<a class="nav-link" href="${l.href}" target="_blank" rel="noopener noreferrer"><img src="${l.icon}" alt=""><span>${l.text}</span></a>`,
		)
		.join("");
}

// The dataset's "margen": which side of the road the station is on.
function roadSide(margen) {
	if (margen === "D") return t("right-hand side");
	if (margen === "I") return t("left-hand side");
	return t("side {side}", { side: escapeHtml(margen) });
}

function boardLine(name, className, price, badge = "") {
	return `
		<div class="station-board-row ${className}">
			<span class="fuel-name"><span class="fuel-chip"></span>${name}</span>
			${badge}
			${
				price != null
					? `<span class="board-price digits">${priceDigits(price)}<span class="unit">€/L</span></span>`
					: `<span class="board-price none">—</span>`
			}
		</div>`;
}

// Under the board: what the badges in it compare with.
function averageNote(eess, average) {
	const parts = [
		["G95", average?.gasolina_95],
		["Gasóleo A", average?.gasoleo_a],
	].filter(([, a]) => a);
	if (!parts.length) return "";
	const n = Math.max(...parts.map(([, a]) => a.n));
	return `<p class="station-average">${t("Average of the {n} stations shown in {area}:", { n, area: escapeHtml(eess.provincia) })} ${parts
		.map(([name, a]) => `${name} <b>${a.mean.toFixed(3)}</b>`)
		.join(" · ")}</p>`;
}

const STAR = `<span class="star" aria-hidden="true">★</span>`;
const EMPTY_STAR = `<span class="star" aria-hidden="true">☆</span>`;

/**
 * Save / hide buttons and the nickname field, when the user's lists are in
 * use (attachMineControls wires them). "" without `myStations`.
 */
function buildMineControls(eess, myStations) {
	if (!myStations) return "";
	return `
		<div class="mine-controls">
			<div class="mine-buttons">
				<button type="button" class="mine-save"></button>
				<button type="button" class="mine-hide">${t("Hide everywhere")}</button>
			</div>
			<label class="mine-nickname">
				<span>${t("Nickname")}</span>
				<input type="text" maxlength="60" placeholder="${t("e.g. Home, Work")}" enterkeyhint="done" autocomplete="off">
			</label>
			<p class="mine-error" role="alert" hidden></p>
		</div>`;
}

/**
 * Default popup body for a gas station marker. Exported so callers can
 * reuse/wrap it (e.g. call this and append extra sections) instead of
 * rewriting everything from scratch.
 *
 * @param {object} eess station record, same shape as returned by /api/prices
 * @returns {string} HTML for the popup contents
 */
export function buildDefaultPopupContent(eess, blacklist = null, { myStations = null, average = null } = {}) {
	const blacklisted = blacklist ? blacklist.has(eess.id) : false;
	const place = [eess.localidad, eess.provincia].filter(Boolean).map(escapeHtml).join(" · ");
	const nickname = myStations?.nickname(eess.id);

	return `
	<div class="gasolinera${blacklisted ? " blacklisted" : ""}" id="gasolinera-${eess.id}">
		<header class="station-head">
			${logoBadge(stationLogo(eess), eess.rotulo, "station-logo")}
			<div class="station-title">
				<div class="station-nickname"${nickname ? "" : " hidden"}>${STAR} <span>${escapeHtml(nickname)}</span></div>
				<div class="rotulo">${escapeHtml(eess.rotulo)}</div>
				<div class="station-place">${place}</div>
			</div>
		</header>

		<div class="station-status">${statusPills(eess)}</div>

		<div class="station-board">
			${boardLine("Gasolina 95", "g95", eess.gasolina_95, averageBadge(eess.gasolina_95, average?.gasolina_95, eess.provincia))}
			${boardLine("Gasóleo A", "diesel", eess.gasoleo_a, averageBadge(eess.gasoleo_a, average?.gasoleo_a, eess.provincia))}
		</div>
		${averageNote(eess, average)}
		${staleWarning(eess)}

		${buildMineControls(eess, myStations)}

		<nav class="station-nav" aria-label="${t("Directions")}">${navigationLinks(eess)}</nav>

		<dl class="station-details">
			<dt>${t("Address")}</dt>
			<dd>${escapeHtml(eess.direccion)} (${roadSide(eess.margen)})<br>${escapeHtml(eess.cp)} ${escapeHtml(eess.municipio)}</dd>
			<dt>${t("Opening hours")}</dt>
			<dd>${escapeHtml(eess.horario)}</dd>
		</dl>

		<div class="station-chart">
			<div class="station-chart-head">
				<span>${t("Last 7 days")}</span>
				<span class="station-chart-legend"><span class="fuel-chip g95"></span>G95 <span class="fuel-chip diesel"></span>Gasóleo A</span>
			</div>
			<div class="chart-box"><canvas class="chart"></canvas></div>
		</div>

		${adviceHtml(eess)}

		${buildBlacklistToggle(eess, blacklist)}
	</div>`;
}

/**
 * Prices are only stored when they change: gives the station's prices at
 * every snapshot, carrying each change forward until the next one. Where the
 * station wasn't reported, the prices are null, so the chart shows a gap.
 * Both lists are sorted, and fechas are "YYYY-MM-DD HH:MM:SS", so they
 * compare as strings.
 */
export function rebuildHistory(snapshots, changes) {
	let next = 0;
	let current = null;
	return snapshots.map((fecha) => {
		while (next < changes.length && changes[next].fecha <= fecha) current = changes[next++];
		const reported = current?.reportado ?? false;
		return {
			fecha,
			gasoleo_a: reported ? current.gasoleo_a : null,
			gasolina_95: reported ? current.gasolina_95 : null,
		};
	});
}

const FORECAST_FUELS = [
	["gasolina_95", "g95", "G95"],
	["gasoleo_a", "diesel", "Gasóleo A"],
];
const percent = (p) => `${Math.round(p * 100)} %`;
const inDays = (h) => (h === 1 ? t("tomorrow") : t("in {n} days", { n: h }));

// Wait or fill up, from one fuel's forecasts: wait if the price is more
// likely lower than not at some horizon (the likeliest one).
export function advice(rows) {
	const wait = rows.reduce((a, b) => (b.baja > a.baja ? b : a));
	if (wait.baja > 0.5) {
		return { verdict: "wait", label: t("Wait"), text: t("{p} chance it's cheaper {when}", { p: percent(wait.baja), when: inDays(wait.horizonte) }) };
	}
	const rise = rows.reduce((a, b) => (b.sube > a.sube ? b : a));
	return {
		verdict: "fill",
		label: t("Fill up"),
		text: rise.sube >= 0.4
			? t("{p} chance it's dearer {when}", { p: percent(rise.sube), when: inDays(rise.horizonte) })
			: t("Unlikely to drop soon"),
	};
}

// Each station's forecasts by id, once loaded (empty if it has none).
const stationForecasts = new Map();

/** Loads the station's forecasts into stationForecasts, if they aren't there. */
async function loadForecasts(eess) {
	if (stationForecasts.has(eess.id)) return;
	try {
		const response = await fetch(`/api/${eess.id}/forecast`);
		stationForecasts.set(eess.id, response.ok ? await response.json() : []);
	} catch (e) {
		console.error("Couldn't load the forecast", e);
	}
}

/** The station's forecasts (see /api/{id}/forecast), loading them if needed. */
export async function forecastsFor(eess) {
	await loadForecasts(eess);
	return stationForecasts.get(eess.id) ?? [];
}

/** The popup's wait-or-fill-up advice, from the loaded forecasts ("" without). */
function adviceHtml(eess) {
	const forecasts = stationForecasts.get(eess.id) ?? [];
	const rows = FORECAST_FUELS.map(([fuel, className, name]) => {
		const mine = forecasts.filter((f) => f.combustible === fuel).sort((a, b) => a.horizonte - b.horizonte);
		if (!mine.length || eess[fuel] == null) return "";
		const { verdict, label, text } = advice(mine);
		const odds = mine
			.map((f) => `<span>${f.horizonte} d: ▼${percent(f.baja)} ▲${percent(f.sube)}</span>`)
			.join("");
		return `
			<div class="advice-row">
				<span class="fuel-name"><span class="fuel-chip ${className}"></span>${name}</span>
				<span class="advice-verdict ${verdict}">${label}</span>
				<span class="advice-text">${text}</span>
				<span class="advice-odds">${odds}</span>
			</div>`;
	}).join("");
	return rows ? `<div class="station-advice"><div class="advice-head">${t("Wait or fill up?")}</div>${rows}</div>` : "";
}

/**
 * Draws the 7-day price history chart into a popup built with
 * buildDefaultPopupContent. No-ops if the popup doesn't contain the
 * expected #gasolinera-<id> / .chart elements, so custom popup builders
 * are free to drop the chart entirely.
 */
async function drawHistoryChart(eess) {
	const popup = document.getElementById(`gasolinera-${eess.id}`);
	const chart = popup?.getElementsByClassName("chart")[0];
	if (!chart) return;
	const box = chart.parentElement;

	const from = new Date(new Date().setDate(new Date().getDate() - 7));
	let history;
	try {
		const { snapshots, changes } = await fetch(
			`/api/${eess.id}/history?` +
				new URLSearchParams({ from: from.toISOString() }).toString(),
		).then((x) => x.json());
		history = rebuildHistory(snapshots, changes);
	} catch (e) {
		console.error("Couldn't load the price history", e);
		box.classList.add("failed");
		return;
	}
	if (!chart.isConnected) return; // the popup was closed meanwhile

	const line = (label, key, color) => ({
		label,
		data: history.map((x) => ({ x: parseFecha(x.fecha).getTime(), y: x[key] })),
		borderColor: color,
		backgroundColor: color,
		borderWidth: 2,
		pointRadius: 0,
		pointHoverRadius: 4,
		stepped: true,
		fill: false,
		segment: gapSegment(MAX_GAP_MS),
	});

	new Chart(chart, {
		type: "line",
		data: {
			datasets: [
				line("Gasolina 95", "gasolina_95", G95_COLOR),
				line("Gasóleo A", "gasoleo_a", DIESEL_COLOR),
			],
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			animation: false,
			interaction: { mode: "index", intersect: false },
			plugins: {
				legend: { display: false },
				tooltip: {
					callbacks: {
						title: (items) => formatDateTime(new Date(items[0].parsed.x)),
						label: (ctx) =>
							ctx.parsed.y == null ? null : `${ctx.dataset.label}: ${formatPrice(ctx.parsed.y)} €`,
					},
				},
			},
			scales: {
				x: timeAxis({
					min: from.getTime(),
					max: Date.now(),
					grid: { display: false },
					ticks: { color: "#6b7280", font: { size: 10 } },
				}),
				y: {
					grid: { color: "#e5e7eb" },
					border: { display: false },
					ticks: {
						maxTicksLimit: 4,
						color: "#6b7280",
						font: { size: 10 },
						callback: (v) => v.toFixed(3),
					},
				},
			},
		},
	});
	box.classList.add("loaded");
}

/**
 * Wires up the button rendered by buildBlacklistToggle inside a
 * currently-open popup. No-ops if there's no blacklist in use, or if the
 * popup doesn't contain a .blacklist-toggle button (so custom popup
 * builders are free to drop the feature). Updates the popup's gray-out
 * styling and the marker's map icon in place, so the popup doesn't need to
 * be closed/reopened.
 */
function attachBlacklistToggle(eess, blacklist, marker, iconFor, onBlacklistChange) {
	if (!blacklist) return;

	const container = document.getElementById(`gasolinera-${eess.id}`);
	const btn = container?.querySelector(".blacklist-toggle");
	if (!container || !btn) return;

	L.DomEvent.on(btn, "click", (ev) => {
		L.DomEvent.stop(ev);

		const wasBlacklisted = blacklist.has(eess.id);
		if (wasBlacklisted) {
			blacklist.delete(eess.id);
		} else {
			blacklist.add(eess.id);
		}
		const isBlacklisted = !wasBlacklisted;

		// Gray out (or restore) the popup itself.
		container.classList.toggle("blacklisted", isBlacklisted);

		// Flip the button between "Exclude" and "Include again".
		btn.classList.toggle("blacklist", !isBlacklisted);
		btn.classList.toggle("unblacklist", isBlacklisted);
		btn.innerHTML = blacklistButtonContent(isBlacklisted);
		btn.title = blacklistButtonTitle(isBlacklisted);

		// Gray out (or restore) the marker icon shown on the map.
		marker.setIcon(iconFor(eess));

		onBlacklistChange?.(eess, isBlacklisted, blacklist);
	});
}

/**
 * Wires the controls rendered by buildMineControls inside the open popup of
 * `eess`. The marker's star and visibility follow from myStations' change
 * events (createStationsLayer); hiding the station closes its popup.
 */
function attachMineControls(eess, myStations, closePopup) {
	const container = document.getElementById(`gasolinera-${eess.id}`);
	const controls = container?.querySelector(".mine-controls");
	if (!myStations || !controls) return;

	const saveButton = controls.querySelector(".mine-save");
	const hideButton = controls.querySelector(".mine-hide");
	const field = controls.querySelector(".mine-nickname");
	const input = field.querySelector("input");
	const error = controls.querySelector(".mine-error");
	const nicknameLine = container.querySelector(".station-nickname");

	const render = () => {
		const saved = myStations.isSaved(eess.id);
		saveButton.classList.toggle("on", saved);
		saveButton.setAttribute("aria-pressed", String(saved));
		saveButton.innerHTML = saved ? `${STAR} ${t("Saved")}` : `${EMPTY_STAR} ${t("Save")}`;
		saveButton.title = t(saved ? "Remove from My stations" : "Add to My stations");
		field.hidden = !saved;
		const nickname = myStations.nickname(eess.id);
		if (document.activeElement !== input) input.value = nickname ?? "";
		nicknameLine.hidden = !nickname;
		nicknameLine.querySelector("span:last-child").textContent = nickname ?? "";
	};
	const run = async (action) => {
		error.hidden = true;
		try {
			await action();
		} catch (e) {
			error.textContent = e.message;
			error.hidden = false;
		}
		if (container.isConnected) render();
	};

	L.DomEvent.on(saveButton, "click", (ev) => {
		L.DomEvent.stop(ev);
		const saving = !myStations.isSaved(eess.id);
		run(() => (saving ? myStations.save(eess) : myStations.remove(eess.id)));
		render();
		if (saving) input.focus();
	});
	L.DomEvent.on(hideButton, "click", (ev) => {
		L.DomEvent.stop(ev);
		closePopup();
		myStations.hide(eess).catch((e) => console.error("Couldn't hide the station", e));
	});
	input.addEventListener("change", () => {
		if (myStations.isSaved(eess.id) && (input.value.trim() || null) !== myStations.nickname(eess.id)) {
			run(() => myStations.rename(eess.id, input.value));
		}
	});
	input.addEventListener("keydown", (ev) => {
		if (ev.key === "Enter") input.blur();
	});
	render();
}

export function sortLogos(logos) {
	return Object.keys(logos).sort((a, b) => b.length - a.length);
}

// Whether `word` is in `text` as a whole word, so short brand names don't
// match inside others: "eni" isn't in "BP BENIDORM", nor "avia" in
// "BP LA GAVIA". Punctuation counts as a separator ("E.S. REPSOL-2").
function containsWord(text, word) {
	let from = 0;
	for (let i; (i = text.indexOf(word, from)) !== -1; from = i + 1) {
		const before = text[i - 1];
		const after = text[i + word.length];
		if (!isWordChar(before) && !isWordChar(after)) return true;
	}
	return false;
}

const isWordChar = (c) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

export function getLogoKey(eess, logos, logos_sorted = undefined) {
	if (logos_sorted === undefined) {
		logos_sorted = sortLogos(logos);
	}
	let logo = `<div class="logo"><b>${escapeHtml(eess.rotulo)}</b></div>`;
	let logoKey = "other";
	let image = null;
	let squareImage = null;
	const lower_eess = eess.rotulo.toLowerCase();
	for (let name of logos_sorted) {
		if (
			containsWord(lower_eess, name) ||
			("alternatives" in logos[name] &&
				logos[name].alternatives.some((x) => containsWord(lower_eess, x)))
		) {
			logo = `<img class="logo" src="${logos[name].image}"/>`;
			logoKey = name;
			image = logos[name].image;
			squareImage = logos[name].icon ?? image;
			break;
		}
	}
	return {
		logo,
		logoKey,
		// The long logo, for the marker, and the square one (logos.json's
		// "icon"), for lists and the popup.
		image,
		squareImage,
	}
}

// ---------------------------------------------------------------------------
// Marker icon: a mini price sign (brand strip + navy board), with a tail
// pointing at the station. Sizes match .station-sign in stations.css.
// ---------------------------------------------------------------------------

const SIGN_WIDTH = 60;
const SIGN_BRAND_HEIGHT = 20;
const SIGN_ROW_HEIGHT = 16;
const SIGN_PADDING = 6; // top + bottom of the price rows
const SIGN_TAIL = 6;

function buildMarkerIcon(eess, logos, logos_sorted, blacklist = null, myStations = null) {
	const { logoKey, image, squareImage } = getLogoKey(eess, logos, logos_sorted);

	const rows = [];
	if (eess.gasolina_95 != null)
		rows.push(`<span class="sign-row g95"><span class="fuel-chip"></span><span class="digits">${priceDigits(eess.gasolina_95)}</span></span>`);
	if (eess.gasoleo_a != null)
		rows.push(`<span class="sign-row diesel"><span class="fuel-chip"></span><span class="digits">${priceDigits(eess.gasoleo_a)}</span></span>`);
	if (rows.length === 0) rows.push(`<span class="sign-row"><span class="digits">—</span></span>`);

	const brand = image
		? `<img src="${image}" alt="">`
		: `<span class="sign-name">${escapeHtml(eess.rotulo)}</span>`;

	const blacklisted = blacklist ? blacklist.has(eess.id) : false;
	const height = SIGN_BRAND_HEIGHT + SIGN_PADDING + rows.length * SIGN_ROW_HEIGHT + SIGN_TAIL;

	const icon = L.divIcon({
		className: "station-marker",
		html: `<div class="station-sign${blacklisted ? " blacklisted" : ""}">
				<span class="sign-brand">${brand}</span>
				${myStations?.isSaved(eess.id) ? `<span class="sign-star" aria-hidden="true">★</span>` : ""}
				<span class="sign-prices">${rows.join("")}</span>
			</div>`,
		iconSize: [SIGN_WIDTH, height],
		iconAnchor: [SIGN_WIDTH / 2, height],
		popupAnchor: [0, -height],
	});

	return { icon, logoKey, squareImage };
}

// ---------------------------------------------------------------------------
// Brand filter: button + dropdown with a switch per brand
// ---------------------------------------------------------------------------

const FILTER_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h18l-7 8.5V19l-4 2v-7.5z"/></svg>`;

let brandFilterCount = 0;

/**
 * @param {Array<{name: string, text: string, image: string|null, subgroup: L.Layer, count: number}>} brands
 * @param {Array<{label: string, count: () => number, on: () => boolean, set: (on: boolean) => void}>} switches
 *        extra switches above the brands (stale stations, my stations)
 * @returns the control; its refresh() updates the switches' counts
 */
function createBrandFilterControl(brands, switches = []) {
	const panelId = `brandPanel${++brandFilterCount}`;

	const BrandFilterControl = L.Control.extend({
		options: { position: "topright" },

		onAdd(map) {
			const container = L.DomUtil.create("div", "leaflet-control map-dropdown brand-filter");
			L.DomEvent.disableClickPropagation(container);
			L.DomEvent.disableScrollPropagation(container);

			container.innerHTML = `
				<button type="button" class="map-button" aria-label="${t("Filter brands")}" aria-expanded="false" aria-controls="${panelId}">
					${FILTER_ICON}<span class="map-button-badge" hidden></span>
				</button>
				<section id="${panelId}" class="map-dropdown-panel brand-panel" aria-label="${t("Brands")}" hidden>
					<div class="map-panel-head">
						<div>
							<h2>${t("Brands")}</h2>
							<p class="map-panel-sub"></p>
						</div>
						<button type="button" class="map-panel-close" aria-label="${t("Close")}">&times;</button>
					</div>
					${switches
						.map(
							(sw, i) => `
					<label class="brand-row stale-row">
						<span class="brand-name">${sw.label}</span>
						<span class="brand-count"></span>
						<input type="checkbox" class="switch extra-switch" data-index="${i}">
					</label>`,
						)
						.join("")}
					<div class="brand-actions">
						<button type="button" data-select="all">${t("All brands")}</button>
						<button type="button" data-select="none">${t("None")}</button>
					</div>
					<ul class="brand-list">
						${brands
							.map(
								(b, i) => `
							<li>
								<label class="brand-row">
									${logoBadge(b.image, b.text, "brand-logo")}
									<span class="brand-name">${escapeHtml(b.text)}</span>
									<span class="brand-count">${b.count}</span>
									<input type="checkbox" class="switch" data-index="${i}">
								</label>
							</li>`,
							)
							.join("")}
					</ul>
				</section>
			`;

			const toggle = container.querySelector(".map-button");
			const panel = container.querySelector(".brand-panel");
			const badge = container.querySelector(".map-button-badge");
			const sub = container.querySelector(".map-panel-sub");
			const checks = [...container.querySelectorAll(".brand-list .switch")];

			const sync = () => {
				let shown = 0;
				brands.forEach((b, i) => {
					const on = map.hasLayer(b.subgroup);
					checks[i].checked = on;
					if (on) shown++;
				});
				const hidden = brands.length - shown;
				badge.hidden = hidden === 0;
				badge.textContent = String(hidden);
				toggle.setAttribute(
					"aria-label",
					hidden === 0 ? t("Filter brands") : t("Filter brands ({n} hidden)", { n: hidden }),
				);
				sub.textContent = t("{shown} of {total} shown", { shown, total: brands.length });
			};

			const setOpen = (open) => {
				panel.hidden = !open;
				container.classList.toggle("open", open);
				toggle.setAttribute("aria-expanded", String(open));
				if (open) {
					this._panels.opened();
					fitToScreen(panel);
				}
			};
			this._panels = onlyOneOpen(map, panelId, () => setOpen(false));
			this._close = () => setOpen(false);
			this._onKey = (e) => {
				if (e.key === "Escape" && !panel.hidden) {
					setOpen(false);
					toggle.focus();
				}
			};

			toggle.addEventListener("click", () => setOpen(panel.hidden));
			container.querySelector(".map-panel-close").addEventListener("click", () => setOpen(false));
			map.on("click", this._close);
			document.addEventListener("keydown", this._onKey);

			checks.forEach((check, i) => {
				check.addEventListener("change", () => {
					if (check.checked) map.addLayer(brands[i].subgroup);
					else map.removeLayer(brands[i].subgroup);
				});
			});
			const extraRows = [...container.querySelectorAll(".stale-row")];
			this.refresh = () => {
				switches.forEach((sw, i) => {
					extraRows[i].querySelector(".switch").checked = sw.on();
					extraRows[i].querySelector(".brand-count").textContent = sw.count();
				});
			};
			switches.forEach((sw, i) => {
				const check = extraRows[i].querySelector(".switch");
				check.addEventListener("change", () => {
					sw.set(check.checked);
					this.refresh();
				});
			});
			this.refresh();
			container.querySelector('[data-select="all"]').addEventListener("click", () => {
				for (const b of brands) map.addLayer(b.subgroup);
			});
			container.querySelector('[data-select="none"]').addEventListener("click", () => {
				for (const b of brands) if (map.hasLayer(b.subgroup)) map.removeLayer(b.subgroup);
			});

			this._sync = sync;
			for (const b of brands) b.subgroup.on("add remove", sync);
			sync();

			return container;
		},

		onRemove(map) {
			this._panels.dispose();
			map.off("click", this._close);
			document.removeEventListener("keydown", this._onKey);
			for (const b of brands) b.subgroup.off("add remove", this._sync);
		},
	});

	const control = new BrandFilterControl();
	control.refresh = () => {}; // until it's on a map
	return control;
}

export class StationBlacklist {
	constructor(blacklist = []) {
		this.blacklist = new Set(blacklist);
		this.event_listeners = {
			change: new Set(),
			add: new Set(),
			delete: new Set(),
		};
	}

	on(event, handler) {
		if (event in this.event_listeners) {
			this.event_listeners[event].add(handler);
		}else{
			throw new Error(event + " is not a valid event");
		}
	}

	off(event, handler) {
		if (event in this.event_listeners) {
			this.event_listeners[event].delete(handler);
		}else{
			throw new Error(event + " is not a valid event");
		}
	}

	#handle(event, ...args) {
		for(const listeners of this.event_listeners[event]) {
			listeners(...args)
		}
	}

	add(station) {
		this.blacklist.add(station)
		this.#handle('add', station)
		this.#handle('change', station, 'add')
	}

	delete(station) {
		const res = this.blacklist.delete(station)
		this.#handle('delete', station)
		this.#handle('change', station, 'delete')
		return res;
	}

	has(station) {
		return this.blacklist.has(station)
	}
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

// Popups fit the screen's width (320px phones included).
function popupOptions() {
	const width = Math.min(340, window.innerWidth - 32);
	return { className: "station-popup", minWidth: width, maxWidth: width };
}

// Things fixed over the map on its right (wide screens) or bottom (phones)
// that an open popup must stay clear of.
const POPUP_OBSTACLES = ".route-fab, .route-panel:not(.hidden), .trip-alternatives-panel";
// Upper bound of a minimized bottom sheet's height (trip_alternatives.css).
const MINIMIZED_SHEET = 100;

/**
 * When a popup opens, the map scrolls it clear of the controls in the top
 * corners and of what's fixed over the map (the route button, the plans
 * sheet), instead of Leaflet's default 5px margin, and the popup scrolls
 * inside when it's taller than the room left. Measured each time, since
 * the controls differ between pages.
 */
function fitPopup(map, popup) {
	const mapRect = map.getContainer().getBoundingClientRect();
	const column = (selector) => {
		let bottom = 0;
		let width = 0;
		for (const c of map.getContainer().querySelectorAll(`${selector} > .leaflet-control`)) {
			const r = c.getBoundingClientRect();
			bottom = Math.max(bottom, r.bottom - mapRect.top);
			width = Math.max(width, selector.includes("left") ? r.right - mapRect.left : mapRect.right - r.left);
		}
		return { bottom, width };
	};
	const left = column(".leaflet-top.leaflet-left");
	const right = column(".leaflet-top.leaflet-right");

	let bottom = 16;
	let rightSide = 0;
	for (const el of document.querySelectorAll(POPUP_OBSTACLES)) {
		const r = el.getBoundingClientRect();
		if (r.height === 0) continue;
		// A sheet being minimized is still animating: count its final size.
		if (el.classList.contains("minimized")) {
			bottom = Math.max(bottom, MINIMIZED_SHEET + 8);
			continue;
		}
		if (r.left - mapRect.left < mapRect.width / 2) {
			// Spans the width (a phone's bottom sheet): keep above it.
			bottom = Math.max(bottom, mapRect.bottom - r.top + 8);
		} else if (r.bottom > mapRect.bottom - 100 && r.height < 100) {
			// A button in the bottom-right corner.
			bottom = Math.max(bottom, mapRect.bottom - r.top + 8);
		} else {
			// A side card on the right.
			rightSide = Math.max(rightSide, mapRect.right - r.left + 8);
		}
	}

	const width = popup.options.maxWidth;
	const wide = mapRect.width >= width + left.width + Math.max(right.width, rightSide) + 32;
	let topLeft, bottomRight, top;
	if (wide) {
		// Room between the left and right columns: keep it there.
		topLeft = [left.width + 8, 10];
		bottomRight = [Math.max(right.width, rightSide) + 8, bottom];
		top = 10;
	} else {
		// Phones: the popup spans the width, so it goes below the controls.
		top = Math.max(left.bottom, right.bottom) + 8;
		topLeft = [10, top];
		bottomRight = [10, bottom];
	}
	popup.options.autoPanPaddingTopLeft = L.point(topLeft);
	popup.options.autoPanPaddingBottomRight = L.point(bottomRight);
	// 24px for the popup's tip below it.
	popup.options.maxHeight = Math.max(200, mapRect.height - top - bottom - 24);
	popup.update();
}

/**
 * Builds the gas-station markers (clustered, grouped by brand) and the
 * associated brand filter control, and attaches everything to `map`.
 *
 * @param {L.Map} map                 an already-created Leaflet map
 * @param {object[]} stations         the station records to render (caller decides which ones)
 * @param {object} logos              logo/brand metadata, as returned by getLogos()
 * @param {object} [options]
 * @param {Set<string>} [options.filter]           brand keys that should start visible (default: all)
 * @param {(eess: object, blacklist: StationBlacklist|null, context: object) => string} [options.buildPopupContent]
 *        builds the popup HTML for a station. Defaults to buildDefaultPopupContent;
 *        pass `context` ({ myStations, average }) on to it when wrapping it.
 *        Use this to show different/extra info per station without touching the
 *        clustering/brand-filter logic.
 * @param {(filter: Set<string>) => any} [options.onFilterChange]
 *        called with the updated brand-filter Set whenever the user toggles a
 *        brand on/off. Defaults to persisting it via api.js's updateFilter.
 * @param {StationBlacklist} [options.blacklist]
 *        if provided (an instance of StationBlacklist), every station popup gets
 *        a button to add/remove that station from the blacklist, and
 *        blacklisted stations (both their map icon and their popup) render
 *        grayed out. Left as null, the feature is fully disabled.
 * @param {(eess: object, blacklisted: boolean, blacklist: StationBlacklist) => any} [options.onBlacklistChange]
 *        called whenever a station is added to/removed from the blacklist via
 *        the popup button. No-op by default; use it to persist the blacklist.
 * @param {boolean} [options.staleFilter]
 *        adds a switch to the brand filter that hides stations whose prices
 *        haven't changed in STALE_DAYS (on unless the viewer turned it off).
 * @param {MyStations} [options.myStations]
 *        the user's saved and hidden stations (my_stations.js): popups get
 *        save / hide buttons, saved stations a star, and hidden ones are left
 *        off the map.
 * @param {boolean} [options.mineFilter]
 *        adds switches to show only the saved stations, or the hidden ones too.
 *
 * @returns {{markers: L.MarkerClusterGroup, control: L.Control, subgroups: Array, allMarkers: L.Marker[], markersById: Map<number, L.Marker>, focus: (id: number) => boolean}}
 */
export function createStationsLayer(
	map,
	stations,
	logos,
	{
		filter = new Set([...Object.keys(logos), "other"]),
		buildPopupContent = buildDefaultPopupContent,
		onFilterChange = updateFilter,
		blacklist = null,
		onBlacklistChange = null,
		staleFilter = false,
		myStations = null,
		mineFilter = false,
	} = {},
) {
	const markers = L.markerClusterGroup({ showCoverageOnHover: false });
	map.addLayer(markers);

	let subgroupLayers = Object.fromEntries(Object.keys(logos).map((k) => [k, []]));
	subgroupLayers["other"] = [];

	const logos_sorted = sortLogos(logos);
	const allMarkers = [];
	const markersById = new Map();
	const popup = popupOptions();
	const iconFor = (eess) => buildMarkerIcon(eess, logos, logos_sorted, blacklist, myStations).icon;

	for (let eess of stations) {
		const { icon, logoKey, squareImage } = buildMarkerIcon(eess, logos, logos_sorted, blacklist, myStations);
		stationLogos.set(eess, squareImage);

		const marker = L.marker([eess.latitud, eess.longitud], {
			icon,
			riseOnHover: true,
			title: eess.rotulo,
		}).bindPopup(() => buildPopupContent(eess, blacklist, { myStations, average: averageFor(eess) }), popup);
		// Counts the popup's openings, so a slow load only fills the one it was for.
		let opens = 0;
		marker.on("popupopen", (e) => {
			// Fitting rebuilds the content, so it waits for the forecasts
			// the advice shows, and everything drawn into it comes after.
			const ready = () => {
				fitPopup(map, e.popup);
				drawHistoryChart(eess);
				attachBlacklistToggle(eess, blacklist, marker, iconFor, onBlacklistChange);
				attachMineControls(eess, myStations, () => marker.closePopup());
			};
			const open = ++opens;
			if (stationForecasts.has(eess.id)) ready();
			else loadForecasts(eess).then(() => open === opens && e.popup.isOpen() && ready());
		});

		marker.eess = eess; // keep raw data around for sorting/displaying elsewhere
		marker.logoKey = logoKey;
		allMarkers.push(marker);
		subgroupLayers[logoKey].push(marker);
		markersById.set(eess.id, marker)
	}

	const subgroups = Object.entries(subgroupLayers)
		.map(([name, layers]) => [
			name,
			// Filled by applyView below.
			L.featureGroup.subGroup(markers, []),
			layers.length,
		])
		.toSorted(([name1, , len1], [name2, , len2]) =>
			name1 == "other" ? 1 : name2 == "other" ? -1 : len2 - len1,
		);
	const subgroupOf = Object.fromEntries(subgroups.map(([name, subgroup]) => [name, subgroup]));

	// Saved stations are in a group of their own, always on the map,
	// whatever brands the filter shows.
	const savedGroup = L.featureGroup.subGroup(markers, []);

	// The switches in the brand filter decide each marker's group: its
	// brand's, the saved group, or none while they hide it. Saved stations
	// show even when stale: their popup says so.
	const view = { hideStale: false, onlySaved: false, showHidden: false };
	const groupOf = new Map();
	function wantedGroup(m) {
		const saved = myStations?.isSaved(m.eess.id);
		if (saved) return savedGroup;
		if (view.onlySaved) return null;
		if (view.hideStale && staleSince(m.eess)) return null;
		if (myStations?.isHidden(m.eess.id) && !view.showHidden) return null;
		return subgroupOf[m.logoKey];
	}
	function applyView() {
		for (const m of allMarkers) {
			const group = wantedGroup(m);
			const current = groupOf.get(m) ?? null;
			if (group === current) continue;
			current?.removeLayer(m);
			group?.addLayer(m);
			groupOf.set(m, group);
		}
		averages = null;
	}
	const isShown = (m) => {
		const group = groupOf.get(m);
		return group != null && map.hasLayer(group);
	};

	// Each province's averages over the stations on screen, until that changes.
	let averages = null;
	function averageFor(eess) {
		averages ??= provinceAverages(allMarkers.filter(isShown).map((m) => m.eess));
		return averages[eess.provincia] ?? null;
	}

	const switches = [];
	if (staleFilter) {
		const count = allMarkers.filter((m) => staleSince(m.eess)).length;
		view.hideStale = loadHideStale();
		switches.push({
			label: t("Hide stations without a price change in {days} days", { days: STALE_DAYS }),
			count: () => count,
			on: () => view.hideStale,
			set(on) {
				view.hideStale = on;
				saveHideStale(on);
				applyView();
			},
		});
	}
	if (myStations && mineFilter) {
		const count = (kind) => allMarkers.filter((m) => myStations.get(m.eess.id)?.kind === kind).length;
		switches.push(
			{
				label: t("Only my saved stations"),
				count: () => count("saved"),
				on: () => view.onlySaved,
				set(on) {
					view.onlySaved = on;
					applyView();
				},
			},
			{
				label: t("Show the stations I hid"),
				count: () => count("hidden"),
				on: () => view.showHidden,
				set(on) {
					view.showHidden = on;
					applyView();
				},
			},
		);
	}
	applyView();
	savedGroup.addTo(map);

	for (let [name, subgroup] of subgroups) {
		if (filter.has(name)) subgroup.addTo(map);
		subgroup.on("add", () => {
			filter.add(name);
			averages = null;
			onFilterChange(filter);
		});
		subgroup.on("remove", () => {
			filter.delete(name);
			averages = null;
			onFilterChange(filter);
		});
	}

	const control = createBrandFilterControl(
		subgroups
			.filter(([, , count]) => count > 0)
			.map(([name, subgroup, count]) => ({
				name,
				text: name == "other" ? t("Others") : logos[name].text,
				image: name == "other" ? null : (logos[name].icon ?? logos[name].image),
				subgroup,
				count,
			})),
		switches,
	);
	control.addTo(map);

	if (myStations) {
		// Stops listening once the layer is taken off the map (route pages rebuild it).
		const onChange = (id) => {
			if (!map.hasLayer(markers)) return myStations.off(onChange);
			const marker = markersById.get(id);
			const update = () => {
				applyView();
				control.refresh();
			};
			if (!marker) return update();
			marker.setIcon(iconFor(marker.eess));
			// Taking it off the map would close the popup the user is using.
			if (marker.isPopupOpen()) marker.once("popupclose", update);
			else update();
		};
		myStations.on(onChange);
	}

	// Centres the map on a station and opens its popup, if it's shown.
	function focus(id) {
		const marker = markersById.get(id);
		if (!marker) return false;
		map.setView(marker.getLatLng(), Math.max(map.getZoom(), 15));
		if (!isShown(marker)) return false;
		markers.zoomToShowLayer(marker, () => marker.openPopup());
		return true;
	}

	return { markers, control, subgroups, allMarkers, markersById, focus };
}
