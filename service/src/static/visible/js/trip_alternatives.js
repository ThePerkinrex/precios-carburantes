export function createTripAlternativesPanel() {
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

				let stopsHtml = "";
				if (plan.stops.length === 0) {
					stopsHtml = `<li class="trip-stop-item">Sin paradas programadas</li>`;
				} else {
					stopsHtml = plan.stops
						.map((s, i) => {
							const km = (s.station.distance_along_route / 1000).toFixed(1);
							return `
								<li class="trip-stop-item">
									<div class="trip-stop-station">${i + 1}. ${s.station.rotulo} (${s.station.municipio})</div>
									<div class="trip-stop-details">
										km ${km} • Llegada: ${s.arrivalFuel.toFixed(1)} L • Reposta: ${s.litersBought.toFixed(1)} L (${s.pricePerLiter} €/L) = <strong>${s.cost.toFixed(2)} €</strong>
									</div>
								</li>
							`;
						})
						.join("");
				}

				const destPriceInfo = plan.destPricePerLiter != null
					? `Repostar al llegar (${plan.destRefillLiters.toFixed(1)} L a ${plan.destPricePerLiter.toFixed(3)} €/L): ${plan.destRefillCost.toFixed(2)} €`
					: "Sin precio estimado de destino";

				card.innerHTML = `
					<div class="trip-plan-title">Opción ${planIdx + 1} (${plan.totalStops} parada${plan.totalStops !== 1 ? 's' : ''})</div>
					<ul class="trip-plan-stops">${stopsHtml}</ul>
					<div class="trip-plan-summary">
						<div>Coste en ruta: ${onTripCost.toFixed(2)} €</div>
						<div>Destino (${plan.finalArrivalFuel.toFixed(1)} L rest.): ${destPriceInfo}</div>
						<div class="trip-plan-total">Coste total est.: ${plan.totalCost.toFixed(2)} €</div>
					</div>
				`;

				plansList.appendChild(card);
			});
		},
		minimize() {
			panel.classList.add("minimized");
		},
		expand() {
			panel.classList.remove("minimized");
		}
	};
}
