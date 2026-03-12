import { getStatus, formatOpenCloseDate } from "./schedules.js";

async function load() {
	let data = fetch("/api/prices").then((x) => x.json());
	let logos = fetch("/files/data/logos.json").then((x) => x.json());

	const map = L.map("map").setView([40.4165, -3.70256], 11);

	L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
		maxZoom: 19,
		attribution:
			'&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>',
	}).addTo(map);

	// Capa para agrupar los marcadores
	const markers = L.markerClusterGroup();
	map.addLayer(markers);

	data = await data;
	logos = await logos;
	// console.log(data);
	const logos_sorted = Object.keys(logos).sort((a, b) => b.length - a.length);
	let i = 0;
	for (let eess of data) {
		let logo = `<div class="logo"><b>${eess.rotulo}</b></div>`;
		const lower_eess = eess.rotulo.toLowerCase();
		for (let name of logos_sorted) {
			if (lower_eess.includes(name)) {
				logo = `<img class="logo" src="${logos[name]}"/>`;
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

		markers.addLayer(marker);
	}
}

load();
