import {
	getPricesOnRoute,
	getRoute,
	getUserState,
	updateFilter,
} from "./api.js";
import {
	ROUTE_COLORS,
	formatDistance,
	formatDuration,
	coordToLatLng,
	waypointDivIcon,
} from "./route.js";
import {
	createStationsLayer,
	getLogoKey,
	sortLogos,
	StationBlacklist,
} from "./stations.js";
import { addRouteOptionsControl } from "./route_options.js";
import { getLogos } from "./logos.js";
import { mapFilterToArray } from "./filter.js";
import { createTripAlternativesPanel } from "./trip_alternatives.js";

// Radius (in meters, measured along the route from the destination) used to
// estimate the fuel price at arrival: we average the price of every
// (filtered) station within this range of the final waypoint. If none are
// found, we fall back to the single closest station to the destination.
const DEST_PRICE_RADIUS_M = 10000;

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
	const logos_sorted = sortLogos(logos);
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
	let price_data = [];

	let station_filter = state.filter;
	const blacklist = new StationBlacklist(); // TODO base blacklist for the trip

	blacklist.on("change", (station, x) => {
		reloadStops();
	});

	const alternativesPanel = createTripAlternativesPanel();

	async function reloadStations(maxDistance) {
		const token = ++requestToken;
		price_data = await getPricesOnRoute(hash, route_idx, {
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
			onFilterChange: (filter) => {
				station_filter = filter;
				updateFilter(filter);
				reloadStops();
			},
			blacklist,
			// buildPopupContent: myCustomPopupBuilder, // override to customize popup contents
		});
	}

	// Estimates what it would cost to fill up right at the destination, so
	// the trip planner can weigh "buy fuel along the way" against "top up
	// when I get there". Averages the price of every station within
	// DEST_PRICE_RADIUS_M (measured along the route from the destination);
	// if there's nothing that close, falls back to the closest priced
	// station to the destination. Returns null if no station has a usable
	// price at all.
	function estimateDestinationPrice(stations, totalDistanceM, priceOf) {
		const priced = [];
		for (const s of stations) {
			const price = priceOf(s);
			if (price == null) continue;
			priced.push({
				price,
				distToDest: totalDistanceM - s.distance_along_route,
			});
		}
		if (!priced.length) return null;

		const nearby = priced.filter(
			({ distToDest }) => distToDest <= DEST_PRICE_RADIUS_M,
		);
		if (nearby.length) {
			const sum = nearby.reduce((acc, { price }) => acc + price, 0);
			return sum / nearby.length;
		}

		// Nothing within range: fall back to the single closest station.
		let closest = priced[0];
		for (const cand of priced) {
			if (cand.distToDest < closest.distToDest) closest = cand;
		}
		return closest.price;
	}

	async function reloadStops(k = 5) {
		if (!carSettings || !price_data.length) {
			renderStopsResult([]);
			return;
		}

		const { consumption, tankSize, initialFuel, stopMin, stopMax, fuel } =
			carSettings;
		if (!consumption || consumption <= 0) {
			renderStopsResult([]);
			return;
		}

		// Hardcoded assumption: a driver wouldn't actually arrive with less than
		// 3/5 of a tank — they'd have topped up somewhere along the way. Without
		// this, the DP is free to minimize purchased liters by coasting in on a
		// near-empty tank after one early cheap fill, which isn't realistic.
		const MIN_ARRIVAL_FRACTION = 3 / 5;
		const minFinalFuel = 0; //tankSize * MIN_ARRIVAL_FRACTION;

		const litersPerMeter = consumption / 100.0 / 1000.0;
		const totalDistanceM = route.distance; // meters

		console.log(station_filter);
		const stations = [...price_data]
			.filter(
				(s) =>
					station_filter.has(
						getLogoKey(s, logos, logos_sorted).logoKey,
					) &&
					!blacklist.has(s.id) &&
					Number.isFinite(s.distance_along_route),
			)
			.sort((a, b) => a.distance_along_route - b.distance_along_route);
		console.log(stations);

		const priceOf = (station) =>
			fuel === "gasolina" ? station.gasolina_95 : station.gasoleo_a;

		// What it would cost to fill the remaining tank once we arrive, based
		// on the (filtered) stations near the destination. null means we have
		// no basis for an estimate, in which case arrival cost is ignored.
		const destPricePerLiter = estimateDestinationPrice(
			stations,
			totalDistanceM,
			priceOf,
		);
		console.log(
			"Estimated destination price per liter:",
			destPricePerLiter,
		);

		const nodes = [
			{ pos: 0, station: null, isStart: true },
			...stations.map((s) => ({
				pos: s.distance_along_route,
				station: s,
			})),
			{ pos: totalDistanceM, station: null, isEnd: true },
		];
		const endIdx = nodes.length - 1;

		const departFuel = (i) => (nodes[i].isStart ? initialFuel : tankSize);

		// dp[j] is now an ARRAY of up to k candidates, sorted by (stops, cost).
		// Each candidate: { stops, cost, prev, prevCandIdx, fuelOnArrival, pathKey }
		const dp = new Array(nodes.length).fill(null).map(() => []);
		dp[0] = [
			{
				stops: 0,
				cost: 0,
				prev: -1,
				prevCandIdx: -1,
				fuelOnArrival: initialFuel,
				pathKey: "s",
			},
		];

		function insertCandidate(list, cand) {
			// Skip exact-duplicate paths (can happen via different orderings landing
			// on the same station sequence — shouldn't normally, but stay safe).
			if (list.some((c) => c.pathKey === cand.pathKey)) return;
			list.push(cand);
			list.sort((a, b) => a.stops - b.stops || a.cost - b.cost);
			if (list.length > k) list.length = k;
		}

		for (let i = 0; i < nodes.length; i++) {
			if (!dp[i].length) continue;
			const fuelAtI = departFuel(i);

			for (let j = i + 1; j < nodes.length; j++) {
				const distM = nodes[j].pos - nodes[i].pos;
				const fuelNeeded = distM * litersPerMeter;
				if (fuelNeeded > fuelAtI) break; // sorted by position, so nothing further is reachable

				const arrivalFuel = fuelAtI - fuelNeeded;
				const isFinal = j === endIdx;
				if (
					!isFinal &&
					(arrivalFuel < stopMin || arrivalFuel > stopMax)
				)
					continue;
				if (isFinal && arrivalFuel < minFinalFuel) continue;

				let stationCost = 0;
				if (!isFinal) {
					const pricePerLiter = priceOf(nodes[j].station);
					if (pricePerLiter == null) continue;
					stationCost =
						Math.max(0, tankSize - arrivalFuel) * pricePerLiter;
				} else if (destPricePerLiter != null) {
					// Arriving with a less-than-full tank isn't free: charge the
					// estimated cost of topping it back up at the destination.
					// This is what lets a cheap destination favor arriving low
					// (skip a stop) and an expensive one favor arriving full.
					stationCost =
						Math.max(0, tankSize - arrivalFuel) * destPricePerLiter;
				}

				// Fan out every candidate at i into a new candidate at j.
				for (let ci = 0; ci < dp[i].length; ci++) {
					const base = dp[i][ci];
					insertCandidate(dp[j], {
						stops: base.stops + (isFinal ? 0 : 1),
						cost: base.cost + stationCost,
						prev: i,
						prevCandIdx: ci,
						fuelOnArrival: arrivalFuel,
						pathKey: `${base.pathKey}>${j}`,
					});
				}
			}
		}

		if (!dp[endIdx].length) {
			console.warn(
				"No feasible fuel-stop plan found for this route/car settings.",
			);
			renderStopsResult([]);
			return;
		}

		// Backtrack each of the top-K final candidates into a full plan.
		const plans = dp[endIdx].map((finalCand) => {
			const path = [];
			let node = endIdx;
			let cand = finalCand;
			while (node !== -1) {
				path.unshift({ node, cand });
				if (cand.prev === -1) break;
				const prevNode = cand.prev;
				const prevCand = dp[prevNode][cand.prevCandIdx];
				node = prevNode;
				cand = prevCand;
			}

			const stops = path
				.filter(({ node }) => nodes[node].station)
				.map(({ node, cand }) => {
					const station = nodes[node].station;
					const pricePerLiter = priceOf(station);
					const litersBought = Math.max(
						0,
						tankSize - cand.fuelOnArrival,
					);
					return {
						station,
						arrivalFuel: cand.fuelOnArrival,
						litersBought,
						pricePerLiter,
						cost: litersBought * pricePerLiter,
					};
				});

			// Broken out separately from totalCost (which already includes it)
			// purely so the UI can show "X on the road + Y to top up on arrival".
			const destRefillLiters = Math.max(
				0,
				tankSize - finalCand.fuelOnArrival,
			);
			const destRefillCost =
				destPricePerLiter != null
					? destRefillLiters * destPricePerLiter
					: 0;

			return {
				stops,
				totalCost: finalCand.cost,
				totalStops: finalCand.stops,
				finalArrivalFuel: finalCand.fuelOnArrival, // fuel left in tank at destination
				destPricePerLiter,
				destRefillLiters,
				destRefillCost,
			};
		});

		renderStopsResult(plans);
	}

	function renderStopsResult(plans) {
		if (!plans.length) {
			console.log("Sin paradas necesarias o sin plan factible.");
		} else {
			plans.forEach((plan, planIdx) => {
				// totalCost (used by the DP for ranking) bundles on-route fuel with
				// the estimated destination top-up; split it back out here so the
				// two are printed separately.
				const onTripCost = plan.totalCost - plan.destRefillCost;

				console.log(
					`--- Opción ${planIdx + 1}: ${plan.totalStops} parada(s) ---`,
				);
				plan.stops.forEach((s, i) => {
					const km = (s.station.distance_along_route / 1000).toFixed(
						1,
					);
					console.log(
						`  ${i + 1}. ${s.station.rotulo} (${s.station.municipio}) — km ${km} — ` +
							`llega con ${s.arrivalFuel.toFixed(1)} L, reposta ${s.litersBought.toFixed(1)} L ` +
							`a ${s.pricePerLiter} €/L = ${s.cost.toFixed(2)} €`,
					);
				});
				console.log(`  Coste en ruta: ${onTripCost.toFixed(2)} €`);
				console.log(
					`  Llegada al destino con ${plan.finalArrivalFuel.toFixed(1)} L restantes` +
						(plan.destPricePerLiter != null
							? ` — repostar al llegar (${plan.destRefillLiters.toFixed(1)} L a ${plan.destPricePerLiter.toFixed(3)} €/L): ${plan.destRefillCost.toFixed(2)} €`
							: " — sin precio estimado de destino"),
				);
				console.log(
					`  Coste total estimado (ruta + destino): ${plan.totalCost.toFixed(2)} €`,
				);
			});
		}

		// Render plans in the UI panel
		alternativesPanel.update(plans);
	}

	addRouteOptionsControl(map, {
		position: "topleft",
		initialDistance: 2000,
		onDistanceChange: async (distance) => {
			await reloadStations(distance);
			await reloadStops();
		},
		onCarChange: async (car) => {
			carSettings = car;
			await reloadStops();
		},
	});
}

load();
