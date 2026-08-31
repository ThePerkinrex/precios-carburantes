import { addVisibleStationsControl } from "./visible_stations.js";
import { getLatestPrices, getUserState } from "./api.js";
import { getLogos } from "./logos.js";
import { addRouteControl } from "./route.js";
import { createStationsLayer } from "./stations.js";

let marker = undefined;

const MAX_DATA_AGE_MS = 3 * 60 * 60 * 1000; // 3 hours
let lastLoadTime = Date.now();

const isAndroid = /Android/i.test(navigator.userAgent);

function reloadIfStale() {
	const age = Date.now() - lastLoadTime;
	if (age > MAX_DATA_AGE_MS) {
		console.log(`Data is ${Math.round(age / 60000)} min old, reloading`);
		location.reload();
	}
}

// Mobile Safari/Chrome often restore the page from bfcache without a
// normal "load" — visibilitychange covers most cases, pageshow covers bfcache restores.
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "visible") {
		reloadIfStale();
	}
});

window.addEventListener("pageshow", (event) => {
	if (event.persisted) {
		reloadIfStale();
	}
});

function onLocationFound(map, e) {
	const radius = e.accuracy;

	if (marker === undefined) {
		marker = {
			marker: L.marker(e.latlng),
			circle: L.circle(e.latlng, radius),
		};
		marker.marker.addTo(map);
		marker.circle.addTo(map);
	} else {
		marker.marker.setLatLng(e.latlng);
		marker.circle.setLatLng(e.latlng);
		marker.circle.setRadius(radius);
	}

	console.log("Got location");
}

function onLocationError(e) {
	console.error(e.message);
}

async function load() {
	let data = getLatestPrices();
	let logos = getLogos();
	let state = getUserState();

	const map = L.map("map").setView([40.4165, -3.70256], 11);

	L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
		maxZoom: 19,
		attribution:
			'&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>',
	}).addTo(map);

	map.on("locationfound", (x) => {
		map.off("locationfound");
		onLocationFound(map, x);
		map.locate({ watch: true, maximumAge: 5000 });
		map.on("locationfound", (x) => {
			console.log("watching location");
			onLocationFound(map, x);
		});
	});

	map.on("locationerror", onLocationError);
	map.locate({ setView: true, maxZoom: 12, maximumAge: 5000 });
	//map.locate({watch: true});

	data = await data;
	logos = await logos;
	lastLoadTime = Date.now();
	state = await state;

	// Everything about rendering the stations themselves (markers, popups,
	// clustering, and the brand layer control) lives in stations.js now.
	// `data` is the full list of stations to render — filter it before
	// calling this if you only want a subset shown.
	const { markers, allMarkers } = createStationsLayer(map, data, logos, {
		filter: state.filter,
		// buildPopupContent: myCustomPopupBuilder, // override to customize popup contents
	});

	addVisibleStationsControl(map, markers, allMarkers);
	addRouteControl(map);
}

load();

