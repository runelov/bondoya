// js/map.js
// Leaflet-kart begrenset til Bondøya, Liss-Bondøya og Risøya (Nærøysund).
//
// Koordinater geokodet via OpenStreetMap Nominatim 2026-07-11:
//   Bondøya:       64.8187 N, 10.7199 E  (relation 16613604)
//   Liss-Bondøya:  64.8172 N, 10.7064 E  (way 690316150, ~0.65 km fra Bondøya)
//   Risøya:        64.8201 N, 10.7027 E  (relation 16613603, ~0.83 km fra Bondøya)
// Samlet bounding box over alle tre øyene + litt margin. BEKREFT VISUELT at
// dette faktisk dekker riktig område — se konsept.md.

const ISLANDS_BOUNDS = L.latLngBounds(
  [64.8141154, 10.6983937],
  [64.8232203, 10.7338476]
);

const MAP_MAX_BOUNDS = L.latLngBounds(
  [64.8109, 10.6860],
  [64.8264, 10.7463]
);

function initMap(){
  const map = L.map('map', {
    zoomControl: false,
    maxBounds: MAP_MAX_BOUNDS,
    maxBoundsViscosity: 1.0
  });

  map.fitBounds(ISLANDS_BOUNDS, { padding: [20, 20] });
  map.setMinZoom(map.getBoundsZoom(MAP_MAX_BOUNDS));
  map.setMaxZoom(20);

  L.control.zoom({ position: 'bottomright' }).addTo(map);

  // Mapbox Satellite (krever access token — settes via setupPanel/localStorage,
  // se app.js). Kartverket topografisk som gratis, tokenfritt sekundærlag.
  const topo = L.tileLayer('https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/{z}/{y}/{x}.png', {
    maxZoom: 20,
    attribution: '&copy; Kartverket'
  });

  let satellite = null;
  const mapboxToken = localStorage.getItem('mittbondoya-mapbox-token');
  if (mapboxToken) {
    satellite = L.tileLayer(
      `https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/tiles/{z}/{x}/{y}?access_token=${mapboxToken}`,
      { maxZoom: 20, attribution: '&copy; Mapbox &copy; OpenStreetMap' }
    );
    satellite.addTo(map);
  } else {
    topo.addTo(map);
  }

  const baseLayers = { 'Kartverket (terreng)': topo };
  if (satellite) baseLayers['Mapbox (satellitt)'] = satellite;
  L.control.layers(baseLayers, {}, { position: 'topright' }).addTo(map);

  const findsLayer = L.layerGroup().addTo(map);

  let meMarker = null;
  function showMyPosition(){
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(pos => {
      const { latitude, longitude } = pos.coords;
      if (meMarker) map.removeLayer(meMarker);
      meMarker = L.circleMarker([latitude, longitude], {
        radius: 8, color: '#0a84ff', fillColor: '#0a84ff', fillOpacity: 0.9, weight: 3
      }).addTo(map).bindPopup('Du er her').openPopup();
      map.panTo([latitude, longitude]);
    }, err => {
      console.warn('Kunne ikke hente posisjon', err);
    }, { enableHighAccuracy: true, timeout: 10000 });
  }

  const locateBtn = L.control({ position: 'bottomright' });
  locateBtn.onAdd = () => {
    const div = L.DomUtil.create('div', 'leaflet-bar locateBtn');
    div.innerHTML = '📍';
    div.title = 'Min posisjon';
    div.onclick = (e) => { e.stopPropagation(); showMyPosition(); };
    return div;
  };
  locateBtn.addTo(map);

  return { map, findsLayer, showMyPosition };
}

const ARTSTYPE_COLORS = {
  fugl: '#0a84ff',
  sjøpattedyr: '#8e8e93',
  alge: '#34c759',
  blomst: '#ff9500',
  annet: '#af52de'
};

function renderFinds(findsLayer, funn, activeFilter){
  findsLayer.clearLayers();
  funn
    .filter(f => !activeFilter || activeFilter === 'alle' || f.artstype === activeFilter)
    .forEach(f => {
      const color = ARTSTYPE_COLORS[f.artstype] || ARTSTYPE_COLORS.annet;
      const marker = L.circleMarker([f.lat, f.lon], {
        radius: 9, color, fillColor: color, fillOpacity: 0.85, weight: 2
      });
      marker.bindPopup(
        `<strong>${escapeHtml(f.art?.norsk || 'Ukjent art')}</strong><br>` +
        `<em>${escapeHtml(f.art?.latinsk || '')}</em><br>` +
        new Date(f.tidspunkt).toLocaleDateString('no-NO')
      );
      marker.on('click', () => window.dispatchEvent(new CustomEvent('funn:selected', { detail: f })));
      marker.addTo(findsLayer);
    });
}

function panToFind(map, f){
  map.setView([f.lat, f.lon], Math.max(map.getZoom(), 17));
}

function escapeHtml(str){
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}
