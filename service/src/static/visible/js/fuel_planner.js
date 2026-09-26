// Picks where to refuel along a route. Every stop fills the tank, so what
// happens after a station doesn't depend on how you got there: a DP over the
// stations (sorted by position) finds the plans with the fewest stops, and
// the cheapest among those.

import { getStatus } from "./schedules.js";

// Radius (in meters, measured along the route from the destination) used to
// estimate the fuel price at arrival: we average the price of every
// (filtered) station within this range of the final waypoint. If none are
// found, we fall back to the single closest station to the destination.
const DEST_PRICE_RADIUS_M = 10000;

// Leaving the route to reach a station and coming back is estimated as twice
// its straight-line distance from the route (no extra routing requests).
const DETOUR_FACTOR = 2;

export function priceFor(station, fuel) {
	return fuel === "gasolina" ? station.gasolina_95 : station.gasoleo_a;
}

// When the car would reach `station`, leaving at `departure` (a Date).
export function arrivalTime(station, departure) {
	return new Date(departure.getTime() + station.duration * 1000);
}

// Whether `station` can be used at `eta`:
//   "open" | "closesSoon" (usable, but flagged) | "unknown" (unparseable or
//   Monday-only schedule: usable, flagged) | "closed" (not usable).
export function statusAt(station, eta) {
	const { status, uncertain } = getStatus(station.horario, eta);
	if (status === "invalid_format" || uncertain) return "unknown";
	if (status === "opensSoon") return "closed";
	return status;
}

// Estimates what it would cost to fill up right at the destination, so
// the planner can weigh "buy fuel along the way" against "top up when I get
// there". Returns null if no station has a usable price at all.
function estimateDestinationPrice(stations, totalDistanceM, priceOf) {
	const priced = [];
	for (const s of stations) {
		const price = priceOf(s);
		if (price == null) continue;
		priced.push({ price, distToDest: totalDistanceM - s.distance_along_route });
	}
	if (!priced.length) return null;

	const nearby = priced.filter(({ distToDest }) => distToDest <= DEST_PRICE_RADIUS_M);
	if (nearby.length) {
		return nearby.reduce((acc, { price }) => acc + price, 0) / nearby.length;
	}

	// Nothing within range: fall back to the single closest station.
	let closest = priced[0];
	for (const cand of priced) {
		if (cand.distToDest < closest.distToDest) closest = cand;
	}
	return closest.price;
}

/**
 * @param {object[]} stations  candidate stations (already filtered by brand
 *        and blacklist), as returned by getPricesOnRoute
 * @param {object} opts
 * @param {number} opts.totalDistanceM  route length
 * @param {object} opts.car  { fuel, consumption, tankSize, initialFuel, stopMin, stopMax }
 * @param {Date} opts.departure
 * @param {number} [opts.k]  how many alternative plans to return
 * @returns {{ plans: object[], diagnosis: object | null }} diagnosis explains
 *          why `plans` is empty: { reason: "no_car" | "bad_range" | "low_start" | "gap", ... }
 */
