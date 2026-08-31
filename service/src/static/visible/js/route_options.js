// A Leaflet control with two things in it:
//   1. how far from the route to look for stations (triggers an API refetch)
//   2. the user's car profile (consumption, tank size, current fuel, the
//      fill-level range within which a stop should be suggested)

const STORAGE_DISTANCE_KEY = "routeOptions:distance";
const STORAGE_CAR_KEY = "routeOptions:car";

const DEFAULT_CAR = {
	fuel: "diesel", // "diesel" | "gasolina"
	consumption: 6, // L/100km
	tankSize: 50, // L
	initialFuel: 40, // L currently in the tank
	stopMin: 5, // L — don't let the tank drop below this without a stop
	stopMax: 20, // L — happy to stop early if it's convenient and we're under this
};

function formatDistanceLabel(meters) {
	if (meters >= 1000) {
		const km = meters / 1000;
		return `${km % 1 === 0 ? km.toFixed(0) : km.toFixed(1)} km`;
	}
	return `${meters} m`;
}

function loadJson(key, fallback) {
	try {
		const raw = localStorage.getItem(key);
		return raw != null ? JSON.parse(raw) : fallback;
	} catch {
		return fallback;
	}
}

/**
 * Calculates remaining range in kilometers from liters and consumption rate.
 */
function fuelToKm(liters, consumption) {
	if (!consumption || consumption <= 0 || !liters || liters < 0) {
		return 0;
	}
	return Math.round((liters / consumption) * 100);
}

