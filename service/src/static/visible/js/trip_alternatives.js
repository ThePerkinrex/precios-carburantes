// Bottom panel listing the fuel-stop plans from fuel_planner.js. One plan is
// selected at a time (the first by default); the page highlights its stops.

import { LOCALE, t, tn } from "./i18n.js";

const STATUS_FLAGS = {
	closesSoon: { text: t("closes soon"), className: "warn" },
	unknown: { text: t("unknown hours"), className: "warn" },
};

function formatKm(km) {
	return km.toFixed(km < 10 ? 1 : 0);
}

function formatTime(date, departure) {
	const time = date.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit", hour12: false });
	const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	const days = Math.round((startOfDay(date) - startOfDay(departure)) / 86400000);
	return days > 0 ? `${time} (${t("+{n}d", { n: days })})` : time;
}

// Why there's no plan, in words, with what the user can change about it.
function diagnosisMessage(diagnosis) {
	switch (diagnosis?.reason) {
		case "loading":
			return [t("Loading stations…")];
		case "error":
			return [t("Couldn't load the stations along the route. Reload the page to try again.")];
		case "no_car":
			return [t("Set your car's consumption and tank size (⛽) to work out the stops.")];
		case "bad_range":
			return [t("The fill-up range isn't valid: the minimum has to be less than the maximum and the tank size (⛽).")];
		case "low_start":
			return [t("You're setting off with less fuel than the fill-up minimum. Check the fuel now (⛽).")];
		case "gap": {
			const lines = [
				t("There's no usable station between km {from} and km {to}, which is where you'd need to fill up.", {
					from: formatKm(diagnosis.fromKm),
					to: formatKm(diagnosis.toKm),
				}),
				t("Try a larger distance from the route or fill-up range (⛽), showing more brands, or including some excluded stations again."),
			];
			if (diagnosis.closedCount) {
				lines.push(
					tn(
						diagnosis.closedCount,
						"{n} station left out for being closed when you'd arrive.",
						"{n} stations left out for being closed when you'd arrive.",
					),
				);
			}
			return lines;
		}
		default:
			return [t("No plan found.")];
	}
}

/**
 * @param {object} [options]
 * @param {(station: object) => any} [options.onStationClick]
 * @param {(plan: object | null) => any} [options.onPlanSelect]  called with
 *        the selected plan whenever it changes (null when there are none)
 */
