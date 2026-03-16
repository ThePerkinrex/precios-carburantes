export function addVisibleStationsControl(map, clusterGroup, allMarkers) {
    const VisibleStationsControl = L.Control.extend({
        options: { position: 'topright' }, 

        onAdd: function (map) {
            // Create the main container with Leaflet classes for standard styling
            const container = L.DomUtil.create('div', 'leaflet-control leaflet-bar leaflet-control-layers custom-stations-list');
            

            // Prevent map clicks and scrolling from passing through the control
            L.DomEvent.disableClickPropagation(container);
            L.DomEvent.disableScrollPropagation(container);

            // Create a header/toggle button
            const header = L.DomUtil.create('div', 'stations-header', container);
            header.innerHTML = '⛽€';
            

            // Create a wrapper for the toggles and the list so they hide/show together
            const contentWrapper = L.DomUtil.create('div', 'content-wrapper', container);
            contentWrapper.style.display = 'none';
            contentWrapper.style.marginTop = '10px';

			const contentHeader = L.DomUtil.create('div', 'content-header', contentWrapper);
            contentHeader.innerText = 'Precios de las gasolineras visbles.'

            // Add sorting toggles (Radio Buttons)
            const sortControls = L.DomUtil.create('div', 'sort-controls', contentWrapper);
            sortControls.style.marginBottom = '10px';
            sortControls.style.paddingBottom = '8px';
            sortControls.style.borderBottom = '1px solid #eee';
            sortControls.innerHTML = `
				<i>Precios ordenados por:</i><br>
                <label style="margin-right: 10px; cursor: pointer; font-size: 12px;">
                    <input type="radio" name="sortPrice" value="gasolina_95" checked> Gasolina 95
                </label>
                <label style="cursor: pointer; font-size: 12px;">
                    <input type="radio" name="sortPrice" value="gasoleo_a"> Gasóleo A
                </label>
            `;

            // Default sorting state
            this._currentSort = 'gasolina_95';

            // Create the container for the list items
            const list = L.DomUtil.create('div', 'stations-items', contentWrapper);
            list.style.fontSize = '12px';

            // Handle radio button changes
            const radios = sortControls.querySelectorAll('input[name="sortPrice"]');
            radios.forEach(radio => {
                L.DomEvent.on(radio, 'change', (e) => {
                    this._currentSort = e.target.value; // Update the state
                    this._updateList(map, list);        // Re-render the list immediately
                });
            });

			const show = () => {
				contentWrapper.style.display = 'block'; 
				header.style.display = 'none';
                this._updateList(map, list); 
			}

			const hide = () => {
				contentWrapper.style.display = 'none'; 
				header.style.display = 'block';
			}

            // Handle hover for desktop
            L.DomEvent.on(container, 'mouseenter', show);
            L.DomEvent.on(container, 'mouseleave', hide);

            // Handle click/touch toggle for mobile
            L.DomEvent.on(header, 'click', () => {
                show();
            });

			map.on('click', hide);

            // Update list dynamically if map is panned/zoomed while list is open
            map.on('moveend', () => {
                if (contentWrapper.style.display === 'block') {
                    this._updateList(map, list);
                }
            });

            return container;
        },

        _updateList: function(map, listContainer) {
            listContainer.innerHTML = '';
            const bounds = map.getBounds();

            // Filter markers to only those that are inside the map view AND currently active in layers
            let visibleMarkers = allMarkers.filter(m => {
                if (!clusterGroup.hasLayer(m)) return false;
                return bounds.contains(m.getLatLng());
            });

            // Dynamically sort based on the selected toggle state
            visibleMarkers.sort((a, b) => {
                // If a station doesn't have the selected fuel type, treat its price as 999 to push it to the bottom
                let priceA = a.eess[this._currentSort] || 999;
                let priceB = b.eess[this._currentSort] || 999;
                return priceA - priceB;
            });

            if (visibleMarkers.length === 0) {
                listContainer.innerHTML = '<i>No hay gasolineras visibles</i>';
                return;
            }

            // Render the items
            visibleMarkers.forEach(m => {
                const item = L.DomUtil.create('div', 'station-item', listContainer);
                item.style.padding = '6px 0';
                item.style.borderBottom = '1px solid #eee';
                item.style.cursor = 'pointer';

                let pricesHtml = '';
                // Highlight the currently sorted price visually
                let g95Style = this._currentSort === 'gasolina_95' ? 'font-weight:bold; color:green;' : 'color:#555;';
                let gasAStyle = this._currentSort === 'gasoleo_a' ? 'font-weight:bold; color:#000;' : 'color:#555;';

                if (m.eess.gasolina_95) pricesHtml += `<span style="${g95Style} margin-right:5px;">G95: ${m.eess.gasolina_95}€</span>`;
                if (m.eess.gasoleo_a) pricesHtml += `<span style="${gasAStyle}">GasA: ${m.eess.gasoleo_a}€</span>`;

                item.innerHTML = `<strong>${m.eess.rotulo}</strong><br>${pricesHtml}`;

                item.onmouseenter = () => item.style.backgroundColor = '#f4f4f4';
                item.onmouseleave = () => item.style.backgroundColor = 'transparent';

                // Handle click: Zoom to cluster if necessary, then open popup
                L.DomEvent.on(item, 'click', () => {
                    clusterGroup.zoomToShowLayer(m, () => {
                        m.openPopup();
                    });
                });
            });
        }
    });

    new VisibleStationsControl().addTo(map);
}