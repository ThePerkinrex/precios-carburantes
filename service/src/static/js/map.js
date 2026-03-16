import { getStatus, formatOpenCloseDate } from "./schedules.js";
import { addVisibleStationsControl } from "./visible_stations.js"

function onLocationFound(map, e) {
	const radius = e.accuracy;

	L.marker(e.latlng).addTo(map);

	L.circle(e.latlng, radius).addTo(map);
	console.log("Got location");
}

function onLocationError(e) {
	console.error(e.message);
}

function addSelectAllButtons(layerControl, overlays, map) {
	// Get the container where Leaflet lists the overlays
	const container = layerControl.getContainer();
	const form = container.querySelector("section.leaflet-control-layers-list");

	// Create a wrapper for our new buttons
	const buttonWrapper = document.createElement("div");
	buttonWrapper.innerHTML = `
		<button class="selectAll">All</button>
		<button class="unselectAll">None</button>
	`;
	form.prepend(buttonWrapper); // Put them at the top of the list

	// Add event listeners
	buttonWrapper.querySelector(".selectAll").onclick = () => {
		for (let overlay of overlays) map.addLayer(overlay);
	};

	buttonWrapper.querySelector(".unselectAll").onclick = () => {
		for (let overlay of overlays) {
			if (map.hasLayer(overlay)) map.removeLayer(overlay);
		}
	};
}

async function load() {
	let data = fetch("/api/prices").then((x) => x.json());
	let logos = fetch("/files/data/logos.json").then((x) => x.json());

	const map = L.map("map").setView([40.4165, -3.70256], 11);

	L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
		maxZoom: 19,
		attribution:
			'&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>',
	}).addTo(map);

	map.on("locationfound", (x) => {
		map.off("locationfound");
		onLocationFound(map, x);
		map.locate({ watch: true, maximumAge: 5000 });
		map.on("locationfound", (x) => {
			console.log('watching location');
			onLocationFound(map, x);
		});
	});

	map.on("locationerror", onLocationError);
	map.locate({ setView: true, maxZoom: 12, maximumAge: 5000 });
	//map.locate({watch: true});

	// Capa para agrupar los marcadores
	const markers = L.markerClusterGroup(),
		control = L.control.layers(null, null, { collapsed: true });
	map.addLayer(markers);

	data = await data;
	logos = await logos;

	let subgroups = Object.fromEntries(Object.keys(logos).map((k) => [k, []]));
	subgroups["other"] = [];
	// console.log(data);
	const logos_sorted = Object.keys(logos).sort((a, b) => b.length - a.length);
	let i = 0;
	const allMarkers = []; // Array to keep track of all markers
	for (let eess of data) {
		let logo = `<div class="logo"><b>${eess.rotulo}</b></div>`;
		let subgroup = subgroups["other"];
		const lower_eess = eess.rotulo.toLowerCase();
		for (let name of logos_sorted) {
			if (
				lower_eess.includes(name) ||
				("alternatives" in logos[name] &&
					logos[name].alternatives.some((x) =>
						lower_eess.includes(x),
					))
			) {
				logo = `<img class="logo" src="${logos[name].image}"/>`;
				subgroup = subgroups[name];
				break;
			}
		}
		// i++;
		// if(i > 10) break;

		let gasolina_short =
			eess.gasolina_95 != null
				? `<div class="gasolina">${eess.gasolina_95}€</div>`
				: "";
		let gasolina_long =
			eess.gasolina_95 != null
				? `<div class="gasolina">Gasolina 95: <b>${eess.gasolina_95}€</b></div>`
				: "";
		let gasoleo_short =
			eess.gasoleo_a != null
				? `<div class="gasoleo">${eess.gasoleo_a}€</div>`
				: "";
		let gasoleo_long =
			eess.gasoleo_a != null
				? `<div class="gasoleo">Gasoleo A: <b>${eess.gasoleo_a}€</b></div>`
				: "";

		// // console.log(eess);
		// Crear un icono que muestre el precio directamente
		const icon = L.divIcon({
			className: "custom-div-icon",
			html: `	<div class="price-label icon">
						${logo}
						${gasoleo_short}
						${gasolina_short}
					</div>`,
			//iconSize: [60, 40]
		});

		let status = getStatus(eess.horario, new Date());

		let pill = "";
		if (status.status == "open") {
			pill = `<div class="pill open">Abierto; Cierre ${formatOpenCloseDate(status.nextClose)}</div>`;
		} else if (status.status == "opensSoon") {
			pill = `<div class="pill open soon">Abre pronto; Apertura ${formatOpenCloseDate(status.nextOpen)}</div>`;
		} else if (status.status == "close") {
			pill = `<div class="pill close">Cerrado; Apertura ${formatOpenCloseDate(status.nextOpen)}</div>`;
		} else if (status.status == "closesSoon") {
			pill = `<div class="pill close soon">Cierra pronto; Cierre ${formatOpenCloseDate(status.nextClose)}</div>`;
		}

		const marker = L.marker([eess.latitud, eess.longitud], {
			icon: icon,
		}).bindPopup(() => {
			return `
			<div class="gasolinera" id="gasolinera-${eess.id}">
				<div class="rotulo"><b>${eess.rotulo}</b></div>
				<div class="direccion">
					${eess.direccion}, margen ${eess.margen}<br>
					${eess.localidad}, ${eess.municipio} ${eess.cp}<br>
					<i>${eess.provincia}</i><br>
					Horario: ${eess.horario}<br>
					${pill}
				</div>

				<div class="price-label">
					
					${gasoleo_long}
					${gasolina_long}
				</div>
				<canvas class="chart"></canvas>
			</div>`;
		});
		marker.on("popupopen", async (ev) => {
			const from = new Date(new Date().setDate(new Date().getDate() - 7));
			const history = await fetch(
				`/api/${eess.id}/history?` +
					new URLSearchParams({
						from: from.toISOString(),
					}).toString(),
			).then((x) => x.json());
			const popup = document.getElementById(`gasolinera-${eess.id}`);
			const chart = popup.getElementsByClassName("chart")[0];

			// console.log(history, popup, chart);
			new Chart(chart, {
				type: "line",
				data: {
					labels: history.map((x) => x.fecha),
					datasets: [
						{
							label: "Gasolina 95",
							data: history.map((x) => x.gasolina_95),
							fill: false,
							borderColor: "green",
							tension: 0.1,
						},
						{
							label: "Gasoleo A",
							data: history.map((x) => x.gasoleo_a),
							fill: false,
							borderColor: "black",
							tension: 0.1,
						},
					],
				},
			});
		});

		// ADD THESE TWO LINES:
		marker.eess = eess; // Store the raw data for sorting and displaying
		allMarkers.push(marker);

		// markers.addLayer(marker);
		subgroup.push(marker);
	}
	subgroups = Object.entries(subgroups)
		.map(([name, layers]) => [
			name,
			L.featureGroup.subGroup(markers, layers),
			layers.length,
		])
		.toSorted(([name1, stations1, len1], [name2, stations2, len2]) =>
			name1 == "other" ? 1 : name2 == "other" ? -1 : len2 - len1,
		);
	console.log(subgroups);
	for (let [name, subgroup] of subgroups) {
		control.addOverlay(
			subgroup,
			name == "other" ? "Otras" : logos[name].text,
		);
		subgroup.addTo(map);
	}
	control.addTo(map);
	addSelectAllButtons(
		control,
		subgroups.map((x) => x[1]),
		map,
	);

	addVisibleStationsControl(map, markers, allMarkers);
}

load();
