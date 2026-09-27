// A Leaflet control with three things in it:
//   1. how far from the route to look for stations (triggers an API refetch)
//   2. when the trip starts (to know which stations are open on arrival)
//   3. the user's car profile (consumption, tank size, current fuel, the
//      fill-level range within which a stop should be suggested)
//
// The car profile is saved on the server by the caller (onCarChange); only
// the current fuel, which changes every drive, is kept in this browser.

const STORAGE_DISTANCE_KEY = "routeOptions:distance";
const STORAGE_INITIAL_FUEL_KEY = "routeOptions:initialFuel";
// Where the whole car profile was kept before it moved to the server; read
// once so nobody has to type theirs in again.
const LEGACY_STORAGE_CAR_KEY = "routeOptions:car";

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

function saveJson(key, value) {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Private mode, storage full...: it just won't be remembered.
	}
}

// "YYYY-MM-DDTHH:MM" in local time, the format of <input type="datetime-local">.
function toLocalInputValue(date) {
	const pad = (n) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
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

/**
 * @param {object} [options]
 * @param {object} [options.initialCar]  the saved car profile; missing fields
 *        fall back to the legacy local copy, then to DEFAULT_CAR
 * @param {(car: object) => any} [options.onCarChange]  called with the whole
 *        car (including initialFuel) whenever a field changes
 * @param {(departure: Date) => any} [options.onDepartureChange]
 * @param {(open: boolean) => any} [options.onPanelToggle]  the panel was opened/closed
 */
export function addRouteOptionsControl(
	map,
	{
		position = "topleft",
		initialDistance,
		distanceMin = 200,
		distanceMax = 10000,
		distanceStep = 100,
		initialCar = {},
		persist = true,
		onDistanceChange,
		onCarChange,
		onDepartureChange,
		onPanelToggle,
	} = {},
) {
	let distance =
		initialDistance ??
		(persist ? loadJson(STORAGE_DISTANCE_KEY, 2000) : 2000);
	const legacyCar = persist ? loadJson(LEGACY_STORAGE_CAR_KEY, {}) : {};
	const savedCar = Object.fromEntries(
		Object.entries(initialCar).filter(([, v]) => v != null),
	);
	let car = {
		...DEFAULT_CAR,
		...legacyCar,
		...savedCar,
	};
	if (persist) car.initialFuel = loadJson(STORAGE_INITIAL_FUEL_KEY, car.initialFuel);
	let departure = new Date();

	function saveDistance() {
		if (persist) saveJson(STORAGE_DISTANCE_KEY, distance);
	}
	function saveInitialFuel() {
		if (persist) saveJson(STORAGE_INITIAL_FUEL_KEY, car.initialFuel);
	}

	const control = L.control({ position });

	control.onAdd = function () {
		const container = L.DomUtil.create("div", "route-options");

		const toggle = L.DomUtil.create("button", "route-options-fab", container);
		toggle.type = "button";
		toggle.title = "Distancia, salida y coche";
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

				<div class="route-options-section-title route-options-departure-title">
					Salida
					<button type="button" class="route-options-now-btn">Ahora</button>
				</div>
				<input type="datetime-local" class="route-options-departure-input" value="${toLocalInputValue(departure)}">

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
				<div class="route-options-hint">Nunca se baja del mínimo, tampoco al llegar al destino.</div>
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
					<button type="button" class="route-options-save-btn">Listo</button>
				</div>
			</div>
		`;

		L.DomEvent.disableClickPropagation(container);
		L.DomEvent.disableScrollPropagation(container);

		L.DomEvent.on(toggle, "click", () => {
			const open = panel.style.display === "none";
			panel.style.display = open ? "block" : "none";
			onPanelToggle?.(open);
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

		// Every change already applies (and saves) as it's made; this just
		// gets the panel out of the way.
		L.DomEvent.on(panel.querySelector(".route-options-save-btn"), "click", () => {
			panel.style.display = "none";
			onPanelToggle?.(false);
		});

		// --- departure ---
		const departureInput = panel.querySelector(".route-options-departure-input");
		function setDeparture(date) {
			departure = date;
			departureInput.value = toLocalInputValue(date);
			onDepartureChange?.(departure);
		}
		L.DomEvent.on(departureInput, "change", () => {
			const date = new Date(departureInput.value);
			if (!Number.isNaN(date.getTime())) setDeparture(date);
		});
		L.DomEvent.on(panel.querySelector(".route-options-now-btn"), "click", () => {
			setDeparture(new Date());
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
				saveInitialFuel();
				onCarChange?.(car);
			});
		});

		// Initialize range display values right away
		updateKmCalculations();

		return container;
	};

	control.addTo(map);

	onDepartureChange?.(departure);
	onCarChange?.(car);
	onDistanceChange?.(distance);

	return control;
}

