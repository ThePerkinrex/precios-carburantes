// Spain's temporary fuel tax cuts since March 2026 (the Middle East crisis
// plans), so the trends can show what prices would have been without them.
// They cover the stations under the general IVA and Impuesto sobre
// Hidrocarburos: everywhere but Canarias, Ceuta and Melilla, which the
// history API leaves out of its `taxed` averages.
//
// Some months' cuts hang on safeguard clauses: a bigger cut if the fuel's
// CPI (INE subclass) for an earlier month rose over 15% year on year.
// loadFuelTaxes() settles them with INE's figures and, until INE publishes
// a month, with an estimate from our own average prices.

import { formatDate, parseFecha } from "./dates.js";
import { LOCALE, t } from "./i18n.js";
import { formatEuros } from "./money.js";
import { getPriceHistory } from "./price_board.js";

// The page explaining the cuts.
export const TAXES_PAGE = "/files/taxes";
const DAY_MS = 24 * 60 * 60 * 1000;
const NORMAL_VAT = 0.21;
const FUELS = ["gasolina_95", "gasoleo_a"];
// Stations sell the stock they bought under the old taxes for a few days,
// so prices don't settle at once.
export const SETTLE_DAYS = 4;
// Safeguards trigger when the fuel's CPI rose more than this, in %.
export const CPI_THRESHOLD = 15;

// INE CPI series, ECOICOP subclasses 07.2.2.2 (Gasolina) and 07.2.2.1
// (Gasóleo): year-on-year change (%) and index.
const CPI_SERIES = {
	gasolina_95: { change: "IPC291538", index: "IPC291539" },
	gasoleo_a: { change: "IPC291534", index: "IPC291535" },
};
// The changes the safeguards so far hung on, in case INE can't be reached.
const KNOWN_CPI = {
	"2026-06": { gasolina_95: 1.3, gasoleo_a: 14.1 },
	"2026-07": { gasolina_95: 7.3, gasoleo_a: 15.7 },
	"2026-09": { gasolina_95: 27.5, gasoleo_a: 34.0 },
};

// A cut for both fuels: a number, or { base, safeguards } where each
// safeguard is { cpi: "YYYY-MM", cut }, the first one triggered winning.
const both = (cut) => ({ gasolina_95: cut, gasoleo_a: cut });

// Each period runs from its first day until the next period starts. `vat` is
// the IVA rate; `cut` is the cut in the hydrocarbon tax, in €/L, by fuel.
// Sources: BOE and Agencia Tributaria.
const PERIODS = [
	// Both taxes down to the EU minimums, 22/03 to 30/06.
	{ from: "2026-03-22", vat: 0.1, cut: { gasolina_95: 0.11369, gasoleo_a: 0.049 }, law: "RDL 7/2026" },
	// IVA back to 21%, the hydrocarbon tax cut tapers off.
	{ from: "2026-07-01", vat: NORMAL_VAT, cut: both(0.15), law: "RDL 18/2026" },
	{ from: "2026-08-01", vat: NORMAL_VAT, cut: both({ base: 0.1, safeguards: [{ cpi: "2026-06", cut: 0.2 }] }), law: "RDL 18/2026" },
	{
		from: "2026-09-01",
		vat: NORMAL_VAT,
		cut: both({ base: 0.05, safeguards: [{ cpi: "2026-07", cut: 0.2 }, { cpi: "2026-06", cut: 0.15 }] }),
		law: "RDL 18/2026",
	},
	{ from: "2026-10-01", vat: NORMAL_VAT, cut: both(0.2), law: "RDL 25/2026" },
	{ from: "2026-11-01", vat: NORMAL_VAT, cut: both({ base: 0.13, safeguards: [{ cpi: "2026-09", cut: 0.2 }] }), law: "RDL 25/2026" },
	{
		from: "2026-12-01",
		vat: NORMAL_VAT,
		cut: both({ base: 0.06, safeguards: [{ cpi: "2026-10", cut: 0.2 }, { cpi: "2026-09", cut: 0.13 }] }),
		law: "RDL 25/2026",
	},
	// RDL 25/2026 ends the cuts on 31/12; nothing extends them yet.
	{ from: "2027-01-01", vat: NORMAL_VAT, cut: both(0), law: "RDL 25/2026" },
].map((p) => ({ ...p, date: parseFecha(`${p.from} 00:00:00`) }));

// CPI changes by "YYYY-MM" and fuel, as { value, estimated }.
let cpi = new Map(
	Object.entries(KNOWN_CPI).map(([month, byFuel]) => [
		month,
		Object.fromEntries(FUELS.map((f) => [f, { value: byFuel[f], estimated: false }])),
	]),
);