export function planStops(stations, { totalDistanceM, car, departure, k = 5 }) {
	const { consumption, tankSize, stopMin, stopMax, fuel } = car;
	if (!(consumption > 0) || !(tankSize > 0)) {
		return { plans: [], diagnosis: { reason: "no_car" } };
	}
	if (stopMin > stopMax || stopMin >= tankSize) {
		return { plans: [], diagnosis: { reason: "bad_range" } };
	}
	const initialFuel = Math.min(car.initialFuel, tankSize);

	const litersPerMeter = consumption / 100.0 / 1000.0;
	const priceOf = (station) => priceFor(station, fuel);

	// Stations closed when we'd get there are out; the rest carry their ETA.
	let closedCount = 0;
	const usable = [];
	for (const station of stations) {
		if (priceOf(station) == null) continue;
		const eta = arrivalTime(station, departure);
		const status = statusAt(station, eta);
		if (status === "closed") {
			closedCount++;
			continue;
		}
		usable.push({ station, eta, status });
	}
	usable.sort((a, b) => a.station.distance_along_route - b.station.distance_along_route);

	// What it would cost to fill the remaining tank once we arrive. null means
	// we have no basis for an estimate, in which case arrival cost is ignored.
	const destPricePerLiter = estimateDestinationPrice(stations, totalDistanceM, priceOf);

	const nodes = [
		{ pos: 0, isStart: true },
		...usable.map((u) => ({ pos: u.station.distance_along_route, ...u })),
		{ pos: totalDistanceM, isEnd: true },
	];
	const endIdx = nodes.length - 1;

	const departFuel = (i) => (nodes[i].isStart ? initialFuel : tankSize);

	// Going to the station and back to the route isn't free either.
	const detourMOf = (station) => DETOUR_FACTOR * (station.distance_from_route ?? 0);
	const detourCostOf = (station) => detourMOf(station) * litersPerMeter * priceOf(station);

	// dp[j] is an array of up to k candidates, sorted by (stops, cost).
	// Each candidate: { stops, cost, prev, prevCandIdx, fuelOnArrival, pathKey }
	const dp = nodes.map(() => []);
	dp[0] = [{ stops: 0, cost: 0, prev: -1, prevCandIdx: -1, fuelOnArrival: initialFuel, pathKey: "s" }];

	function insertCandidate(list, cand) {
		if (list.some((c) => c.pathKey === cand.pathKey)) return;
		list.push(cand);
		list.sort((a, b) => a.stops - b.stops || a.cost - b.cost);
		if (list.length > k) list.length = k;
	}

	for (let i = 0; i < nodes.length; i++) {
		if (!dp[i].length) continue;
		const fuelAtI = departFuel(i);

		for (let j = i + 1; j < nodes.length; j++) {
			const fuelNeeded = (nodes[j].pos - nodes[i].pos) * litersPerMeter;
			if (fuelNeeded > fuelAtI) break; // sorted by position, so nothing further is reachable

			const arrivalFuel = fuelAtI - fuelNeeded;
			const isFinal = j === endIdx;
			// The tank never goes below stopMin, not even on arrival: coasting
			// into the destination on fumes isn't a plan.
			if (arrivalFuel < stopMin) continue;
			if (!isFinal && arrivalFuel > stopMax) continue;

			let stepCost = 0;
			if (!isFinal) {
				const station = nodes[j].station;
				stepCost = (tankSize - arrivalFuel) * priceOf(station) + detourCostOf(station);
			} else if (destPricePerLiter != null) {
				// Arriving with a less-than-full tank isn't free: charge the
				// estimated cost of topping it back up at the destination.
				// This is what lets a cheap destination favor arriving low
				// (skip a stop) and an expensive one favor arriving full.
				stepCost = Math.max(0, tankSize - arrivalFuel) * destPricePerLiter;
			}

			for (let ci = 0; ci < dp[i].length; ci++) {
				const base = dp[i][ci];
				insertCandidate(dp[j], {
					stops: base.stops + (isFinal ? 0 : 1),
					cost: base.cost + stepCost,
					prev: i,
					prevCandIdx: ci,
					fuelOnArrival: arrivalFuel,
					pathKey: `${base.pathKey}>${j}`,
				});
			}
		}
	}

	if (!dp[endIdx].length) {
		return { plans: [], diagnosis: diagnose() };
	}

	// Why no plan reaches the destination: from the furthest point any plan
	// gets to, there's a stretch of road where the tank is within
	// [stopMin, stopMax] and a stop is needed, but no usable station in it.
	function diagnose() {
		let furthest = 0;
		for (let i = 0; i < endIdx; i++) if (dp[i].length) furthest = i;
		const node = nodes[furthest];
		const fuel = departFuel(furthest);
		if (fuel < stopMin) return { reason: "low_start" };
		const fromM = node.pos + Math.max(0, fuel - stopMax) / litersPerMeter;
		const toM = Math.min(totalDistanceM, node.pos + (fuel - stopMin) / litersPerMeter);
		return {
			reason: "gap",
			fromKm: fromM / 1000,
			toKm: toM / 1000,
			closedCount,
		};
	}

	// Backtrack each of the top-K final candidates into a full plan.
	const plans = dp[endIdx].map((finalCand) => {
		const path = [];
		let node = endIdx;
		let cand = finalCand;
		while (node !== -1) {
			path.unshift({ node, cand });
			if (cand.prev === -1) break;
			const prevCand = dp[cand.prev][cand.prevCandIdx];
			node = cand.prev;
			cand = prevCand;
		}

		const stops = path
			.filter(({ node }) => nodes[node].station)
			.map(({ node, cand }) => {
				const { station, eta, status } = nodes[node];
				const pricePerLiter = priceOf(station);
				const litersBought = Math.max(0, tankSize - cand.fuelOnArrival);
				return {
					station,
					eta,
					status,
					detourM: detourMOf(station),
					arrivalFuel: cand.fuelOnArrival,
					litersBought,
					pricePerLiter,
					cost: litersBought * pricePerLiter,
				};
			});

		// Broken out separately from totalCost (which already includes it)
		// purely so the UI can show "X on the road + Y to top up on arrival".
		const destRefillLiters = Math.max(0, tankSize - finalCand.fuelOnArrival);
		const destRefillCost = destPricePerLiter != null ? destRefillLiters * destPricePerLiter : 0;

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

	return { plans, diagnosis: null };
}
