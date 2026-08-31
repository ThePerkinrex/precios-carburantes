import { getStatus, formatOpenCloseDate } from "./schedules.js";
import { updateFilter } from "./api.js";

// Prices always show 3 decimal places (e.g. 1.5 -> "1.500").
function formatPrice(price) {
	return price.toFixed(3);
}

// ---------------------------------------------------------------------------
// Popup content
// ---------------------------------------------------------------------------

/**
 * Default popup body for a gas station marker. Exported so callers can
 * reuse/wrap it (e.g. call this and append extra sections) instead of
 * rewriting everything from scratch.
 *
 * @param {object} eess station record, same shape as returned by /api/prices
 * @returns {string} HTML for the popup contents
 */
export function buildDefaultPopupContent(eess) {
	let gasolina_long =
		eess.gasolina_95 != null
			? `<div class="gasolina">Gasolina 95: <b>${formatPrice(eess.gasolina_95)}€</b></div>`
			: "";
	let gasoleo_long =
		eess.gasoleo_a != null
			? `<div class="gasoleo">Gasoleo A: <b>${formatPrice(eess.gasoleo_a)}€</b></div>`
			: "";

	let status = getStatus(eess.horario, new Date());
	let pill = "";
	if (status.status == "open") {
		pill = `<div class="pill open">Abierto; Cierre ${formatOpenCloseDate(status.nextClose)}</div>`;
	} else if (status.status == "opensSoon") {
		pill = `<div class="pill open soon">Abre pronto; Apertura ${formatOpenCloseDate(status.nextOpen)}</div>`;
	} else if (status.status == "close") {
		pill = `<div class="pill close">Cerrado; Apertura ${formatOpenCloseDate(status.nextOpen)}</div>`;
	} else if (status.status == "closesSoon") {
		pill = `<div class="pill close soon">Cierra pronto; Cierre ${formatOpenCloseDate(status.nextClose)}</div>`;
	}

	// https://www.google.com/maps/search/?api=1&query=47.5951518%2C-122.3316393
	const google_maps_url = `https://www.google.com/maps/search/?${new URLSearchParams({
		api: "1",
		query: `${eess.latitud},${eess.longitud}`,
	})}`;
	// https://waze.com/ul?ll=<lat>,<lng>
	const waze_url = `https://waze.com/ul?${new URLSearchParams({
		ll: `${eess.latitud},${eess.longitud}`,
	})}`;
	// https://maps.apple.com/?daddr=<lat>,<lng>
	const apple_maps_url = `https://maps.apple.com/?${new URLSearchParams({
		daddr: `${eess.latitud},${eess.longitud}`,
	})}`;

	let location_pills = `
	<a href="${google_maps_url}" target="_blank" rel="noopener noreferrer"><div class="google-maps map-link pill"><img src="/files/images/google_maps.svg" class="map-logo"><span class="map-text">Google Maps</span></div></a>
	<a href="${waze_url}" target="_blank" rel="noopener noreferrer"><div class="waze map-link pill"><img src="/files/images/waze.svg" class="map-logo"><span class="map-text">Waze</span></div></a>
	<a href="${apple_maps_url}" target="_blank" rel="noopener noreferrer"><div class="apple-maps map-link pill"><img src="/files/images/apple_maps.png" class="map-logo"><span class="map-text">Apple Maps</span></div></a>
	`;

	return `
	<div class="gasolinera" id="gasolinera-${eess.id}">
		<div class="rotulo"><b>${eess.rotulo}</b></div>
		<div class="direccion">
			${eess.direccion}, margen ${eess.margen}<br>
			${eess.localidad}, ${eess.municipio} ${eess.cp}<br>
			<i>${eess.provincia}</i><br>
			Horario: ${eess.horario}<br>
			${pill}<br>
			${location_pills}
		</div>

		<div class="price-label">
			${gasoleo_long}
			${gasolina_long}
		</div>
		<canvas class="chart"></canvas>
	</div>`;
}

/**
 * Draws the 7-day price history chart into a popup built with
 * buildDefaultPopupContent. No-ops if the popup doesn't contain the
 * expected #gasolinera-<id> / .chart elements, so custom popup builders
 * are free to drop the chart entirely.
 */
async function drawHistoryChart(eess) {
	const popup = document.getElementById(`gasolinera-${eess.id}`);
	const chart = popup?.getElementsByClassName("chart")[0];
	if (!chart) return;

	const from = new Date(new Date().setDate(new Date().getDate() - 7));
	const history = await fetch(
		`/api/${eess.id}/history?` +
			new URLSearchParams({ from: from.toISOString() }).toString(),
	).then((x) => x.json());

	new Chart(chart, {
		type: "line",
		data: {
			labels: history.map((x) => x.fecha),
			datasets: [
				{
					label: "Gasolina 95",
					data: history.map((x) => x.gasolina_95),
					fill: false,
					borderColor: "green",
					tension: 0.1,
				},
				{
					label: "Gasoleo A",
					data: history.map((x) => x.gasoleo_a),
					fill: false,
					borderColor: "black",
					tension: 0.1,
				},
			],
		},
	});
}

// ---------------------------------------------------------------------------
// Marker icon (the little price-tag icon shown on the map, not the popup)
// ---------------------------------------------------------------------------