// What a period's cut for `fuel` comes to with the CPI known now:
// { cut, cpi: { month, value, estimated } | undefined, pending, month }.
// `pending` means the CPI for `month` isn't out or estimable yet, so `cut`
// may still grow.
function cutOf(period, fuel) {
	const rule = period.cut[fuel];
	if (typeof rule === "number") return { cut: rule, pending: false };
	for (const s of rule.safeguards) {
		const known = cpi.get(s.cpi)?.[fuel];
		if (!known) return { cut: rule.base, pending: true, month: s.cpi };
		if (known.value > CPI_THRESHOLD) return { cut: s.cut, cpi: { month: s.cpi, ...known }, pending: false };
	}
	// None triggered: the first, the one the bigger cut was mostly about.
	const first = rule.safeguards[0].cpi;
	return { cut: rule.base, cpi: { month: first, ...cpi.get(first)[fuel] }, pending: false };
}

function periodAt(date) {
	return PERIODS.findLast((p) => p.date <= date);
}

// What `fuel` would have cost on average at history point `point` without
// the cuts. Cuts in the hydrocarbon tax pay IVA too.
export function untaxedPrice(point, fuel) {
	const price = point[fuel];
	const period = periodAt(point.date);
	const taxed = point.taxed?.[fuel];
	const share = point.taxed?.[`share_${fuel}`];
	if (price == null || !period || taxed == null || !share) return price;
	const untaxed = (taxed / (1 + period.vat) + cutOf(period, fuel).cut) * (1 + NORMAL_VAT);
	return price + share * (untaxed - taxed);
}

const hasCut = (p) => p.vat !== NORMAL_VAT || FUELS.some((f) => cutOf(p, f).cut);

// Whether any cut applies between `start` and `end` (Dates).
export function anyCutBetween(start, end) {
	return PERIODS.some((p, i) => {
		const until = PERIODS[i + 1]?.date ?? Infinity;
		return p.date <= end && until > start && hasCut(p);
	});
}

// Whether prices may still be adjusting to a change around `date`: within
// `before` ms before it or SETTLE_DAYS (plus `after` ms) after a change.
export function settling(date, { before = 0, after = 0 } = {}) {
	const time = date.getTime();
	return PERIODS.some((p) => time >= p.date.getTime() - before && time < p.date.getTime() + SETTLE_DAYS * DAY_MS + after);
}

// ---------- Describing the changes ----------

export const FUEL_NAMES = { gasolina_95: "Gasolina 95", gasoleo_a: "Gasóleo A" };
const percent = (v) => `${v > 0 ? "+" : ""}${v.toLocaleString(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}\u00a0%`;
// "2026-10" -> "10/2026"
const monthLabel = (month) => month.split("-").reverse().join("/");

// Why a fuel's cut came out the way it did, or "" for a fixed one.
function cpiNote(resolved) {
	if (resolved.pending) return t("depends on the CPI for {month}, not out yet", { month: monthLabel(resolved.month) });
	if (!resolved.cpi) return "";
	const params = { month: monthLabel(resolved.cpi.month), change: percent(resolved.cpi.value) };
	return resolved.cpi.estimated
		? t("CPI for {month} estimated at {change}", params)
		: t("CPI for {month}: {change}", params);
}

function describe(period) {
	const resolved = Object.fromEntries(FUELS.map((f) => [f, cutOf(period, f)]));
	const parts = [`${t("IVA")} ${Math.round(period.vat * 100)}\u00a0%`];
	const g95 = resolved.gasolina_95.cut;
	const diesel = resolved.gasoleo_a.cut;
	if (!g95 && !diesel) parts.push(t("no hydrocarbon tax cut"));
	else if (g95 === diesel) parts.push(t("hydrocarbon tax −{amount}/L", { amount: formatEuros(g95) }));
	else parts.push(t("hydrocarbon tax −{g95}/L Gasolina 95, −{diesel}/L Gasóleo A", { g95: formatEuros(g95), diesel: formatEuros(diesel) }));
	let text = `${parts.join(", ")} (${period.law}).`;
	const notes = FUELS.map((f) => [f, cpiNote(resolved[f])]).filter(([, note]) => note);
	if (notes.length === 2 && notes[0][1] === notes[1][1]) text += ` ${notes[0][1]}.`;
	else for (const [f, note] of notes) text += ` ${FUEL_NAMES[f]}: ${note}.`;
	return { resolved, text };
}

// Every period with its cuts as they stand, for the explanation page:
// { label, planned, vat, law, fuels: { [fuel]: { cut, note } } }.
export function taxPeriods(now = new Date()) {
	return PERIODS.map((p) => ({
		label: formatDate(p.date),
		planned: p.date > now,
		vat: p.vat,
		law: p.law,
		fuels: Object.fromEntries(FUELS.map((f) => {
			const resolved = cutOf(p, f);
			return [f, { cut: resolved.cut, note: cpiNote(resolved) }];
		})),
	}));
}

