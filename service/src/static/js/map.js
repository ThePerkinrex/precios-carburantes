async function load() {
	let data = fetch('/api/prices').then(x => x.json())

	let map = L.map('map').setView([40.4165, -3.70256], 11);

	L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
		maxZoom: 19,
		attribution: '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>'
	}).addTo(map);

	data = await data;
	console.log(data);
	let i = 0;
	for(let eess of data) {
		let popup = L.popup()
			.setLatLng([eess.latitud, eess.longitud])
			.setContent(`${eess.rotulo}: G95 ${eess.gasolina_95} €/L; GA ${eess.gasoleo_a} €/L`)
			.openOn(map);
		i++;
		
	}
}

load();
