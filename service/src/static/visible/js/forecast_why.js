// The outlook's "Why?": each national forecast split into what moves it
// (`explicacion`, from national::Model::explain in downloader/src/forecast).
// The model is linear, so the parts add up to the forecast change exactly.

import { t } from "./i18n.js";
import { formatEuros } from "./money.js";

const FUEL_NAMES = { gasolina_95: "Gasolina 95", gasoleo_a: "Gasóleo A" };
// Under this, a part shows as nothing (€/L).
const TINY = 0.0005;

// The parts in a fixed order, so the two fuels read the same way. `note`
// gives the facts behind the part from the explanation.
const PARTS = [
	{
		key: "taxes",
		label: () => t("Tax changes"),
		note: (e, h) =>
			Math.abs(e.scheduled_taxes) < TINY
				? t("None scheduled in the next {n} days.", { n: h })
				: t("Scheduled ones would move the price {change} if passed on in full.", {
					change: formatEuros(e.scheduled_taxes, { signed: true }),
				}),
	},
	{
		key: "trend",
		label: () => t("Recent pump price trend"),
		note: (e) => t("Before taxes: {week} in the last 7 days, {month} in 28.", {
			week: formatEuros(e.pump_7d, { signed: true }),
			month: formatEuros(e.pump_28d, { signed: true }),
		}),
	},
	{
		key: "wholesale",
		label: () => t("Wholesale futures"),
		note: (e) => t("With VAT: {week} in the last 7 days, {month} in 28.", {
			week: formatEuros(e.wholesale_7d, { signed: true }),
			month: formatEuros(e.wholesale_28d, { signed: true }),
		}),
	},
	{
		key: "margin",
		label: () => t("Gap over wholesale"),
		note: (e) => t("The pump price is {gap} over the futures (with VAT); {usual} on average since 2007.", {
			gap: formatEuros(e.margin),
			usual: formatEuros(e.usual_margin),
		}),
	},
	{
		key: "weekday",
		label: () => t("Day of the week"),
		note: () => t("Some weekdays see more price changes than others."),
	},
	{
		key: "base",
		label: () => t("Usual drift"),
		note: () => t("The average change over that many days in past years."),
	},
];

const signed = (v) => (Math.abs(v) < TINY ? "≈ 0" : formatEuros(v, { signed: true }));

let horizon = null;

// Fills `box` (the <details>) for `forecasts`; hidden if none has an
// explanation (forecasts made before they were stored).
export function renderWhy(box, forecasts, colors) {
	const explained = forecasts.filter((f) => f.explicacion);
	box.hidden = !explained.length;
	if (!explained.length) return;
	const horizons = [...new Set(explained.map((f) => f.horizonte))].sort((a, b) => a - b);
	if (!horizons.includes(horizon)) horizon = horizons.at(-1);

	const group = box.querySelector(".segmented");
	group.replaceChildren(
		...horizons.map((h) => {
			const button = document.createElement("button");
			button.type = "button";
			button.setAttribute("role", "radio");
			button.setAttribute("aria-checked", h === horizon);
			button.textContent = h === 1 ? t("1 day") : t("{n} days", { n: h });
			button.addEventListener("click", () => {
				horizon = h;
				renderWhy(box, forecasts, colors);
			});
			return button;
		}),
	);

	const shown = explained.filter((f) => f.horizonte === horizon);
	// One scale for both fuels, so their bars compare.
	const largest = Math.max(TINY, ...shown.flatMap((f) => PARTS.map((p) => Math.abs(f.explicacion.parts[p.key]))));
	box.querySelector(".why-list").replaceChildren(
		...Object.keys(FUEL_NAMES)
			.map((fuel) => shown.find((f) => f.combustible === fuel))
			.filter(Boolean)
			.map((f) => fuelBlock(f, largest, colors[f.combustible])),
	);
}

function fuelBlock(f, largest, color) {
	const e = f.explicacion;
	const block = document.createElement("section");
	block.className = "why-fuel";
	const head = document.createElement("h3");
	head.innerHTML = `<span class="swatch"></span><span></span><span class="why-total"></span>`;
	head.firstChild.style.background = color;
	head.children[1].textContent = FUEL_NAMES[f.combustible];
	const total = head.lastChild;
	total.textContent = Math.abs(f.cambio) < TINY ? t("No change") : `${f.cambio > 0 ? "▲" : "▼"} ${formatEuros(Math.abs(f.cambio))}`;
	total.classList.add(Math.abs(f.cambio) < TINY ? "flat" : f.cambio > 0 ? "up" : "down");
	block.append(head);

	const list = document.createElement("ul");
	list.className = "why-parts";
	for (const part of PARTS) {
		const value = e.parts[part.key];
		const item = document.createElement("li");
		const direction = Math.abs(value) < TINY ? "flat" : value > 0 ? "up" : "down";
		item.className = `why-part ${direction}`;
		item.innerHTML = `<span class="why-label"></span><span class="why-value"></span><span class="why-bar" aria-hidden="true"><i></i></span><span class="why-note"></span>`;
		item.querySelector(".why-label").textContent = part.label();
		item.querySelector(".why-value").textContent = signed(value);
		item.querySelector(".why-note").textContent = part.note(e, f.horizonte);
		// Bars grow from the middle: right pushes the price up, left down.
		const bar = item.querySelector(".why-bar i");
		const width = (Math.abs(value) / largest) * 50;
		bar.style.width = `${width}%`;
		bar.style.left = value >= 0 ? "50%" : `${50 - width}%`;
		list.append(item);
	}
	block.append(list);
	return block;
}