// The CPI months the safeguards hang on, oldest first, as { month, label,
// fuels: { [fuel]: { value, estimated } | undefined } }.
export function safeguardCpi() {
	const months = [...new Set(PERIODS.flatMap((p) => FUELS.flatMap((f) => p.cut[f].safeguards?.map((s) => s.cpi) ?? [])))].sort();
	return months.map((month) => ({
		month,
		label: monthLabel(month),
		fuels: Object.fromEntries(FUELS.map((f) => [f, cpi.get(month)?.[f]])),
	}));
}

// Every change, as { date, label, planned, text }, oldest first.
export function taxChanges(now = new Date()) {
	return PERIODS.map((p) => ({ date: p.date, label: formatDate(p.date), planned: p.date > now, text: describe(p).text }));
}

// The next change as it stands, as { label, text }: what it does to each
// fuel's pump price and how sure that is.
export function nextTaxChange(now = new Date()) {
	const i = PERIODS.findIndex((p) => p.date > now);
	if (i <= 0) return undefined;
	const [before, after] = [PERIODS[i - 1], PERIODS[i]];
	const { resolved } = describe(after);
	const effects = FUELS.map((f) => {
		const cutBefore = cutOf(before, f).cut;
		const cutAfter = resolved[f].cut;
		// The pump price moves by the tax change plus its IVA.
		const priceChange = (cutBefore - cutAfter) * (1 + after.vat);
		let text = Math.abs(priceChange) < 0.0005
			? t("{fuel}: no change, the cut stays at {cut}", { fuel: FUEL_NAMES[f], cut: formatEuros(cutAfter) })
			: t("{fuel}: cut {from} → {to}, about {change}/L at the pump", {
				fuel: FUEL_NAMES[f],
				from: formatEuros(cutBefore),
				to: formatEuros(cutAfter),
				change: formatEuros(priceChange, { signed: true }),
			});
		const note = cpiNote(resolved[f]);
		if (note) text += ` (${note})`;
		return text;
	});
	const final = i === PERIODS.length - 1;
	return {
		label: formatDate(after.date),
		text: `${effects.join(". ")}.${final ? ` ${t("Unless a new decree extends the cuts.")}` : ""}`,
	};
}

// ---------- Loading the CPI ----------

// An INE series as a Map of "YYYY-MM" -> value.
async function ineSeries(code) {
	const response = await fetch(`https://servicios.ine.es/wstempus/js/ES/DATOS_SERIE/${code}?nult=24`);
	if (!response.ok) throw new Error(`INE ${code}: HTTP ${response.status}`);
	const { Data } = await response.json();
	return new Map(Data.map((d) => [`${d.Anyo}-${String(d.FK_Periodo).padStart(2, "0")}`, d.Valor]));
}

const monthKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;

// The year-on-year CPI change for `month` before INE publishes it: the last
// published index moved by how much our average price moved since, against
// the index a year before. Within about a point of INE's figure.
function estimateChange(month, lastMonth, index, history, fuel) {
	const average = (m) => {
		const values = history.filter((p) => monthKey(p.date) === m && p[fuel] != null).map((p) => p[fuel]);
		return values.length ? values.reduce((a, b) => a + b) / values.length : undefined;
	};
	const [year, m] = month.split("-");
	const yearBefore = index.get(`${year - 1}-${m}`);
	const now = average(month);
	const then = average(lastMonth);
	if (!yearBefore || !index.get(lastMonth) || !now || !then) return undefined;
	return ((index.get(lastMonth) * now) / then / yearBefore - 1) * 100;
}

// Settles the safeguards with INE's CPI, estimating the months the
// safeguards need that INE hasn't published yet. Without INE, the known
// figures stand and the rest stay pending.
export async function loadFuelTaxes() {
	const needed = safeguardCpi().map((c) => c.month);
	const series = await Promise.all(
		FUELS.map(async (f) => ({ fuel: f, change: await ineSeries(CPI_SERIES[f].change), index: await ineSeries(CPI_SERIES[f].index) })),
	);
	const next = new Map(cpi);
	const set = (month, fuel, value, estimated) => next.set(month, { ...next.get(month), [fuel]: { value, estimated } });
	for (const { fuel, change } of series) for (const [month, value] of change) set(month, fuel, value, false);

	const current = monthKey(new Date());
	const unpublished = needed.filter((m) => m <= current && FUELS.some((f) => !next.get(m)?.[f]));
	if (unpublished.length) {
		const lastPublished = (s) => [...s.index.keys()].sort().at(-1);
		const from = parseFecha(`${series.map(lastPublished).sort()[0]}-01 00:00:00`);
		const history = await getPriceHistory({ from });
		for (const month of unpublished) {
			for (const s of series) {
				if (next.get(month)?.[s.fuel]) continue;
				const value = estimateChange(month, lastPublished(s), s.index, history, s.fuel);
				if (value != null) set(month, s.fuel, value, true);
			}
		}
	}
	cpi = next;
}
