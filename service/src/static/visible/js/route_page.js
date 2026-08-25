async function load() {
	const url = new URL(location.href);
	const path = url.pathname.split("/");
	// /route/hash/id
	const hash = path[2];
	const route_idx = parseInt(path[3]);

	if(hash === null || route_idx == null) {
		location.assign("/files/map");
	}


	const map = document.getElementById("map");

	map.innerText = `hash: ${hash}; idx: ${route_idx}`
}

load();