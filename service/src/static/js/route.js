import { getRoute } from "./api.js";

const ROUTE_COLORS = ["#2a6fdb", "#e0a800", "#28a745", "#dc3545", "#6f42c1"];

// Adjust this if the backend's LineString serialization differs from
// plain {x, y} coordinate objects (x = lon, y = lat).
function coordToLatLng(coord) {
	if (Array.isArray(coord)) return [coord[1], coord[0]]; // [lon, lat] -> [lat, lon]
	return [coord.y, coord.x];
}

function labelForRole(role) {
	if (role === "origin") return "el origen";
	if (role === "destination") return "el destino";
	return "una parada";
}

function formatDuration(seconds) {
	const mins = Math.round(seconds / 60);
	if (mins < 60) return `${mins} min`;
	const h = Math.floor(mins / 60);
	const m = mins % 60;
	return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

function formatDistance(meters) {
	if (meters < 1000) return `${Math.round(meters)} m`;
	return `${(meters / 1000).toFixed(1)} km`;
}

export function addRouteControl(map) {
	const waypoints = []; // { lat, lng, marker }
	const routeLayer = L.layerGroup().addTo(map);
	let pendingRole = null; // "origin" | "destination" | "waypoint" | null
	let fetchToken = 0;
	let debounceTimer = null;

	// In-memory cache so identical searches this session don't re-hit the
	// server. Persisting this across sessions/users is planned separately.
	const routeCache = new Map();

	const RoutePanel = L.Control.extend({
		options: { position: "bottomleft" },
		onAdd: function () {
			const container = L.DomUtil.create("div", "route-control");
			L.DomEvent.disableClickPropagation(container);
			L.DomEvent.disableScrollPropagation(container);

			container.innerHTML = `
				<button class="route-toggle" type="button" aria-label="Planificar ruta">🧭 Ruta</button>
				<div class="route-panel" hidden>
					<div class="route-actions">
						<button type="button" data-role="origin" class="route-btn">📍 Origen</button>
						<button type="button" data-role="destination" class="route-btn">🏁 Destino</button>
						<button type="button" data-role="waypoint" class="route-btn">➕ Parada</button>
						<button type="button" class="route-btn route-clear">🗑 Limpiar</button>
					</div>
					<ul class="route-list"></ul>
					<div class="route-status"></div>
					<div class="route-summary"></div>
				</div>
			`;

			const toggleBtn = container.querySelector(".route-toggle");
			const panel = container.querySelector(".route-panel");
			toggleBtn.addEventListener("click", () => {
				panel.hidden = !panel.hidden;
			});

			container.querySelectorAll(".route-btn[data-role]").forEach((btn) =>
				btn.addEventListener("click", () => {
					pendingRole = btn.dataset.role;
					container
						.querySelectorAll(".route-btn[data-role]")
						.forEach((b) => b.classList.remove("active"));
					btn.classList.add("active");
					setStatus(
						`Toca el mapa para colocar ${labelForRole(pendingRole)}`,
					);
				}),
			);

			container
				.querySelector(".route-clear")
				.addEventListener("click", clearRoute);

			this._container = container;
			this._list = container.querySelector(".route-list");
			this._status = container.querySelector(".route-status");
			this._summary = container.querySelector(".route-summary");
			return container;
		},
	});

	const control = new RoutePanel();
	control.addTo(map);

	function setStatus(text) {
		control._status.textContent = text || "";
	}
	function setSummary(text) {
		control._summary.textContent = text || "";
	}

	function createMarker(wp, idx) {
		const label =
			idx === 0
				? "A"
				: idx === waypoints.length - 1
					? "B"
					: String(idx + 1);
		const marker = L.marker([wp.lat, wp.lng], {
			draggable: true,
			icon: L.divIcon({
				className: "route-marker-icon",
				html: `<div class="route-marker">${label}</div>`,
			}),
		});
		marker.on("dragend", () => {
			const pos = marker.getLatLng();
			wp.lat = pos.lat;
			wp.lng = pos.lng;
			scheduleRoute();
		});
		marker.addTo(map);
		return marker;
	}

	function rebuildMarkers() {
		waypoints.forEach((wp) => wp.marker && map.removeLayer(wp.marker));
		waypoints.forEach((wp, idx) => {
			wp.marker = createMarker(wp, idx);
		});
		renderList();
		scheduleRoute();
	}

	function renderList() {
		control._list.innerHTML = "";
		waypoints.forEach((wp, idx) => {
			const label =
				idx === 0
					? "Origen"
					: idx === waypoints.length - 1
						? "Destino"
						: `Parada ${idx}`;
			const li = document.createElement("li");
			li.className = "route-item";
			li.innerHTML = `
				<span>${label}</span>
				<span class="route-item-buttons">
					<button type="button" class="route-move-up" ${idx === 0 ? "disabled" : ""}>↑</button>
					<button type="button" class="route-move-down" ${idx === waypoints.length - 1 ? "disabled" : ""}>↓</button>
					<button type="button" class="route-remove">✕</button>
				</span>
			`;
			li.querySelector(".route-remove").addEventListener("click", () => {
				waypoints.splice(idx, 1);
				rebuildMarkers();
			});
			li.querySelector(".route-move-up").addEventListener("click", () => {
				[waypoints[idx - 1], waypoints[idx]] = [
					waypoints[idx],
					waypoints[idx - 1],
				];
				rebuildMarkers();
			});
			li.querySelector(".route-move-down").addEventListener(
				"click",
				() => {
					[waypoints[idx + 1], waypoints[idx]] = [
						waypoints[idx],
						waypoints[idx + 1],
					];
					rebuildMarkers();
				},
			);
			control._list.appendChild(li);
		});
	}

	function clearRoute() {
		waypoints.forEach((wp) => wp.marker && map.removeLayer(wp.marker));
		waypoints.length = 0;
		routeLayer.clearLayers();
		renderList();
		setSummary("");
		setStatus("");
	}

	function placeWaypoint(latlng, role) {
		const point = { lat: latlng.lat, lng: latlng.lng };
		if (role === "origin") {
			if (waypoints.length === 0) waypoints.push(point);
			else waypoints[0] = point;
		} else if (role === "destination") {
			if (waypoints.length < 2) waypoints.push(point);
			else waypoints[waypoints.length - 1] = point;
		} else {
			const insertAt =
				waypoints.length >= 2 ? waypoints.length - 1 : waypoints.length;
			waypoints.splice(insertAt, 0, point);
		}
		rebuildMarkers();
	}

	map.on("click", (e) => {
		if (!pendingRole) return;
		placeWaypoint(e.latlng, pendingRole);
		pendingRole = null;
		control._container
			.querySelectorAll(".route-btn[data-role]")
			.forEach((b) => b.classList.remove("active"));
		setStatus("");
	});

	function scheduleRoute() {
		clearTimeout(debounceTimer);
		if (waypoints.length < 2) {
			routeLayer.clearLayers();
			setSummary("");
			return;
		}
		debounceTimer = setTimeout(fetchRoute, 300);
	}

	async function fetchRoute() {
		const coords = waypoints.map((w) => [w.lat, w.lng]);
		const cacheKey = JSON.stringify(coords);
		const token = ++fetchToken;

		if (routeCache.has(cacheKey)) {
			drawRoutes(routeCache.get(cacheKey));
			return;
		}

		setStatus("Buscando ruta…");
		try {
			const data = await getRoute(coords);
			if (token !== fetchToken) return; // superseded by a newer request
			routeCache.set(cacheKey, data);
			drawRoutes(data);
			setStatus("");
		} catch (err) {
			console.error("Route fetch failed", err);
			if (token === fetchToken) setStatus("No se pudo calcular la ruta");
		}
	}

	function drawRoutes(routes) {
		routeLayer.clearLayers();
		if (!routes || routes.length === 0) {
			setSummary("Sin resultados");
			return;
		}
		routes.forEach((route, idx) => {
			const latlngs = route.geometry.map(coordToLatLng);
			const line = L.polyline(latlngs, {
				color: ROUTE_COLORS[idx % ROUTE_COLORS.length],
				weight: idx === 0 ? 6 : 4,
				opacity: idx === 0 ? 0.9 : 0.5,
			}).addTo(routeLayer);

			line.bindTooltip(
				`${formatDuration(route.duration)} · ${formatDistance(route.distance)}`,
				{ sticky: true },
			);
			line.on("click", () => {
				setSummary(
					`Ruta ${idx + 1}: ${formatDuration(route.duration)}, ${formatDistance(route.distance)}`,
				);
			});
		});

		const bounds = L.latLngBounds(routes[0].geometry.map(coordToLatLng));
		map.fitBounds(bounds, { padding: [40, 40] });

		const best = routes[0];
		setSummary(
			`${routes.length} ruta(s) · mejor: ${formatDuration(best.duration)}, ${formatDistance(best.distance)}`,
		);
	}
}
