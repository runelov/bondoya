// js/map.js
// Leaflet-kart begrenset til Bondøya, Liss-Bondøya og Risøya (Nærøysund).
//
// Koordinater geokodet via OpenStreetMap Nominatim 2026-07-11:
//   Bondøya:       64.8187 N, 10.7199 E  (relation 16613604)
//   Liss-Bondøya:  64.8172 N, 10.7064 E  (way 690316150, ~0.65 km fra Bondøya)
//   Risøya:        64.8201 N, 10.7027 E  (relation 16613603, ~0.83 km fra Bondøya)
// Samlet bounding box over alle tre øyene + litt margin. BEKREFT VISUELT at
// dette faktisk dekker riktig område — se konsept.md.

// Bondøya alene — brukes for startvisningen, slik at selve øya fyller
// skjermen i stedet for å drukne i omkringliggende hav/øyer.
const BONDOYA_BOUNDS = L.latLngBounds(
  [64.8141154, 10.7089637],
  [64.8232203, 10.7338476]
);

// Bondøya + Liss-Bondøya + Risøya samlet — brukes kun som ytre panorerings-
// og zoomgrense (maxBounds), ikke som startvisning. Naboøyene er dermed
// fortsatt nåbare ved å panorere, uten å dominere bildet ved oppstart.
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

  map.fitBounds(BONDOYA_BOUNDS, { padding: [20, 20] });
  map.setMinZoom(map.getBoundsZoom(MAP_MAX_BOUNDS));
  map.setMaxZoom(20);

  L.control.zoom({ position: 'bottomright' }).addTo(map);

  // Kartverket topografisk: gratis, tokenfritt — eneste lag offentlige
  // (uinnloggede) besøkende får se, jf. konsept.md "Offentlig lag".
  const topo = L.tileLayer('https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/{z}/{y}/{x}.png', {
    maxZoom: 20,
    attribution: '&copy; Kartverket'
  });
  topo.addTo(map);

  // Mapbox-satellitt hentes via bondoya-api sin sesjonsbeskyttede flis-proxy
  // (se worker/api/src/routes/tiles.js) — aldri direkte mot Mapbox med et
  // klient-synlig token. Laget bygges alltid, men legges kun i
  // layer-switcheren når settInnloggingsstatus(true) er kalt.
  const satellite = L.tileLayer(window.ApiClient.flisUrlMal(), {
    maxZoom: 20,
    attribution: '&copy; Mapbox &copy; OpenStreetMap'
  });

  const baseLayers = { 'Kartverket (terreng)': topo };
  // bottomleft: Leaflets standard topright/bottomright kolliderer med appens
  // egne ⚙️/📋-knapper (topBar) og GPS/zoom-knappene — bottomleft er ledig.
  // Ikke lagt til kartet her — offentlige besøkende har uansett kun ett
  // kartlag (Kartverket), så en lagvelger med ett valg er bare støy for dem.
  // Legges til/fjernes i settInnloggingsstatus i stedet, sammen med
  // satellittlaget.
  const layersControl = L.control.layers(baseLayers, {}, { position: 'bottomleft' });

  let satelliteLagtTil = false;
  let layersControlLagtTil = false;
  function settInnloggingsstatus(innlogget){
    if (innlogget && !layersControlLagtTil) {
      layersControl.addTo(map);
      layersControlLagtTil = true;
    } else if (!innlogget && layersControlLagtTil) {
      layersControl.remove();
      layersControlLagtTil = false;
    }
    if (innlogget && !satelliteLagtTil) {
      layersControl.addBaseLayer(satellite, 'Mapbox (satellitt)');
      satelliteLagtTil = true;
    } else if (!innlogget && satelliteLagtTil) {
      map.removeLayer(satellite);
      layersControl.removeLayer(satellite);
      satelliteLagtTil = false;
      topo.addTo(map);
    }
  }

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

  return { map, findsLayer, showMyPosition, settInnloggingsstatus };
}

const ARTSTYPE_COLORS = {
  fugl: '#0a84ff',
  sjøpattedyr: '#8e8e93',
  pattedyr: '#5e5ce6',
  alge: '#34c759',
  plante: '#ff9500',
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
