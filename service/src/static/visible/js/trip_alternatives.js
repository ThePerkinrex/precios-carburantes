// Bottom panel listing the fuel-stop plans from fuel_planner.js. One plan is
// selected at a time (the first by default); the page highlights its stops.

const STATUS_FLAGS = {
	closesSoon: { text: "cierra pronto", className: "warn" },
	unknown: { text: "horario desconocido", className: "warn" },
};

function formatKm(km) {
	return km.toFixed(km < 10 ? 1 : 0);
}

function formatTime(date, departure) {
	const time = date.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", hour12: false });
	const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	const days = Math.round((startOfDay(date) - startOfDay(departure)) / 86400000);
	return days > 0 ? `${time} (+${days}d)` : time;
}

// Why there's no plan, in words, with what the user can change about it.
function diagnosisMessage(diagnosis) {
	switch (diagnosis?.reason) {
		case "loading":
			return ["Cargando gasolineras…"];
		case "error":
			return ["No se pudieron cargar las gasolineras de la ruta. Recarga la página para intentarlo de nuevo."];
		case "no_car":
			return ["Configura el consumo y el depósito de tu coche (⛽) para calcular las paradas."];
		case "bad_range":
			return ["El rango de repostaje no es válido: el mínimo tiene que ser menor que el máximo y que el depósito (⛽)."];
		case "low_start":
			return ["Sales con menos combustible que el mínimo de repostaje. Revisa el combustible actual (⛽)."];
		case "gap": {
			const lines = [
				`No hay ninguna gasolinera válida entre el km ${formatKm(diagnosis.fromKm)} y el km ${formatKm(diagnosis.toKm)}, que es donde tocaría repostar.`,
				"Prueba a ampliar la distancia a la ruta o el rango de repostaje (⛽), a mostrar más marcas, o a quitar alguna gasolinera de la lista negra.",
			];
			if (diagnosis.closedCount) {
				lines.push(
					`${diagnosis.closedCount} gasolinera${diagnosis.closedCount === 1 ? "" : "s"} descartada${diagnosis.closedCount === 1 ? "" : "s"} por estar cerrada${diagnosis.closedCount === 1 ? "" : "s"} a tu hora de llegada.`,
				);
			}
			return lines;
		}
		default:
			return ["No se ha encontrado ningún plan."];
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

	const panel = document.createElement("div");
	panel.className = "trip-alternatives-panel";
	panel.innerHTML = `
		<div class="trip-panel-header" title="Alternar panel">
			<span>Alternativas de viaje</span>
			<button class="trip-panel-toggle" aria-label="Minimizar panel">&#9650;</button>
		</div>
		<div class="trip-plans-list"></div>
	`;

	document.body.appendChild(panel);

	const header = panel.querySelector(".trip-panel-header");

	header.addEventListener("click", () => {
		panel.classList.toggle("minimized");
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
		const detour = s.detourM >= 100 ? ` • ~${(s.detourM / 1000).toFixed(1)} km desvío` : "";
		const details = document.createElement("div");
		details.className = "trip-stop-details";
		details.innerHTML = `
			km ${km} • ${formatTime(s.eta, departure)}${detour}<br>
			Llegada: ${s.arrivalFuel.toFixed(1)} L • Reposta: ${s.litersBought.toFixed(1)} L (${s.pricePerLiter.toFixed(3)} €/L) = <strong>${s.cost.toFixed(2)} €</strong>
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
				? `Opción ${planIdx + 1} (sin paradas)`
				: `Opción ${planIdx + 1} (${plan.totalStops} parada${plan.totalStops !== 1 ? "s" : ""})`;
		card.appendChild(cardTitle);

		const stopsUl = document.createElement("ul");
		stopsUl.className = "trip-plan-stops";

		if (plan.stops.length === 0) {
			const emptyLi = document.createElement("li");
			emptyLi.className = "trip-stop-item empty";
			emptyLi.textContent = "Llegas sin repostar por el camino";
			stopsUl.appendChild(emptyLi);
		} else {
			plan.stops.forEach((s, i) => stopsUl.appendChild(renderStop(s, i, departure)));
		}
		card.appendChild(stopsUl);

		const destPriceInfo =
			plan.destPricePerLiter != null
				? `Repostar al llegar (${plan.destRefillLiters.toFixed(1)} L a ${plan.destPricePerLiter.toFixed(3)} €/L): ${plan.destRefillCost.toFixed(2)} €`
				: "Sin precio estimado de destino";

		const summaryDiv = document.createElement("div");
		summaryDiv.className = "trip-plan-summary";
		summaryDiv.innerHTML = `
			<div>Coste en ruta: ${onTripCost.toFixed(2)} €</div>
			<div>Destino (${plan.finalArrivalFuel.toFixed(1)} L rest.): ${destPriceInfo}</div>
			<div class="trip-plan-total">Coste total est.: ${plan.totalCost.toFixed(2)} €</div>
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
		minimize() {
			panel.classList.add("minimized");
		},
		expand() {
			panel.classList.remove("minimized");
		},
	};
}
