import { fitToScreen, onlyOneOpen } from "./map_panels.js";
import { escapeHtml, logoBadge, priceDigits, stationLogo } from "./stations.js";

const PUMP_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16"/><path d="M3 21h12"/><path d="M4 10h10"/><path d="M14 8h2a2 2 0 0 1 2 2v5.5a1.5 1.5 0 0 0 3 0V8l-3-3"/></svg>`;

const FUELS = [
	{ key: "gasolina_95", name: "Gasolina 95", className: "g95" },
	{ key: "gasoleo_a", name: "Gasóleo A", className: "diesel" },
];

// Zoomed far out there can be thousands of stations on screen: the list
// shows the cheapest ones only.
const MAX_ROWS = 100;

// Phones: the list is a bottom sheet (stations.css), not a dropdown.
const isPhone = () => matchMedia("(max-width: 639px)").matches;

// Button in the top-right corner that lists the stations on screen, cheapest
// first, for the chosen fuel. Tapping one zooms to it and opens its popup.
export function addVisibleStationsControl(map, clusterGroup, allMarkers) {
	const VisibleStationsControl = L.Control.extend({
		options: { position: "topright" },

		onAdd: function (map) {
			const container = L.DomUtil.create("div", "leaflet-control map-dropdown stations-control");

			// Prevent map clicks and scrolling from passing through the control
			L.DomEvent.disableClickPropagation(container);
			L.DomEvent.disableScrollPropagation(container);

			this._currentSort = "gasolina_95";

			container.innerHTML = `
				<button type="button" class="map-button" aria-label="Gasolineras en pantalla" aria-expanded="false" aria-controls="stationsPanel">${PUMP_ICON}</button>
				<section id="stationsPanel" class="map-dropdown-panel stations-panel" aria-label="Gasolineras en pantalla" hidden>
					<div class="map-panel-head">
						<div>
							<h2>Gasolineras en pantalla</h2>
							<p class="map-panel-sub"></p>
						</div>
						<button type="button" class="map-panel-close" aria-label="Cerrar">&times;</button>
					</div>
					<div class="segmented" role="radiogroup" aria-label="Ordenar por precio de">
						${FUELS.map(
							(f) =>
								`<button type="button" role="radio" data-fuel="${f.key}" aria-checked="${f.key === this._currentSort}">${f.name}</button>`,
						).join("")}
					</div>
					<ol class="stations-items"></ol>
				</section>
			`;

			const toggle = container.querySelector(".map-button");
			const panel = container.querySelector(".stations-panel");
			const list = container.querySelector(".stations-items");
			const count = container.querySelector(".map-panel-sub");
			const sortButtons = [...container.querySelectorAll(".segmented button")];

			const update = () => this._updateList(map, list, count);

			const setOpen = (open) => {
				panel.hidden = !open;
				container.classList.toggle("open", open);
				toggle.setAttribute("aria-expanded", String(open));
				// The sheet covers the bottom of the screen on phones: the route
				// button would sit on top of it.
				document.body.classList.toggle("map-sheet-open", open);
				if (open) {
					panels.opened();
					update();
					list.scrollTop = 0;
					if (!isPhone()) fitToScreen(panel);
					else panel.style.maxHeight = "";
				}
			};
			const panels = onlyOneOpen(map, "stations", () => setOpen(false));

			toggle.addEventListener("click", () => setOpen(panel.hidden));
			container.querySelector(".map-panel-close").addEventListener("click", () => setOpen(false));
			map.on("click", () => setOpen(false));
			document.addEventListener("keydown", (e) => {
				if (e.key === "Escape" && !panel.hidden) {
					setOpen(false);
					toggle.focus();
				}
			});

			sortButtons.forEach((button) => {
				button.addEventListener("click", () => {
					this._currentSort = button.dataset.fuel;
					for (const b of sortButtons) b.setAttribute("aria-checked", String(b === button));
					update();
					list.scrollTop = 0;
				});
			});

			// Tapping a station closes the list (it would cover the popup),
			// then zooms to it if it's in a cluster and opens its popup.
			list.addEventListener("click", (e) => {
				const row = e.target.closest(".station-row");
				if (!row) return;
				const marker = this._shown[Number(row.dataset.index)];
				if (!marker) return;
				setOpen(false);
				clusterGroup.zoomToShowLayer(marker, () => marker.openPopup());
			});

			// Update list dynamically if map is panned/zoomed while list is open
			map.on("moveend", () => {
				if (!panel.hidden) update();
			});

			return container;
		},

		_updateList: function (map, list, count) {
			const bounds = map.getBounds();
			const sort = this._currentSort;

			// Only markers inside the map view AND in a brand that's shown.
			const visible = allMarkers.filter(
				(m) => clusterGroup.hasLayer(m) && bounds.contains(m.getLatLng()),
			);
			// Stations without the selected fuel go last.
			visible.sort((a, b) => (a.eess[sort] ?? Infinity) - (b.eess[sort] ?? Infinity));

			this._shown = visible.slice(0, MAX_ROWS);
			count.textContent =
				visible.length === 0
					? "Ninguna a la vista"
					: visible.length > MAX_ROWS
						? `Las ${MAX_ROWS} más baratas de ${visible.length}. Acércate para ver el resto.`
						: `${visible.length} a la vista, de más barata a más cara`;

			if (visible.length === 0) {
				list.innerHTML = `<li class="stations-empty">Mueve el mapa o activa más marcas para ver gasolineras.</li>`;
				return;
			}

			list.innerHTML = this._shown
				.map((m, i) => {
					const eess = m.eess;
					const prices = FUELS.map(
						(f) => `
						<span class="row-price ${f.className}${f.key === sort ? " sorted" : ""}">
							<span class="fuel-chip"></span>
							<span class="digits">${eess[f.key] != null ? priceDigits(eess[f.key]) : "—"}</span>
						</span>`,
					).join("");
					return `
					<li>
						<button type="button" class="station-row" data-index="${i}">
							${logoBadge(stationLogo(eess), eess.rotulo, "row-logo")}
							<span class="row-name">
								<strong>${escapeHtml(eess.rotulo)}</strong>
								<span>${escapeHtml(eess.localidad ?? eess.municipio ?? "")}</span>
							</span>
							<span class="row-prices">${prices}</span>
						</button>
					</li>`;
				})
				.join("");
		},
	});

	new VisibleStationsControl().addTo(map);
}