function buildMarkerIcon(eess, logos, logos_sorted) {
	let logo = `<div class="logo"><b>${eess.rotulo}</b></div>`;
	let logoKey = "other";
	const lower_eess = eess.rotulo.toLowerCase();
	for (let name of logos_sorted) {
		if (
			lower_eess.includes(name) ||
			("alternatives" in logos[name] &&
				logos[name].alternatives.some((x) => lower_eess.includes(x)))
		) {
			logo = `<img class="logo" src="${logos[name].image}"/>`;
			logoKey = name;
			break;
		}
	}

	let gasolina_short =
		eess.gasolina_95 != null
			? `<div class="gasolina">${formatPrice(eess.gasolina_95)}€</div>`
			: "";
	let gasoleo_short =
		eess.gasoleo_a != null
			? `<div class="gasoleo">${formatPrice(eess.gasoleo_a)}€</div>`
			: "";

	const icon = L.divIcon({
		className: "custom-div-icon",
		html: `	<div class="price-label icon">
					${logo}
					${gasoleo_short}
					${gasolina_short}
				</div>`,
	});

	return { icon, logoKey };
}

// ---------------------------------------------------------------------------
// Layer control ("Otras", brand overlays) + the All/None buttons above it
// ---------------------------------------------------------------------------

function addSelectAllButtons(layerControl, overlays, map) {
	const container = layerControl.getContainer();
	const form = container.querySelector("section.leaflet-control-layers-list");

	const buttonWrapper = document.createElement("div");
	buttonWrapper.className = "layer-select-buttons";
	buttonWrapper.innerHTML = `
        <button class="selectAll">All</button>
        <button class="unselectAll">None</button>
    `;

	L.DomEvent.disableClickPropagation(buttonWrapper);
	form.prepend(buttonWrapper);

	// --- GHOST CLICK PREVENTION ---
	let ignoreClicks = false;
	container.addEventListener(
		"touchstart",
		() => {
			if (!container.classList.contains("leaflet-control-layers-expanded")) {
				ignoreClicks = true;
				setTimeout(() => {
					ignoreClicks = false;
				}, 400);
			}
		},
		{ passive: true },
	);
	// ------------------------------

	const selectAllBtn = buttonWrapper.querySelector(".selectAll");
	L.DomEvent.on(selectAllBtn, "click", (ev) => {
		L.DomEvent.stop(ev);
		if (ignoreClicks) return;
		for (let overlay of overlays) map.addLayer(overlay);
	});

	const unselectAllBtn = buttonWrapper.querySelector(".unselectAll");
	L.DomEvent.on(unselectAllBtn, "click", (ev) => {
		L.DomEvent.stop(ev);
		if (ignoreClicks) return;
		for (let overlay of overlays) {
			if (map.hasLayer(overlay)) map.removeLayer(overlay);
		}
	});
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Builds the gas-station markers (clustered, grouped by brand) and the
 * associated Leaflet layer control, and attaches everything to `map`.
 *
 * @param {L.Map} map                 an already-created Leaflet map
 * @param {object[]} stations         the station records to render (caller decides which ones)
 * @param {object} logos              logo/brand metadata, as returned by getLogos()
 * @param {object} [options]
 * @param {Set<string>} [options.filter]           brand keys that should start visible (default: all)
 * @param {(eess: object) => string} [options.buildPopupContent]
 *        builds the popup HTML for a station. Defaults to buildDefaultPopupContent.
 *        Use this to show different/extra info per station without touching the
 *        clustering/layer-control logic.
 * @param {(filter: Set<string>) => any} [options.onFilterChange]
 *        called with the updated brand-filter Set whenever the user toggles an
 *        overlay on/off. Defaults to persisting it via api.js's updateFilter.
 *
 * @returns {{markers: L.MarkerClusterGroup, control: L.Control.Layers, subgroups: Array, allMarkers: L.Marker[]}}
 */
export function createStationsLayer(
	map,
	stations,
	logos,
	{
		filter = new Set([...Object.keys(logos), "other"]),
		buildPopupContent = buildDefaultPopupContent,
		onFilterChange = updateFilter,
	} = {},
) {
	const markers = L.markerClusterGroup();
	const control = L.control.layers(null, null, { collapsed: true });
	map.addLayer(markers);

	let subgroupLayers = Object.fromEntries(Object.keys(logos).map((k) => [k, []]));
	subgroupLayers["other"] = [];

	const logos_sorted = Object.keys(logos).sort((a, b) => b.length - a.length);
	const allMarkers = [];

	for (let eess of stations) {
		const { icon, logoKey } = buildMarkerIcon(eess, logos, logos_sorted);

		const marker = L.marker([eess.latitud, eess.longitud], { icon }).bindPopup(
			() => buildPopupContent(eess),
		);
		marker.on("popupopen", () => drawHistoryChart(eess));

		marker.eess = eess; // keep raw data around for sorting/displaying elsewhere
		allMarkers.push(marker);
		subgroupLayers[logoKey].push(marker);
	}

	const subgroups = Object.entries(subgroupLayers)
		.map(([name, layers]) => [
			name,
			L.featureGroup.subGroup(markers, layers),
			layers.length,
		])
		.toSorted(([name1, , len1], [name2, , len2]) =>
			name1 == "other" ? 1 : name2 == "other" ? -1 : len2 - len1,
		);

	for (let [name, subgroup] of subgroups) {
		control.addOverlay(subgroup, name == "other" ? "Otras" : logos[name].text);
		if (filter.has(name)) subgroup.addTo(map);
		subgroup.on("add", () => {
			filter.add(name);
			onFilterChange(filter);
		});
		subgroup.on("remove", () => {
			filter.delete(name);
			onFilterChange(filter);
		});
	}
	control.addTo(map);
	addSelectAllButtons(control, subgroups.map((x) => x[1]), map);

	return { markers, control, subgroups, allMarkers };
}

