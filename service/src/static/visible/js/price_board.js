// The price board: latest average prices from /api/prices/history, shown
// like the price signs outside petrol stations.

import { formatDate, formatDateTime, parseFecha } from "./dates.js";

const FUELS = [
	{ key: "gasolina_95", name: "Gasolina 95", className: "g95" },
	{ key: "gasoleo_a", name: "Gasóleo A", className: "diesel" },
];

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function getPriceHistory({ ccaa, provincia } = {}) {
	const params = new URLSearchParams();
	if (ccaa) params.set("ccaa_id", ccaa);
	if (provincia) params.set("provincia_id", provincia);
	const response = await fetch(`/api/prices/history?${params}`);
	if (!response.ok) throw new Error(`Couldn't load prices (HTTP ${response.status}).`);
	return (await response.json()).map((point) => ({ ...point, date: parseFecha(point.fecha) }));
}

// 1.629 -> "1,62<small>9</small>": the last digit smaller, as on the signs.
function priceHtml(value) {
	const [whole, thousandths] = value.toLocaleString("es-ES", { minimumFractionDigits: 3, maximumFractionDigits: 3 }).split(/(\d)$/);
	return `${whole}<small>${thousandths}</small><span class="unit">€/l</span>`;
}

// The change between two prices in euro cents.
function deltaText(now, before) {
	const cents = (now - before) * 100;
	if (Math.abs(cents) < 0.05) return { text: "No change", className: "" };
	const amount = Math.abs(cents).toLocaleString("es-ES", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
	return cents > 0
		? { text: `▲ ${amount} cents`, className: "up" }
		: { text: `▼ ${amount} cents`, className: "down" };
}

// Fills `board` with the last point of `history`, compared with the last
// point at least a week older (or the oldest one, if there's less history).
export function renderBoard(board, history, where) {
	const latest = history.at(-1);
	if (!latest) {
		board.innerHTML = `<div class="board-head"><span>Average price</span><strong></strong></div>
			<p class="board-empty">No prices recorded for this area yet.</p>`;
		board.querySelector("strong").textContent = where;
		return;
	}
	const cutoff = latest.date.getTime() - WEEK_MS;
	const before = history.findLast((p) => p.date.getTime() <= cutoff) ?? history[0];
	const compare = before !== latest;

	board.innerHTML = `<div class="board-head"><span>Average price</span><strong></strong></div>`;
	board.querySelector("strong").textContent = where;
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
	const foot = document.createElement("p");
	foot.className = "board-foot";
	foot.textContent = `Updated ${formatDateTime(latest.date)}`;
	if (compare) foot.textContent += `. Change since ${formatDate(before.date)}.`;
	board.append(foot);
}
