import {
	addTripBlacklist,
	createTrip,
	createTripShare,
	getPricesOnRoute,
	getRoute,
	getTrip,
	getTrips,
	getUserState,
	removeTripBlacklist,
	routePageUrl,
	updateCar,
	updateFilter,
	updateTrip,
} from "./api.js";
import {
	ROUTE_COLORS,
	formatDistance,
	formatDuration,
	coordToLatLng,
	waypointDivIcon,
} from "./route.js";
import {
	buildDefaultPopupContent,
	createStationsLayer,
	getLogoKey,
	sortLogos,
	StationBlacklist,
} from "./stations.js";
import { addRouteOptionsControl } from "./route_options.js";
import { addMenuControl } from "./map_menu.js";
import { getLogos } from "./logos.js";
import { createTripAlternativesPanel } from "./trip_alternatives.js";
import { arrivalTime, planStops, statusAt } from "./fuel_planner.js";

const STATUS_TEXT = {
	open: "abierta",
	closesSoon: "cierra pronto",
	closed: "cerrada",
	unknown: "horario desconocido",
};

// The saved trip for this route, if any: the one in ?trip=, or else the
// user's most recently used trip on this same route.
async function findTrip(hash, routeIdx, tripId) {
	if (tripId) {
		try {
			return { trip: await getTrip(tripId) };
		} catch {
			return { trip: null, error: "Este viaje no existe o no tienes acceso a él." };
		}
	}
	try {
		const { saved } = await getTrips();
		const mine = saved.find((t) => t.hash === hash && t.route_idx === routeIdx);
		return { trip: mine ? await getTrip(mine.id) : null };
	} catch {
		return { trip: null };
	}
}

function setTripInUrl(hash, routeIdx, tripId) {
	history.replaceState(null, "", routePageUrl(hash, routeIdx, tripId));
}