export function addRouteOptionsControl(
	map,
	{
		position = "topleft",
		initialDistance,
		distanceMin = 200,
		distanceMax = 10000,
		distanceStep = 100,
		initialCar,
		persist = true,
		onDistanceChange,
		onCarChange,
	} = {},
) {
	let distance =
		initialDistance ??
		(persist ? loadJson(STORAGE_DISTANCE_KEY, 2000) : 2000);
	let car = {
		...DEFAULT_CAR,
		...(persist ? loadJson(STORAGE_CAR_KEY, {}) : {}),
		...initialCar,
	};

	function saveDistance() {
		if (persist) localStorage.setItem(STORAGE_DISTANCE_KEY, JSON.stringify(distance));
	}
	function saveCar() {
		if (persist) localStorage.setItem(STORAGE_CAR_KEY, JSON.stringify(car));
	}

	const control = L.control({ position });

	control.onAdd = function () {
		const container = L.DomUtil.create("div", "route-options");

		const toggle = L.DomUtil.create("button", "route-options-fab", container);
		toggle.type = "button";
		toggle.title = "Distancia y coche";
		toggle.innerHTML = "⛽";

		const panel = L.DomUtil.create("div", "route-options-panel", container);
		panel.style.display = "none";
		panel.innerHTML = `
			<div class="route-options-content">
				<div class="route-options-section-title">Distancia a la ruta</div>
				<div class="route-options-distance">
					<input
						type="range"
						class="route-options-distance-slider"
						min="${distanceMin}"
						max="${distanceMax}"
						step="${distanceStep}"
						value="${distance}"
					>
					<span class="route-options-distance-value">${formatDistanceLabel(distance)}</span>
				</div>

				<div class="route-options-section-title">Mi coche</div>
				<div class="route-options-fuel">
					<label>
						<input type="radio" name="route-options-fuel" value="diesel" ${car.fuel === "diesel" ? "checked" : ""}>
						Diésel
					</label>
					<label>
						<input type="radio" name="route-options-fuel" value="gasolina" ${car.fuel === "gasolina" ? "checked" : ""}>
						Gasolina
					</label>
				</div>

				<label class="route-options-field">
					<span>Consumo (L/100km)</span>
					<input type="number" class="route-options-consumption" min="0" step="0.1" value="${car.consumption}">
				</label>
				<label class="route-options-field">
					<span>Depósito (L)</span>
					<input type="number" class="route-options-tank-size" min="0" step="1" value="${car.tankSize}">
				</label>
				<label class="route-options-field">
					<span>Combustible actual (L)</span>
					<input type="number" class="route-options-initial-fuel" min="0" step="1" value="${car.initialFuel}">
					<span class="route-options-range-info route-options-initial-km"></span>
				</label>

				<div class="route-options-section-title">Repostar cuando quede entre</div>
				<div class="route-options-stop-range">
					<label class="route-options-field">
						<span>Mínimo (L)</span>
						<input type="number" class="route-options-stop-min" min="0" step="1" value="${car.stopMin}">
						<span class="route-options-range-info route-options-min-km"></span>
					</label>
					<label class="route-options-field">
						<span>Máximo (L)</span>
						<input type="number" class="route-options-stop-max" min="0" step="1" value="${car.stopMax}">
						<span class="route-options-range-info route-options-max-km"></span>
					</label>
				</div>

				<div class="route-options-actions">
					<button type="button" class="route-options-save-btn">Guardar</button>
				</div>
			</div>
		`;

		L.DomEvent.disableClickPropagation(container);
		L.DomEvent.disableScrollPropagation(container);

		L.DomEvent.on(toggle, "click", () => {
			panel.style.display = panel.style.display === "none" ? "block" : "none";
		});

		// --- distance slider ---
		const slider = panel.querySelector(".route-options-distance-slider");
		const valueLabel = panel.querySelector(".route-options-distance-value");

		L.DomEvent.on(slider, "input", () => {
			valueLabel.textContent = formatDistanceLabel(Number(slider.value));
		});
		L.DomEvent.on(slider, "change", () => {
			distance = Number(slider.value);
			saveDistance();
			onDistanceChange?.(distance);
		});

		// --- car profile & dynamic km ranges ---
		const initialKmSpan = panel.querySelector(".route-options-initial-km");
		const minKmSpan = panel.querySelector(".route-options-min-km");
		const maxKmSpan = panel.querySelector(".route-options-max-km");

		function updateKmCalculations() {
			const currentCar = readCarFromForm();
			
			const initialKm = fuelToKm(currentCar.initialFuel, currentCar.consumption);
			const minKm = fuelToKm(currentCar.stopMin, currentCar.consumption);
			const maxKm = fuelToKm(currentCar.stopMax, currentCar.consumption);

			initialKmSpan.textContent = `~${initialKm} km restantes`;
			minKmSpan.textContent = `~${minKm} km`;
			maxKmSpan.textContent = `~${maxKm} km`;
		}

		function readCarFromForm() {
			const fuel =
				panel.querySelector('input[name="route-options-fuel"]:checked')
					?.value ?? car.fuel;
			car = {
				fuel,
				consumption: Number(panel.querySelector(".route-options-consumption").value),
				tankSize: Number(panel.querySelector(".route-options-tank-size").value),
				initialFuel: Number(panel.querySelector(".route-options-initial-fuel").value),
				stopMin: Number(panel.querySelector(".route-options-stop-min").value),
				stopMax: Number(panel.querySelector(".route-options-stop-max").value),
			};
			return car;
		}

		const carInputs = panel.querySelectorAll(
			'input[name="route-options-fuel"], .route-options-consumption, .route-options-tank-size, .route-options-initial-fuel, .route-options-stop-min, .route-options-stop-max',
		);
		carInputs.forEach((input) => {
			// Update on 'input' for live response while typing, and 'change' to persist/notify
			L.DomEvent.on(input, "input", () => {
				updateKmCalculations();
			});
			L.DomEvent.on(input, "change", () => {
				readCarFromForm();
				saveCar();
				onCarChange?.(car);
			});
		});

		// Initialize range display values right away
		updateKmCalculations();

		return container;
	};

	control.addTo(map);

	onDistanceChange?.(distance);
	onCarChange?.(car);

	return control;
}

