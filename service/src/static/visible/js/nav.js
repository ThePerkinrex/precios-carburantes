// The app's pages, shared by the index, the other pages' nav and the map menu.

import { t } from "./i18n.js";

export const PAGES = [
	{ id: "map", href: "/files/map", label: t("Map"), hint: t("Stations and prices near you") },
	{ id: "trips", href: "/files/trips", label: t("My trips"), hint: t("Saved routes and their fuel stops") },
	{ id: "dashboard", href: "/files/dashboard", label: t("Price trends"), hint: t("Average prices over time, by region") },
	{ id: "account", href: "/files/account", label: t("My devices"), hint: t("Renew or revoke your certificates") },
	{ id: "admin", href: "/files/admin", label: t("Users"), hint: t("Invite people and manage access"), role: "admin_users" },
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
