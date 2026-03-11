async function load() {
	let data = fetch('/api/prices').then(x => x.json())
	let logos = fetch('/files/data/logos.json').then(x => x.json())

	const map = L.map('map').setView([40.4165, -3.70256], 11);

	L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
		maxZoom: 19,
		attribution: '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>'
	}).addTo(map);

	// Capa para agrupar los marcadores
	const markers = L.markerClusterGroup();
	map.addLayer(markers);

	data = await data;
	logos = await logos;
	console.log(data);
	const logos_sorted = Object.keys(logos).sort((a, b) => b.length - a.length)
	let i = 0;
	for(let eess of data) {
		let logo = `<div class="logo"><b>${eess.rotulo}</b></div>`;
		const lower_eess = eess.rotulo.toLowerCase();
		for (let name in logos) {
			if (lower_eess.includes(name)) {
				logo = `<img class="logo" src="${logos[name]}"/>`
				break;
			}
		}
		// i++;
		// if(i > 10) break;

		// console.log(eess);
		// Crear un icono que muestre el precio directamente
		const icon = L.divIcon({
			className: 'custom-div-icon',
			html: `	<div class="price-label">
						${logo}
						<div class="gasoleo">${eess.gasoleo_a}€</div>
						<div class="gasolina">${eess.gasolina_95}€</div>
					</div>`,
			//iconSize: [60, 40]
		});

		 

		const marker = L.marker([eess.latitud, eess.longitud], { icon: icon })
			.bindPopup(`
				<div class="rotulo"><b>${eess.rotulo}</b></div>
				<div class="direccion">${eess.direccion}<br>${eess.municipio}<br><i>${eess.provincia}</i></div>
				

				<div class="gasoleo">Gasoleo A: ${eess.gasoleo_a}€</div>
				<div class="gasolina">Gasolina 95: ${eess.gasolina_95}€</div>`);
		
		markers.addLayer(marker);

	}
}

load();
