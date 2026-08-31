import { getPricesOnRoute, getRoute, getUserState } from "./api.js";
import {
	ROUTE_COLORS,
	formatDistance,
	formatDuration,
	coordToLatLng,
	waypointDivIcon,
} from "./route.js";
import { createStationsLayer } from "./stations.js";
import { addRouteOptionsControl } from "./route_options.js";
import { getLogos } from "./logos.js";

async function load() {
	const url = new URL(location.href);
	const path = url.pathname.split("/");
	// /route/hash/id
	const hash = path[2];
	const route_idx = parseInt(path[3]);

	if (hash === null || route_idx == null) {
		location.assign("/files/map");
		return;
	}

	let route_data = getRoute(hash, route_idx);
	let logos = getLogos();
	let state = getUserState();

	const map = L.map("map").setView([40.4165, -3.70256], 11);

	L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
		maxZoom: 19,
		attribution:
			'&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>',
	}).addTo(map);

	route_data = await route_data;

	console.log(route_data);

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
	state = await state;

	// Currently-rendered station layer, so we can tear it down and rebuild
	// it whenever the "distance from route" setting changes.
	let stationsLayer = null;
	// Bumped on every reload so a slow, superseded fetch can't clobber a
	// newer one (e.g. if the user drags the distance slider twice quickly).
	let requestToken = 0;

	// Car profile from the options control; kept around for whatever
	// stop-suggestion logic ends up using it.
	let carSettings = null;

	async function reloadStations(maxDistance) {
		const token = ++requestToken;
		const price_data = await getPricesOnRoute(hash, route_idx, {
			max_distance: maxDistance,
			order_by: "DistanceAlongRoute",
		});
		if (token !== requestToken) return; // a newer request already landed

		if (stationsLayer) {
			map.removeLayer(stationsLayer.markers);
			map.removeControl(stationsLayer.control);
		}

		// Everything about rendering the stations themselves (markers, popups,
		// clustering, and the brand layer control) lives in stations.js.
		stationsLayer = createStationsLayer(map, price_data, logos, {
			filter: state.filter,
			// buildPopupContent: myCustomPopupBuilder, // override to customize popup contents
		});
	}

	addRouteOptionsControl(map, {
		position: "topleft",
		initialDistance: 2000,
		onDistanceChange: (distance) => {
			reloadStations(distance);
		},
		onCarChange: (car) => {
			carSettings = car;
		},
	});
}

load();

