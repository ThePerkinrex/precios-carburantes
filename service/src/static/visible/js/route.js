import { createRoute, getRoutes } from "./api.js";

// Colors used to distinguish alternative routes on the map and in the tabs.
export const ROUTE_COLORS = ["#2563eb", "#f97316", "#16a34a", "#9333ea", "#dc2626"];

export function formatDistance(meters) {
	if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
	return `${Math.round(meters)} m`;
}

export function formatDuration(seconds) {
	const totalMin = Math.round(seconds / 60);
	const h = Math.floor(totalMin / 60);
	const m = totalMin % 60;
	if (h > 0) return `${h} h ${m} min`;
	return `${m} min`;
}

// The backend's `geometry` field is a geo_types LineString using GeoJSON's
// coordinate order (x = lon, y = lat), but geo_types serializes each point
// as an {x, y} object rather than a [lon, lat] tuple.
export function coordToLatLng({ x, y }) {
	return [y, x];
}

export function waypointDivIcon(index, isFirst, isLast) {
	const cls = isFirst ? "start" : isLast ? "end" : "";
	return L.divIcon({
		className: "route-waypoint-icon",
		html: `<div class="route-waypoint-marker ${cls}">${index + 1}</div>`,
		iconSize: [28, 28],
		iconAnchor: [14, 14],
	});
}

const FAB_ICON = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
	<circle cx="6" cy="19" r="2.25"></circle>
	<circle cx="18" cy="5" r="2.25"></circle>
	<path d="M6 16.75V13a4 4 0 0 1 4-4h4a4 4 0 0 0 4-4"></path>
</svg>`;

const HANDLE_ICON = `<svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor">
	<circle cx="6" cy="4" r="1.5"></circle>
	<circle cx="6" cy="10" r="1.5"></circle>
	<circle cx="6" cy="16" r="1.5"></circle>
	<circle cx="14" cy="4" r="1.5"></circle>
	<circle cx="14" cy="10" r="1.5"></circle>
	<circle cx="14" cy="16" r="1.5"></circle>
