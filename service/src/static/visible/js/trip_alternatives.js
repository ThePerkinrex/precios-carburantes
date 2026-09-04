export function createTripAlternativesPanel(options = {}) {
	// Default handler takes the station object as its single argument
	const onStationClick = options.onStationClick || function (station) {};

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

	return {
		update(plans) {
			plansList.innerHTML = "";

			if (!plans || !plans.length) {
				plansList.innerHTML = `<div class="trip-empty-msg">Sin paradas necesarias o sin plan factible.</div>`;
				return;
			}

			plans.forEach((plan, planIdx) => {
				const onTripCost = plan.totalCost - plan.destRefillCost;
				const card = document.createElement("div");
				card.className = "trip-plan-card";

				const cardTitle = document.createElement("div");
				cardTitle.className = "trip-plan-title";
				cardTitle.textContent = `Opción ${planIdx + 1} (${plan.totalStops} parada${plan.totalStops !== 1 ? "s" : ""})`;
				card.appendChild(cardTitle);

				const stopsUl = document.createElement("ul");
				stopsUl.className = "trip-plan-stops";

				if (plan.stops.length === 0) {
					const emptyLi = document.createElement("li");
					emptyLi.className = "trip-stop-item empty";
					emptyLi.textContent = "Sin paradas programadas";
					stopsUl.appendChild(emptyLi);
				} else {
					plan.stops.forEach((s, i) => {
						const km = (s.station.distance_along_route / 1000).toFixed(1);
						const stopLi = document.createElement("li");
						stopLi.className = "trip-stop-item clickable";
						stopLi.innerHTML = `
							<div class="trip-stop-station">${i + 1}. ${s.station.rotulo} (${s.station.municipio})</div>
							<div class="trip-stop-details">
								km ${km} • Llegada: ${s.arrivalFuel.toFixed(1)} L • Reposta: ${s.litersBought.toFixed(1)} L (${s.pricePerLiter} €/L) = <strong>${s.cost.toFixed(2)} €</strong>
							</div>
						`;

						// Click handler passing the station data object
						stopLi.addEventListener("click", (e) => {
							e.stopPropagation();
							onStationClick(s.station);
						});

						stopsUl.appendChild(stopLi);
					});
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

				plansList.appendChild(card);
			});
		},
		minimize() {
			panel.classList.add("minimized");
		},
		expand() {
			panel.classList.remove("minimized");
		},
	};
}
