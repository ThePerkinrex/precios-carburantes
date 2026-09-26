import { getUserState } from "./api.js";
import { renderNav } from "./nav.js";
import { formatDate, formatDateTime } from "./dates.js";
import { getPriceHistory, renderBoard } from "./price_board.js";

const ccaaSelect = document.getElementById("ccaaSelect");
const provSelect = document.getElementById("provinciaSelect");
const board = document.getElementById("board");

let fuelChart;
let geoData = { ccaa: [], provincias: [] };
// Only the latest request gets to draw, so fast filter changes can't race.
let requestId = 0;

// Same colours as the board's nozzle chips (see app.css).
const style = getComputedStyle(document.documentElement);
const G95 = style.getPropertyValue("--g95").trim();
const DIESEL = style.getPropertyValue("--diesel").trim();
Chart.defaults.font.family = style.getPropertyValue("--font").trim();
Chart.defaults.color = style.getPropertyValue("--muted").trim();

async function loadFilters() {
	try {
		const response = await fetch("/api/geo/filter");
		geoData = await response.json();
		for (const c of geoData.ccaa) ccaaSelect.add(new Option(c.name, c.id));
		populateProvincias("");
	} catch (err) {
		console.error("Failed to load filters:", err);
	}
}

// All provinces, or only those of the selected region.
function populateProvincias(ccaaId) {
	provSelect.replaceChildren(new Option("All provinces", ""));
	for (const p of geoData.provincias) {
		if (!ccaaId || p.ccaa === ccaaId) provSelect.add(new Option(p.name, p.id));
	}
}

function selectedName(select, fallback) {
	return select.value ? select.selectedOptions[0].text : fallback;
}

async function updateDashboard() {
	const id = ++requestId;
	const where = provSelect.value
		? selectedName(provSelect)
		: selectedName(ccaaSelect, "Spain");
	try {
		const history = await getPriceHistory({ ccaa: ccaaSelect.value, provincia: provSelect.value });
		if (id !== requestId) return;
		renderBoard(board, history, where);
		renderChart(history);
	} catch (err) {
		if (id !== requestId) return;
		board.innerHTML = `<p class="board-empty"></p>`;
		board.firstChild.textContent = err.message;
	}
}

function renderChart(history) {
	if (fuelChart) fuelChart.destroy();

	const line = (label, key, color) => ({
		label,
		data: history.map((d) => d[key]),
		borderColor: color,
		backgroundColor: color,
		borderWidth: 2,
		pointRadius: 0,
		pointHitRadius: 12,
		tension: 0.2,
	});

	fuelChart = new Chart(document.getElementById("historyChart"), {
		type: "line",
		data: {
			labels: history.map((d) => formatDate(d.date)),
			datasets: [line("Gasolina 95", "gasolina_95", G95), line("Gasóleo A", "gasoleo_a", DIESEL)],
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			interaction: { mode: "index", intersect: false },
			plugins: {
				legend: { position: "top", align: "start", labels: { usePointStyle: true, pointStyle: "rectRounded", boxHeight: 10 } },
				tooltip: {
					callbacks: {
						title: (items) => formatDateTime(history[items[0].dataIndex].date),
						label: (item) => `${item.dataset.label}: ${item.parsed.y.toFixed(3)} €/L`,
					},
				},
			},
			scales: {
				x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 16 } },
				y: { ticks: { callback: (v) => `${v.toFixed(2)} €` } },
			},
		},
	});
}

ccaaSelect.addEventListener("change", () => {
	populateProvincias(ccaaSelect.value);
	updateDashboard();
});
provSelect.addEventListener("change", updateDashboard);

getUserState().then((state) => renderNav(document.getElementById("nav"), state, "dashboard"));
await loadFilters();
updateDashboard();