</svg>`;

export function addRouteControl(map) {
	const state = {
		active: false,
		waypoints: [], // { marker, latlng }
		routeLayers: [],
		routes: [],
		selectedRouteIndex: 0,
		loading: false,
	};

	// --- Build the FAB + panel DOM (kept outside the map container so
	// touches on them never reach Leaflet's own click handling) ---
	const fab = document.createElement("button");
	fab.type = "button";
	fab.className = "route-fab";
	fab.setAttribute("aria-label", "Buscar ruta");
	fab.innerHTML = FAB_ICON;

	const panel = document.createElement("div");
	panel.className = "route-panel hidden";
	panel.innerHTML = `
		<div class="route-panel-header">
			<span>Ruta</span>
			<button type="button" class="route-close" aria-label="Cerrar">&times;</button>
		</div>
		<div class="route-hint">Toca el mapa para añadir puntos de ruta</div>
		<ul class="route-waypoint-list"></ul>
		<div class="route-summary hidden"></div>
		<div class="route-actions">
			<button type="button" class="route-clear" disabled>Vaciar</button>
			<button type="button" class="route-calc" disabled>Calcular ruta</button>
		</div>
	`;

	document.body.appendChild(panel);
	document.body.appendChild(fab);

	const listEl = panel.querySelector(".route-waypoint-list");
	const calcBtn = panel.querySelector(".route-calc");
	const clearBtn = panel.querySelector(".route-clear");
	const closeBtn = panel.querySelector(".route-close");
	const summaryEl = panel.querySelector(".route-summary");
	const hintEl = panel.querySelector(".route-hint");

	function updateWaypointIcons() {
		const last = state.waypoints.length - 1;
		state.waypoints.forEach((wp, i) => {
			wp.marker.setIcon(waypointDivIcon(i, i === 0, i === last && last > 0));
		});
	}

	function renderList() {
		listEl.innerHTML = "";
		for (const [i, wp] of state.waypoints.entries()) {
			const li = document.createElement("li");
			li.className = "route-waypoint-item";
			li.innerHTML = `
				<button type="button" class="route-waypoint-handle" aria-label="Arrastrar para reordenar el punto ${i + 1}">${HANDLE_ICON}</button>
				<span class="route-waypoint-index">${i + 1}</span>
				<span class="route-waypoint-coords">${wp.latlng.lat.toFixed(5)}, ${wp.latlng.lng.toFixed(5)}</span>
				<button type="button" class="route-waypoint-remove" aria-label="Eliminar punto ${i + 1}">&times;</button>
			`;
			li.querySelector(".route-waypoint-remove").addEventListener("click", () => removeWaypoint(i));
			attachDragHandlers(li);
			listEl.appendChild(li);
		}
		calcBtn.disabled = state.waypoints.length < 2 || state.loading;
		clearBtn.disabled = state.waypoints.length === 0 || state.loading;
		hintEl.classList.toggle("hidden", state.waypoints.length > 0);
	}

	// Lets a waypoint row be dragged (mouse or touch, via Pointer Events) to
	// a new position in the list, so a middle stop can be added by tapping
	// the map (which appends it at the end) and then dragging it between
	// the start and end rows, instead of deleting and re-adding points.
	function attachDragHandlers(li) {
		const handle = li.querySelector(".route-waypoint-handle");

		handle.addEventListener("pointerdown", (e) => {
			if (e.pointerType === "mouse" && e.button !== 0) return;
			e.preventDefault();

			const order = Array.from(listEl.children);
			const startIndex = order.indexOf(li);
			const itemHeight = li.getBoundingClientRect().height;
			const startY = e.clientY;
			let currentIndex = startIndex;

			li.classList.add("dragging");
			handle.setPointerCapture(e.pointerId);

			function updateSiblingPositions(newIndex) {
				order.forEach((el, i) => {
					if (i === startIndex) return;
					let shift = 0;
					if (startIndex < newIndex && i > startIndex && i <= newIndex) shift = -1;
					else if (startIndex > newIndex && i >= newIndex && i < startIndex) shift = 1;
					el.style.transform = shift ? `translateY(${shift * itemHeight}px)` : "";
				});
			}

			function onMove(ev) {
				const deltaY = ev.clientY - startY;
				li.style.transform = `translateY(${deltaY}px)`;
				const rawIndex = startIndex + Math.round(deltaY / itemHeight);
				const newIndex = Math.max(0, Math.min(order.length - 1, rawIndex));
				if (newIndex !== currentIndex) {
					currentIndex = newIndex;
					updateSiblingPositions(currentIndex);
				}
			}

			function onUp(ev) {
				handle.releasePointerCapture(ev.pointerId);
				handle.removeEventListener("pointermove", onMove);
				handle.removeEventListener("pointerup", onUp);
				handle.removeEventListener("pointercancel", onUp);

				li.classList.remove("dragging");
				li.style.transform = "";
				for (const el of order) el.style.transform = "";

				if (currentIndex !== startIndex) {
					const [wp] = state.waypoints.splice(startIndex, 1);
					state.waypoints.splice(currentIndex, 0, wp);
					updateWaypointIcons();
					renderList();
					clearRouteLayers();
				}
			}

			handle.addEventListener("pointermove", onMove);
			handle.addEventListener("pointerup", onUp);
			handle.addEventListener("pointercancel", onUp);
		});
	}

	function clearRouteLayers() {
		for (const layer of state.routeLayers) map.removeLayer(layer);
		state.routeLayers = [];
		state.routes = [];
		state.selectedRouteIndex = 0;
		summaryEl.classList.add("hidden");
		summaryEl.innerHTML = "";
	}

	function addWaypoint(latlng) {
		const wp = { marker: null, latlng };
		const marker = L.marker(latlng, { draggable: true }).addTo(map);
		wp.marker = marker;

		marker.on("drag", (e) => {
			wp.latlng = e.target.getLatLng();
			renderList();
		});
		marker.on("dragend", clearRouteLayers);

		state.waypoints.push(wp);
		updateWaypointIcons();
		renderList();
		clearRouteLayers();
	}

	function removeWaypoint(index) {
		const [wp] = state.waypoints.splice(index, 1);
		map.removeLayer(wp.marker);
		updateWaypointIcons();
		renderList();
		clearRouteLayers();
	}

	function clearAll() {
		for (const wp of state.waypoints) map.removeLayer(wp.marker);
		state.waypoints = [];
		clearRouteLayers();
		renderList();
	}

	function onMapClick(e) {
		if (!state.active || state.loading) return;
		addWaypoint(e.latlng);
	}

	function setActive(active) {
		state.active = active;
		panel.classList.toggle("hidden", !active);
		fab.classList.toggle("active", active);
		map.getContainer().classList.toggle("route-crosshair", active);
	}

	fab.addEventListener("click", () => setActive(!state.active));
	closeBtn.addEventListener("click", () => setActive(false));
	clearBtn.addEventListener("click", clearAll);
	calcBtn.addEventListener("click", calculateRoute);

	map.on("click", onMapClick);

	function drawRoutes() {
		for (const layer of state.routeLayers) map.removeLayer(layer);
		state.routeLayers = [];

		// Draw the non-selected alternatives first (thin, dashed, behind),
		// then the selected route on top (thick, solid).
		state.routes.forEach((route, i) => {
			if (i === state.selectedRouteIndex) return;
			const latlngs = route.geometry.map(coordToLatLng);
			const layer = L.polyline(latlngs, {
				color: ROUTE_COLORS[i % ROUTE_COLORS.length],
				weight: 4,
				opacity: 0.55,
				dashArray: "6 8",
			}).addTo(map);
			layer.on("click", () => selectRoute(i));
			state.routeLayers.push(layer);
		});

		const main = state.routes[state.selectedRouteIndex];
		if (main) {
			const latlngs = main.geometry.map(coordToLatLng);
			const layer = L.polyline(latlngs, {
				color: ROUTE_COLORS[state.selectedRouteIndex % ROUTE_COLORS.length],
				weight: 6,
				opacity: 0.95,
			}).addTo(map);
			state.routeLayers.push(layer);
			map.fitBounds(layer.getBounds(), { padding: [40, 40] });
		}
	}

	function selectRoute(index) {
		state.selectedRouteIndex = index;
		drawRoutes();
		renderSummary();
	}

	function renderSummary() {
		summaryEl.classList.remove("hidden");
		summaryEl.innerHTML = "";

		if (state.routes.length > 1) {
			const tabs = document.createElement("div");
			tabs.className = "route-tabs";
			state.routes.forEach((route, i) => {
				const tab = document.createElement("button");
				tab.type = "button";
				tab.className = "route-tab" + (i === state.selectedRouteIndex ? " selected" : "");
				tab.style.setProperty("--route-color", ROUTE_COLORS[i % ROUTE_COLORS.length]);
				tab.textContent = `Ruta ${i + 1}`;
				tab.addEventListener("click", () => selectRoute(i));
				tabs.appendChild(tab);
			});
			summaryEl.appendChild(tabs);
		}

		const selected = state.routes[state.selectedRouteIndex];
		const info = document.createElement("div");
		info.className = "route-info";
		info.innerHTML = `
			<span class="route-distance">${formatDistance(selected.distance)}</span>
			<span class="route-duration">${formatDuration(selected.duration)}</span>
		`;
		summaryEl.appendChild(info);
	}

	async function calculateRoute() {
		if (state.waypoints.length < 2 || state.loading) return;

		state.loading = true;
		calcBtn.disabled = true;
		clearBtn.disabled = true;
		calcBtn.textContent = "Calculando...";
		clearRouteLayers();

		try {
			const payload = state.waypoints.map((wp) => [wp.latlng.lat, wp.latlng.lng]);
			const { hash } = await createRoute(payload);
			const data = await getRoutes(hash);

			if (!data.routes || data.routes.length === 0) {
				throw new Error("empty route list");
			}

			state.routes = data.routes;
			state.selectedRouteIndex = 0;
			drawRoutes();
			renderSummary();
		} catch (err) {
			console.error("Error calculando la ruta", err);
			summaryEl.classList.remove("hidden");
			summaryEl.innerHTML = `<div class="route-error">No se pudo calcular la ruta. Inténtalo de nuevo.</div>`;
		} finally {
			state.loading = false;
			calcBtn.textContent = "Calcular ruta";
			renderList();
		}
	}

	return {
		destroy() {
			map.off("click", onMapClick);
			clearAll();
			fab.remove();
			panel.remove();
		},
	};
}