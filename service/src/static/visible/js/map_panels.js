// The map's dropdowns and sheets (menu, brands, station list, route
// search) are open one at a time, so they never overlap each other or a
// station's popup.

// Registers a panel under `id`; `close` is called whenever another panel
// opens. Call the returned `opened()` when this one opens, and `dispose()`
// when the panel is removed from the map.
export function onlyOneOpen(map, id, close) {
	const onOpen = (e) => {
		if (e.id !== id) close();
	};
	map.on("mappanelopen", onOpen);
	return {
		opened: () => {
			map.closePopup();
			map.fire("mappanelopen", { id });
		},
		dispose: () => map.off("mappanelopen", onOpen),
	};
}

// Things fixed to the bottom of the screen that a dropdown must end above.
const BOTTOM_OBSTACLES = ".route-fab, .trip-alternatives-panel";

// Caps an open dropdown's height so it ends above the bottom of the screen
// and anything fixed there, scrolling inside instead.
export function fitToScreen(panel) {
	panel.style.maxHeight = "";
	const { top, left, right } = panel.getBoundingClientRect();
	let bottom = window.innerHeight;
	for (const el of document.querySelectorAll(BOTTOM_OBSTACLES)) {
		const rect = el.getBoundingClientRect();
		// Only what is below the panel: the desktop plans card is on the
		// other side of the screen from the left-hand panels.
		const below = rect.left < right && rect.right > left;
		if (rect.height > 0 && rect.top > top && below) bottom = Math.min(bottom, rect.top);
	}
	panel.style.maxHeight = `${Math.max(160, bottom - top - 12)}px`;
}
