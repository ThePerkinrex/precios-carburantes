// The fuel tax cuts page: the periods, the safeguards' CPI and the next
// change, all from fuel_taxes.js.

import { getUserState } from "./api.js";
import { LOCALE, t } from "./i18n.js";
import { formatEuros } from "./money.js";
import { renderNav } from "./nav.js";
import { CPI_THRESHOLD, FUEL_NAMES, loadFuelTaxes, nextTaxChange, safeguardCpi, taxPeriods } from "./fuel_taxes.js";

const FUELS = Object.keys(FUEL_NAMES);
const next = document.getElementById("next");
const periods = document.getElementById("periods");
const periodNotes = document.getElementById("periodNotes");
const cpiTable = document.getElementById("cpi");
const cpiStatus = document.getElementById("cpiStatus");

const cut = (euros) => (euros ? `−${formatEuros(euros)}` : "–");
const percent = (v) => `${v > 0 ? "+" : ""}${v.toLocaleString(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;

function renderNext() {
	const change = nextTaxChange();
	next.replaceChildren();
	if (!change) {
		next.textContent = t("No changes planned.");
		return;
	}
	const strong = document.createElement("strong");
	strong.textContent = t("As it stands, from {date}:", { date: change.label });
	next.append(strong, ` ${change.text}`);
}

function renderPeriods() {
	const notes = [];
	periods.tBodies[0].replaceChildren(
		...taxPeriods().map((p) => {
			const row = document.createElement("tr");
			row.innerHTML = `<th scope="row"></th><td></td><td></td><td></td><td></td>`;
			row.cells[0].textContent = p.planned ? t("{date}, planned", { date: p.label }) : p.label;
			row.cells[1].textContent = `${Math.round(p.vat * 100)} %`;
			FUELS.forEach((f, i) => {
				const { note } = p.fuels[f];
				row.cells[2 + i].textContent = cut(p.fuels[f].cut);
				if (note) {
					notes.push(`${p.label}, ${FUEL_NAMES[f]}: ${note}.`);
					row.cells[2 + i].textContent += ` (${notes.length})`;
				}
			});
			row.cells[4].textContent = p.law;
			if (p.planned) row.classList.add("planned");
			return row;
		}),
	);
	periodNotes.replaceChildren(
		...notes.map((text, i) => {
			const li = document.createElement("li");
			li.textContent = `(${i + 1}) ${text}`;
			return li;
		}),
	);
}

function renderCpi() {
	cpiTable.tBodies[0].replaceChildren(
		...safeguardCpi().map((c) => {
			const row = document.createElement("tr");
			row.innerHTML = `<th scope="row"></th><td></td><td></td>`;
			row.cells[0].textContent = c.label;
			FUELS.forEach((f, i) => {
				const cell = row.cells[1 + i];
				const known = c.fuels[f];
				if (!known) {
					cell.textContent = t("not out yet");
					return;
				}
				cell.textContent = percent(known.value) + (known.estimated ? ` (${t("estimate")})` : "");
				if (known.value > CPI_THRESHOLD) cell.classList.add("over");
			});
			return row;
		}),
	);
}

function render() {
	renderNext();
	renderPeriods();
	renderCpi();
}

getUserState().then((s) => renderNav(document.getElementById("nav"), s, "taxes"));
cpiStatus.textContent = t("Loading INE's figures…");
render();
loadFuelTaxes()
	.then(() => {
		cpiStatus.textContent = t("In bold, over the {threshold} % that triggers the bigger cut.", { threshold: CPI_THRESHOLD });
		render();
	})
	.catch((err) => {
		console.error("Failed to load the fuel CPI:", err);
		cpiStatus.textContent = t("Couldn't reach INE, so only the figures already known are shown.");
	});
