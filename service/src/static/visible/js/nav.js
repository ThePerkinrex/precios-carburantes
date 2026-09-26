// The app's pages, shared by the index, the dashboard nav and the map menu.
// `es` labels are for the map, whose UI is in Spanish.

export const PAGES = [
	{ id: "map", href: "/files/map", label: "Map", es: "Mapa", hint: "Stations and prices near you" },
	{ id: "dashboard", href: "/files/dashboard", label: "Price trends", es: "Evolución de precios", hint: "Average prices over time, by region" },
	{ id: "account", href: "/files/account", label: "My devices", es: "Mis dispositivos", hint: "Renew or revoke your certificates" },
	{ id: "admin", href: "/files/admin", label: "Users", es: "Usuarios", hint: "Invite people and manage access", role: "admin_users" },
];

// The pages `state` (from getUserState) can open.
export function pagesFor(state) {
	return PAGES.filter((page) => !page.role || state.roles.includes(page.role));
}

// Fills `nav` with links to every page, marking `current`.
export function renderNav(nav, state, current) {
	nav.replaceChildren(
		...pagesFor(state).map((page) => {
			const link = document.createElement("a");
			link.href = page.href;
			link.textContent = page.label;
			if (page.id === current) link.setAttribute("aria-current", "page");
			return link;
		}),
	);
}
