// The price board: latest average prices from /api/prices/history, shown
// like the price signs outside petrol stations.

import { formatDate, formatDateTime, parseFecha } from "./dates.js";
import { LOCALE, t } from "./i18n.js";

const FUELS = [
	{ key: "gasolina_95", name: "Gasolina 95", className: "g95" },
	{ key: "gasoleo_a", name: "Gasóleo A", className: "diesel" },
];

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// `from` (a Date) limits the history to the snapshots at or after it.
export async function getPriceHistory({ ccaa, provincia, from } = {}) {
	const params = new URLSearchParams();
	if (ccaa) params.set("ccaa_id", ccaa);
	if (provincia) params.set("provincia_id", provincia);
	if (from) params.set("from", from.toISOString());
	const response = await fetch(`/api/prices/history?${params}`);
	if (!response.ok) throw new Error(t("Couldn't load prices (HTTP {status}).", { status: response.status }));
	return (await response.json()).map((point) => ({ ...point, date: parseFecha(point.fecha) }));
}

// 1.629 -> "1,62<small>9</small>": the last digit smaller, as on the signs.
function priceHtml(value) {
	const [whole, thousandths] = value.toLocaleString(LOCALE, { minimumFractionDigits: 3, maximumFractionDigits: 3 }).split(/(\d)$/);
	return `${whole}<small>${thousandths}</small><span class="unit">€/L</span>`;
}

// The change between two prices in euro cents.
function deltaText(now, before) {
	const cents = (now - before) * 100;
	if (Math.abs(cents) < 0.05) return { text: t("No change"), className: "" };
	const amount = Math.abs(cents).toLocaleString(LOCALE, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
	return cents > 0
		? { text: `▲ ${t("{amount} cents", { amount })}`, className: "up" }
		: { text: `▼ ${t("{amount} cents", { amount })}`, className: "down" };
}

// 0.123 -> "12,3 cents"
function centsText(euros) {
	const amount = (euros * 100).toLocaleString(LOCALE, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
	return t("{amount} cents", { amount });
}

function boardHead(board, where) {
	board.innerHTML = `<div class="board-head"><span></span><strong></strong></div>`;
	board.querySelector("span").textContent = t("Average price");
	board.querySelector("strong").textContent = where;
}

// Fills `board` with the last point of `history`, compared with the last
// point at least a week older (or the oldest one, if there's less history).
// With `baseline: "start"` it's compared with the first point instead.
export function renderBoard(board, history, where, { baseline = "week" } = {}) {
	const latest = history.at(-1);
	if (!latest) {
		boardHead(board, where);
		const empty = document.createElement("p");
		empty.className = "board-empty";
		empty.textContent = t("No prices recorded for this area yet.");
		board.append(empty);
		return;
	}
	const cutoff = latest.date.getTime() - WEEK_MS;
	const before = baseline === "start"
		? history[0]
		: (history.findLast((p) => p.date.getTime() <= cutoff) ?? history[0]);
	const compare = before !== latest;

	boardHead(board, where);
	for (const fuel of FUELS) {
		const value = latest[fuel.key];
		if (value == null) continue;
		const row = document.createElement("div");
		row.className = `board-row ${fuel.className}`;
		row.innerHTML = `<span class="fuel">${fuel.name}</span><span class="price">${priceHtml(value)}</span>`;
		if (compare && before[fuel.key] != null) {
			const delta = deltaText(value, before[fuel.key]);
			const span = document.createElement("span");
			span.className = `delta ${delta.className}`;
			span.textContent = delta.text;
			row.append(span);
		}
		board.append(row);
	}
	if (latest.gasolina_95 != null && latest.gasoleo_a != null) {
		const spread = latest.gasolina_95 - latest.gasoleo_a;
		const row = document.createElement("p");
		row.className = "board-spread";
		row.textContent = t(spread >= 0 ? "Diesel is {amount} cheaper than Gasolina 95" : "Diesel is {amount} dearer than Gasolina 95", {
			amount: centsText(Math.abs(spread)),
		});
		board.append(row);
	}
	const foot = document.createElement("p");
	foot.className = "board-foot";
	foot.textContent = t("Updated {date}", { date: formatDateTime(latest.date) });
	if (compare) foot.textContent += `. ${t("Change since {date}.", { date: formatDate(before.date) })}`;
	board.append(foot);
}