async function load() {
	const url = new URL(location.href);
	const path = url.pathname.split("/");
	// /route/hash/id
	const hash = path[2];
	const route_idx = parseInt(path[3]);

	if (!hash || Number.isNaN(route_idx)) {
		location.assign("/files/map");
		return;
	}

	let route_data = getRoute(hash, route_idx);
	let logos = getLogos();
	let state = getUserState();
	let tripResult = findTrip(hash, route_idx, url.searchParams.get("trip"));

	// Zoom is added after the menu so the menu sits at the very top, as on the map.
	const map = L.map("map", { zoomControl: false }).setView([40.4165, -3.70256], 11);
	addMenuControl(map, state, null);
	L.control.zoom().addTo(map);

	L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
		maxZoom: 19,
		attribution:
			'&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>',
	}).addTo(map);

	route_data = await route_data;

	const { waypoints, route } = route_data;

	// Route line, colored the same way route.js colors its alternatives
	// (keyed off this route's index so it's consistent across views).
	const color = ROUTE_COLORS[route_idx % ROUTE_COLORS.length];
	const latlngs = route.geometry.map(coordToLatLng);
	const routeLine = L.polyline(latlngs, {
		color,
		weight: 6,
		opacity: 0.95,
	}).addTo(map);

	// Waypoint markers, using the same route-waypoint-icon/marker classes
	// (and start/end modifiers) as the interactive route control.
	const last = waypoints.length - 1;
	waypoints.forEach((wp, i) => {
		const [lon, lat] = wp.location;
		L.marker([lat, lon], {
			icon: waypointDivIcon(i, i === 0, i === last && last > 0),
		})
			.addTo(map)
			.bindPopup(wp.name || `Punto ${i + 1}`);
	});

	map.fitBounds(routeLine.getBounds(), { padding: [40, 40] });

	// Summary control, styled with the same route-summary/route-info
	// classes route.js uses for its panel summary.
	const info = L.control({ position: "topright" });
	info.onAdd = function () {
		const div = L.DomUtil.create("div", "route-summary");
		div.innerHTML = `
			<div class="route-info">
				<span class="route-distance">${formatDistance(route.distance)}</span>
				<span class="route-duration">${formatDuration(route.duration)}</span>
			</div>
		`;
		return div;
	};
	info.addTo(map);

	logos = await logos;
	const logos_sorted = sortLogos(logos);
	state = await state;
	const { trip: loadedTrip, error: tripError } = await tripResult;
	if (tripError) setTripInUrl(hash, route_idx, null);
	else if (loadedTrip) setTripInUrl(hash, route_idx, loadedTrip.id);

	// { id, name, owned, owner } of the saved trip shown, or null. The
	// blacklist is saved with it only when it's the user's own.
	let trip = loadedTrip;

	// Currently-rendered station layer, so we can tear it down and rebuild
	// it whenever the "distance from route" setting changes.
	let stationsLayer = null;
	// Bumped on every reload so a slow, superseded fetch can't clobber a
	// newer one (e.g. if the user drags the distance slider twice quickly).
	let requestToken = 0;

	let carSettings = null;
	let departure = new Date();
	let distance = null;
	let routeOptions = null;
	let price_data = null; // null until the first fetch lands

	let station_filter = state.filter;
	const blacklist = new StationBlacklist(loadedTrip?.blacklist ?? []);

	const alternativesPanel = createTripAlternativesPanel({
		onStationClick: focusStation,
		onPlanSelect: showPlan,
		// Phones: the open sheet would cover the car panel.
		onExpand: () => {
			if (isPhone()) routeOptions?.close();
		},
	});
	const tripControl = addTripControl();

	// Phones: the bottom sheet covers half the map, so it gets out of the way
	// when something on the map (a station popup, the car panel) needs room.
	const isPhone = () => matchMedia("(max-width: 639px)").matches;

	// Phones: a station's popup needs the room the open sheet takes. The map
	// fires this before the popup pans into view (stations.js).
	map.on("popupopen", () => {
		if (isPhone()) alternativesPanel.minimize();
	});

	blacklist.on("add", (stationId) => {
		if (trip?.owned) addTripBlacklist(trip.id, stationId).catch(tripControl.showError);
	});
	blacklist.on("delete", (stationId) => {
		if (trip?.owned) removeTripBlacklist(trip.id, stationId).catch(tripControl.showError);
	});
	blacklist.on("change", () => reloadStops());

	function focusStation(station) {
		const marker = stationsLayer?.markersById?.get(station.id);
		if (!marker) return;
		if (isPhone()) alternativesPanel.minimize();

		map.setView([station.latitud, station.longitud], 15);
		// Uncluster the marker before opening its popup.
		if (typeof stationsLayer.markers?.zoomToShowLayer === "function") {
			stationsLayer.markers.zoomToShowLayer(marker, () => marker.openPopup());
		} else {
			marker.openPopup();
		}
	}

	// Numbered rings over the selected plan's stops, above the clusters, on
	// the top-right corner of the station's price sign (stations.js: 32px
	// plus 16px per price row tall, 60px wide) so they don't hide its prices.
	// A stop gathered into a cluster gets its ring on the cluster's bubble
	// instead, with the numbers of all the stops inside it.
	const planLayer = L.layerGroup().addTo(map);
	let shownStops = [];
	function showPlan(plan) {
		shownStops = plan?.stops ?? [];
		placeStopBadges();
	}

	function placeStopBadges() {
		planLayer.clearLayers();
		const badges = new Map();
		shownStops.forEach((s, i) => {
			const marker = stationsLayer?.markersById?.get(s.station.id);
			// null when off screen: then it goes by the sign, as if unclustered.
			const shown = marker && stationsLayer.markers.getVisibleParent?.(marker);
			if (shown && shown !== marker) {
				const badge = badges.get(shown) ?? { latlng: shown.getLatLng(), stops: [], cluster: shown };
				badge.stops.push({ s, n: i + 1 });
				badges.set(shown, badge);
			} else {
				badges.set(s.station.id, { latlng: [s.station.latitud, s.station.longitud], stops: [{ s, n: i + 1 }] });
			}
		});

		for (const { latlng, stops, cluster } of badges.values()) {
			let dx, dy;
			if (cluster) {
				// On the bubble's top-right edge (it's centred on the point).
				const r = (cluster._icon?.offsetWidth || 40) / 2;
				dx = r - 2;
				dy = -(r - 2);
			} else {
				const st = stops[0].s.station;
				const rows = Math.max(1, (st.gasolina_95 != null) + (st.gasoleo_a != null));
				dx = 28;
				dy = -(32 + 16 * rows - 4);
			}
			const width = 44 + 14 * (stops.length - 1);
			L.marker(latlng, {
				icon: L.divIcon({
					className: "",
					html: `<div class="trip-stop-marker"><span>${stops.map((x) => x.n).join("·")}</span></div>`,
					iconSize: [width, 44],
					iconAnchor: [width / 2 - dx, 22 - dy],
				}),
				zIndexOffset: 1000,
				title: stops.map((x) => x.s.station.rotulo).join(", "),
			})
				.on("click", () => focusStation(stops[0].s.station))
				.addTo(planLayer);
		}
	}
	// Clusters split and merge as the map zooms, and appear as it pans.
	map.on("moveend", placeStopBadges);

	// The default popup, plus when we'd get there and whether it's open then.
	function buildPopupContent(eess, blacklist) {
		const eta = arrivalTime(eess, departure);
		const time = eta.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", hour12: false });
		const status = statusAt(eess, eta);
		const detourKm = (2 * (eess.distance_from_route ?? 0)) / 1000;
		return `
			<div class="route-eta ${status}">
				Llegada ~${time}: <b>${STATUS_TEXT[status]}</b>
				• km ${(eess.distance_along_route / 1000).toFixed(1)}
				${detourKm >= 0.1 ? `• ~${detourKm.toFixed(1)} km desvío` : ""}
			</div>
			${buildDefaultPopupContent(eess, blacklist)}`;
	}

	async function reloadStations(maxDistance) {
		const token = ++requestToken;
		const data = await getPricesOnRoute(hash, route_idx, {
			max_distance: maxDistance,
			order_by: "DistanceAlongRoute",
		});
		if (token !== requestToken) return; // a newer request already landed
		price_data = data;

		if (stationsLayer) {
			map.removeLayer(stationsLayer.markers);
			map.removeControl(stationsLayer.control);
		}

		// Everything about rendering the stations themselves (markers, popups,
		// clustering, and the brand layer control) lives in stations.js.
		stationsLayer = createStationsLayer(map, price_data, logos, {
			filter: state.filter,
			onFilterChange: (filter) => {
				station_filter = filter;
				updateFilter(filter);
				reloadStops();
			},
			blacklist,
			buildPopupContent,
		});
		stationsLayer.markers.on("animationend", placeStopBadges);
	}

	function reloadStops() {
		if (!carSettings) return;
		if (!price_data) {
			alternativesPanel.update({ plans: [], diagnosis: { reason: "loading" } }, departure);
			return;
		}

		const stations = price_data.filter(
			(s) =>
				station_filter.has(getLogoKey(s, logos, logos_sorted).logoKey) &&
				!blacklist.has(s.id) &&
				Number.isFinite(s.distance_along_route),
		);

		const result = planStops(stations, {
			totalDistanceM: route.distance,
			car: carSettings,
			departure,
		});
		alternativesPanel.update(result, departure);
	}

	// The car profile as the server stores it (initialFuel stays local).
	const toServerCar = (car) => ({
		fuel: car.fuel,
		consumption: car.consumption,
		tank_size: car.tankSize,
		stop_min: car.stopMin,
		stop_max: car.stopMax,
	});
	let savedCar = JSON.stringify(state.car);

	routeOptions = addRouteOptionsControl(map, {
		position: "topleft",
		initialDistance: trip?.max_distance ?? undefined,
		initialCar: {
			fuel: state.car.fuel,
			consumption: state.car.consumption,
			tankSize: state.car.tank_size,
			stopMin: state.car.stop_min,
			stopMax: state.car.stop_max,
		},
		onDistanceChange: async (newDistance) => {
			const initial = distance === null;
			distance = newDistance;
			if (!initial && trip?.owned) {
				updateTrip(trip.id, { max_distance: distance }).catch(tripControl.showError);
			}
			try {
				await reloadStations(distance);
			} catch (e) {
				console.error("No se pudieron cargar las gasolineras", e);
				alternativesPanel.update({ plans: [], diagnosis: { reason: "error" } }, departure);
				return;
			}
			reloadStops();
		},
		onCarChange: (car) => {
			carSettings = car;
			const serverCar = JSON.stringify(toServerCar(car));
			if (serverCar !== savedCar) {
				savedCar = serverCar;
				updateCar(toServerCar(car)).catch((e) => console.error("No se pudo guardar el coche", e));
			}
			reloadStops();
		},
		onDepartureChange: (date) => {
			departure = date;
			reloadStops();
		},
		onPanelToggle: (open) => {
			if (open && isPhone()) alternativesPanel.minimize();
		},
	});

	// Box at the top of the plans sheet: which saved trip this is, and
	// saving / renaming / sharing it.
	function addTripControl() {
		const box = alternativesPanel.tripSlot;
		let message = tripError ?? "";
		let shareUrl = null;

		function defaultName() {
			const from = waypoints[0]?.name;
			const to = waypoints[last]?.name;
			return from && to ? `${from} → ${to}` : "Mi viaje";
		}

		async function save() {
			const name = prompt("Nombre del viaje", trip?.name ?? defaultName())?.trim();
			if (!name) return;
			try {
				const { id } = await createTrip({
					hash,
					route_idx,
					name,
					max_distance: distance,
					blacklist: [...blacklist.blacklist],
				});
				trip = { id, name, owned: true, owner: state.display_name };
				message = "";
				shareUrl = null;
				setTripInUrl(hash, route_idx, id);
				render();
			} catch (e) {
				showError(e);
			}
		}

		async function rename() {
			const name = prompt("Nombre del viaje", trip.name)?.trim();
			if (!name || name === trip.name) return;
			try {
				await updateTrip(trip.id, { name });
				trip.name = name;
				render();
			} catch (e) {
				showError(e);
			}
		}

		async function share() {
			try {
				shareUrl = (await createTripShare(trip.id)).url;
				message = "";
				render();
				await navigator.clipboard?.writeText(shareUrl);
				message = "Enlace copiado.";
				render();
			} catch (e) {
				if (shareUrl) render(); // clipboard refused: the link is still shown
				else showError(e);
			}
		}

		function button(text, onClick) {
			const b = document.createElement("button");
			b.type = "button";
			b.textContent = text;
			b.addEventListener("click", onClick);
			return b;
		}

		function render() {
			box.replaceChildren();

			const title = document.createElement("div");
			title.className = "trip-control-title";
			const actions = document.createElement("div");
			actions.className = "trip-control-actions";

			if (!trip) {
				title.textContent = "Viaje sin guardar";
				actions.append(button("Guardar viaje", save));
			} else if (trip.owned) {
				title.textContent = trip.name;
				actions.append(button("Renombrar", rename), button("Compartir", share));
			} else {
				title.textContent = `${trip.name} · de ${trip.owner}`;
				const note = document.createElement("div");
				note.className = "trip-control-note";
				note.textContent =
					"Compartido contigo: los cambios en la lista negra no se guardan hasta que guardes una copia.";
				box.append(title, note);
				actions.append(button("Guardar copia", save));
			}
			if (!box.contains(title)) box.append(title);
			box.append(actions);

			if (shareUrl) {
				const shareBox = document.createElement("div");
				shareBox.className = "trip-control-share";
				const input = document.createElement("input");
				input.readOnly = true;
				input.value = shareUrl;
				input.addEventListener("focus", () => input.select());
				const note = document.createElement("div");
				note.className = "trip-control-note";
				note.textContent =
					"Solo sirve para una persona: la primera que lo abra. Caduca en 7 días si nadie lo usa.";
				const close = button("Cerrar", () => {
					shareUrl = null;
					message = "";
					render();
				});
				close.className = "trip-control-share-close";
				shareBox.append(input, note, close);
				box.append(shareBox);
			}

			if (message) {
				const msg = document.createElement("div");
				msg.className = "trip-control-message";
				msg.textContent = message;
				box.append(msg);
			}
		}

		function showError(e) {
			console.error(e);
			message = `Error: ${e.message}`;
			render();
		}

		render();

		return { showError };
	}
}

load();