export function createTripAlternativesPanel(options = {}) {
	const onStationClick = options.onStationClick || function (station) {};
	const onPlanSelect = options.onPlanSelect || function (plan) {};
	// Called when the user opens the sheet from its header.
	const onExpand = options.onExpand || function () {};

	const panel = document.createElement("div");
	panel.className = "trip-alternatives-panel";
	panel.innerHTML = `
		<div class="trip-panel-header" title="${t("Show or hide the panel")}">
			<span>${t("Trip options")}</span>
			<button class="trip-panel-toggle" aria-label="${t("Minimize panel")}">&#9650;</button>
		</div>
		<div class="trip-panel-trip"></div>
		<div class="trip-plans-list"></div>
	`;

	document.body.appendChild(panel);

	const header = panel.querySelector(".trip-panel-header");

	header.addEventListener("click", () => {
		if (!panel.classList.toggle("minimized")) onExpand();
	});

	const plansList = panel.querySelector(".trip-plans-list");

	function renderStop(s, i, departure) {
		const li = document.createElement("li");
		li.className = "trip-stop-item clickable";

		const name = document.createElement("div");
		name.className = "trip-stop-station";
		name.textContent = `${i + 1}. ${s.station.rotulo} (${s.station.municipio})`;

		const flag = STATUS_FLAGS[s.status];
		if (flag) {
			const tag = document.createElement("span");
			tag.className = `trip-stop-flag ${flag.className}`;
			tag.textContent = flag.text;
			name.append(" ", tag);
		}

		const km = (s.station.distance_along_route / 1000).toFixed(1);
		const detour = s.detourM >= 100 ? ` • ${t("~{km} km detour", { km: (s.detourM / 1000).toFixed(1) })}` : "";
		const details = document.createElement("div");
		details.className = "trip-stop-details";
		details.innerHTML = `
			km ${km} • ${formatTime(s.eta, departure)}${detour}<br>
			${t("Arriving with: {liters} L", { liters: s.arrivalFuel.toFixed(1) })} • ${t("Fill up: {liters} L ({price} €/L)", {
				liters: s.litersBought.toFixed(1),
				price: s.pricePerLiter.toFixed(3),
			})} = <strong>${s.cost.toFixed(2)} €</strong>
		`;

		li.append(name, details);
		li.addEventListener("click", (e) => {
			e.stopPropagation();
			onStationClick(s.station);
		});
		return li;
	}

	function renderPlan(plan, planIdx, departure, selected, select) {
		const onTripCost = plan.totalCost - plan.destRefillCost;
		const card = document.createElement("div");
		card.className = "trip-plan-card" + (selected ? " selected" : "");
		card.addEventListener("click", select);

		const cardTitle = document.createElement("div");
		cardTitle.className = "trip-plan-title";
		cardTitle.textContent =
			plan.totalStops === 0
				? t("Option {i} (no stops)", { i: planIdx + 1 })
				: tn(plan.totalStops, "Option {i} ({n} stop)", "Option {i} ({n} stops)", { i: planIdx + 1 });
		card.appendChild(cardTitle);

		const stopsUl = document.createElement("ul");
		stopsUl.className = "trip-plan-stops";

		if (plan.stops.length === 0) {
			const emptyLi = document.createElement("li");
			emptyLi.className = "trip-stop-item empty";
			emptyLi.textContent = t("You get there without filling up on the way");
			stopsUl.appendChild(emptyLi);
		} else {
			plan.stops.forEach((s, i) => stopsUl.appendChild(renderStop(s, i, departure)));
		}
		card.appendChild(stopsUl);

		const destPriceInfo =
			plan.destPricePerLiter != null
				? t("Fill up on arrival ({liters} L at {price} €/L): {cost} €", {
						liters: plan.destRefillLiters.toFixed(1),
						price: plan.destPricePerLiter.toFixed(3),
						cost: plan.destRefillCost.toFixed(2),
					})
				: t("No estimated price at the destination");

		const summaryDiv = document.createElement("div");
		summaryDiv.className = "trip-plan-summary";
		summaryDiv.innerHTML = `
			<div>${t("Cost on the road: {cost} €", { cost: onTripCost.toFixed(2) })}</div>
			<div>${t("Destination ({liters} L left)", { liters: plan.finalArrivalFuel.toFixed(1) })}: ${destPriceInfo}</div>
			<div class="trip-plan-total">${t("Estimated total cost: {cost} €", { cost: plan.totalCost.toFixed(2) })}</div>
		`;
		card.appendChild(summaryDiv);
		return card;
	}

	let selectedIdx = 0;

	return {
		/**
		 * @param {{ plans: object[], diagnosis: object | null }} result from planStops
		 *        (or { plans: [], diagnosis: { reason: "loading" } })
		 * @param {Date} departure
		 */
		update({ plans, diagnosis }, departure) {
			plansList.innerHTML = "";

			if (!plans.length) {
				const msg = document.createElement("div");
				msg.className = "trip-empty-msg";
				for (const line of diagnosisMessage(diagnosis)) {
					const p = document.createElement("p");
					p.textContent = line;
					msg.appendChild(p);
				}
				plansList.appendChild(msg);
				onPlanSelect(null);
				return;
			}

			// Recomputing (new prices, settings...) keeps the same option
			// number selected when it still exists.
			if (selectedIdx >= plans.length) selectedIdx = 0;

			const render = () => {
				plansList.replaceChildren(
					...plans.map((plan, i) =>
						renderPlan(plan, i, departure, i === selectedIdx, () => {
							if (i === selectedIdx) return;
							selectedIdx = i;
							render();
							onPlanSelect(plans[i]);
						}),
					),
				);
			};
			render();
			onPlanSelect(plans[selectedIdx]);
		},
		// Where the page puts the saved-trip box (name, save, share), above
		// the plans: on a phone there's no room for it over the map.
		tripSlot: panel.querySelector(".trip-panel-trip"),
		minimize() {
			panel.classList.add("minimized");
		},
		expand() {
			panel.classList.remove("minimized");
		},
	};
}
