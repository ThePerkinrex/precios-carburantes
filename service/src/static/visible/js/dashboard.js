let fuelChart;
let geoData = { ccaa: [], provincias: [] }; // Store data globally

document.addEventListener('DOMContentLoaded', async () => {
    await loadFilters();
    updateDashboard();

    document.getElementById('ccaaSelect').addEventListener('change', (e) => {
        const selectedCcaaId = e.target.value;
        
        // 1. Repopulate the province dropdown based on selection
        populateProvincias(selectedCcaaId);
        
        // 2. Refresh the chart
        updateDashboard();
    });

    document.getElementById('provinciaSelect').addEventListener('change', updateDashboard);
});

async function loadFilters() {
    try {
        const response = await fetch('/api/geo/filter');
        geoData = await response.json(); // Save the whole object
        
        const ccaaSelect = document.getElementById('ccaaSelect');
        
        // Populate CCAA dropdown
        geoData.ccaa.forEach(c => {
            ccaaSelect.add(new Option(c.name, c.id));
        });

        // Initialize empty provinces
        populateProvincias(""); 
    } catch (err) {
        console.error("Failed to load filters:", err);
    }
}

function populateProvincias(ccaaId) {
    const provSelect = document.getElementById('provinciaSelect');
    
    // Clear existing options except the first "All" option
    provSelect.innerHTML = '<option value="">All Provinces</option>';
    
    if (!ccaaId) {
        // Optional: show all provinces if no CCAA is selected, 
        // or keep it disabled until one is picked.
        geoData.provincias.forEach(p => {
            provSelect.add(new Option(p.name, p.id));
        });
        return;
    }

    // Filter provinces that match the selected CCAA ID
    const filtered = geoData.provincias.filter(p => p.ccaa === ccaaId);
    
    filtered.forEach(p => {
        provSelect.add(new Option(p.name, p.id));
    });
}

async function updateDashboard() {
    const ccaa = document.getElementById('ccaaSelect').value;
    const prov = document.getElementById('provinciaSelect').value;

    const param_object = {};
    if (ccaa) param_object.ccaa_id = ccaa;
    if (prov) param_object.prov_id = prov;
    
    const params = new URLSearchParams(param_object);
    
    try {
        const response = await fetch(`/api/prices/history?${params}`);
        const data = await response.json();
        renderChart(data);
    } catch (err) {
        console.error("Data fetch error:", err);
    }
}

function renderChart(data) {
    const ctx = document.getElementById('historyChart').getContext('2d');
    
    if (fuelChart) fuelChart.destroy();

    fuelChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: data.map(d => d.fecha),
            datasets: [
                {
                    label: 'Gasóleo A (€)',
                    data: data.map(d => d.gasoleo_a),
                    borderColor: '#3498db',
                    tension: 0.1
                },
                {
                    label: 'Gasolina 95 (€)',
                    data: data.map(d => d.gasolina_95),
                    borderColor: '#e67e22',
                    tension: 0.1
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'top' }
            }
        }
    });
}
