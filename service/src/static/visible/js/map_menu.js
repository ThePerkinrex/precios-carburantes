import { RENEW_WARNING_DAYS } from "./certs_ui.js";
import { pagesFor } from "./nav.js";

const MENU_ICON = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>`;

// "Your cert expires soon" in Spanish, or null. Same threshold as the account page.
function expiryWarning(notAfter) {
	const days = Math.floor((notAfter * 1000 - Date.now()) / (24 * 60 * 60 * 1000));
	if (days > RENEW_WARNING_DAYS) return null;
	return days <= 0
		? "El certificado de este dispositivo caduca hoy."
		: `El certificado de este dispositivo caduca en ${days} día${days === 1 ? "" : "s"}.`;
}

// Menu button in the top-left corner with links to the other pages.
// `statePromise` resolves to getUserState(); the button works before that,
// the links fill in once it arrives. `current` is the page's id in PAGES,
// left out of the links (null: every page is linked).
export function addMenuControl(map, statePromise, current = "map") {
	const MenuControl = L.Control.extend({
		options: { position: "topleft" },

		onAdd() {
			const container = L.DomUtil.create("div", "leaflet-control map-menu");
			L.DomEvent.disableClickPropagation(container);
			L.DomEvent.disableScrollPropagation(container);

			container.innerHTML = `
				<button type="button" class="map-menu-toggle" aria-label="Menú" aria-expanded="false" aria-controls="mapMenuPanel">
					${MENU_ICON}<span class="map-menu-badge" hidden></span>
				</button>
				<div id="mapMenuPanel" class="map-menu-panel" hidden>
					<div class="map-menu-user"></div>
					<p class="map-menu-warning" hidden></p>
					<ul class="map-menu-links"></ul>
				</div>
			`;
			const toggle = container.querySelector(".map-menu-toggle");
			const panel = container.querySelector(".map-menu-panel");

			const setOpen = (open) => {
				panel.hidden = !open;
				toggle.setAttribute("aria-expanded", String(open));
				toggle.classList.toggle("active", open);
			};
			toggle.addEventListener("click", () => setOpen(panel.hidden));
			map.on("click", () => setOpen(false));
			document.addEventListener("keydown", (e) => {
				if (e.key === "Escape" && !panel.hidden) {
					setOpen(false);
					toggle.focus();
				}
			});

			statePromise.then((state) => fill(container, state, current));
			return container;
		},
	});

	new MenuControl().addTo(map);
}

function fill(container, state, current) {
	container.querySelector(".map-menu-user").textContent = state.display_name || state.username;

	container.querySelector(".map-menu-links").replaceChildren(
		...pagesFor(state)
			.filter((page) => page.id !== current)
			.map((page) => {
				const li = document.createElement("li");
				const link = document.createElement("a");
				link.href = page.href;
				link.textContent = page.es;
				li.append(link);
				return li;
			}),
	);

	const warning = state.cert && expiryWarning(state.cert.not_after);
	if (warning) {
		const p = container.querySelector(".map-menu-warning");
		p.textContent = `${warning} `;
		const link = Object.assign(document.createElement("a"), { href: "/files/account", textContent: "Renovar" });
		p.append(link);
		p.hidden = false;
		container.querySelector(".map-menu-badge").hidden = false;
	}
}
