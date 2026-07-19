// js/offline-queue.js
// IndexedDB-kø for funn registrert uten nett (eller der synk mot bondoya-api
// feilet). Hvert element inneholder bildet som en Blob (aldri base64 i minnet
// lenger enn nødvendig) + resten av funn-metadataen.

const DB_NAME = 'bondoya';
const STORE = 'queue';

function openDb(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'localId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function queueAdd(entry){
  const db = await openDb();
  entry.localId = entry.localId || `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  entry.status = entry.status || 'venter'; // venter | synker | feilet
  // Lagres som ArrayBuffer, ikke som Blob-objekt — Safari/WebKit har en kjent
  // svakhet der en Blob hentet ut igjen fra IndexedDB (typisk etter at fanen
  // har ligget i bakgrunnen en stund) kan miste sin underliggende backing
  // store. En fetch() med en slik "død" Blob i FormData feiler da med et rent
  // klientsidig "Load failed" som ALDRI når serveren, uansett forbindelse
  // eller antall forsøk — se syncQueue() der den bygges opp igjen til en
  // fersk Blob rett før bruk. En ArrayBuffer har ingen slik avhengighet.
  if (entry.imageBlob) {
    entry.imageBlobBuffer = await entry.imageBlob.arrayBuffer();
    entry.imageBlobType = entry.imageBlob.type;
    delete entry.imageBlob;
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(entry);
    tx.oncomplete = () => resolve(entry.localId);
    tx.onerror = () => reject(tx.error);
  });
}

async function queueUpdate(localId, patch){
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const getReq = store.get(localId);
    getReq.onsuccess = () => {
      const existing = getReq.result;
      if (!existing) return resolve(null);
      store.put(Object.assign(existing, patch));
    };
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function queueRemove(localId){
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(localId);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function queueAll(){
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

// Prøver å synke alle køede funn til bondoya-api. For hvert element: kjør KI
// hvis art ikke allerede er valgt og en KI-proxy er konfigurert, opprett
// funnet (bilde + metadata i samme forespørsel, se ApiClient.opprettFunn),
// fjern fra køen. Stopper og lar resten stå i køen ved første feil (typisk
// fortsatt offline, eller ikke innlogget) i stedet for å kaste hele batchen.
async function syncQueue(onProgress){
  if (!navigator.onLine) return { synket: 0, gjenstår: (await queueAll()).length };
  const bruker = await window.ApiClient.meg().catch(() => null);
  if (!bruker) return { synket: 0, gjenstår: (await queueAll()).length };

  const items = await queueAll();
  let synket = 0;
  for (const item of items) {
    try {
      await queueUpdate(item.localId, { status: 'synker' });
      if (onProgress) onProgress(item, 'synker');

      let art = item.art;
      let kiKonfidens = item.kiKonfidens;
      let kiAlternativer = item.kiAlternativer;
      // item.imageBlob (fremfor imageBlobBuffer) dekker elementer som ble
      // lagt i køen FØR ArrayBuffer-omleggingen over — bygges likevel opp
      // som en fersk Blob her uansett kilde, aldri gjenbrukt direkte.
      const imageBlob = item.imageBlobBuffer
        ? new Blob([item.imageBlobBuffer], { type: item.imageBlobType })
        : (item.imageBlob || null);
      if (!art && imageBlob && window.KiClient) {
        // Egen try/catch her — en KI-feil (f.eks. Workeren midlertidig nede)
        // skal falle tilbake til "Ikke identifisert" under, ikke feile hele
        // synk-forsøket for dette funnet (se den ytre catch-blokken).
        try {
          const kiResultat = await window.KiClient.gjenkjenn(imageBlob);
          art = kiResultat.beste ? kiResultat.beste.art : null;
          kiKonfidens = kiResultat.beste ? kiResultat.beste.konfidens : 0;
          kiAlternativer = kiResultat.alternativer || [];
        } catch (e) {
          console.warn('KI-gjenkjenning feilet under synk', e);
        }
      }

      await window.ApiClient.opprettFunn({
        art: art || { norsk: 'Ikke identifisert', latinsk: '' },
        artstype: item.artstype || (art && art.artstype) || 'annet',
        lat: item.lat, lon: item.lon,
        tidspunkt: item.tidspunkt,
        imageBlob,
        kiKonfidens: kiKonfidens || 0,
        kiAlternativer: kiAlternativer || []
      });

      await queueRemove(item.localId);
      synket++;
      if (onProgress) onProgress(item, 'ferdig');
    } catch (e) {
      console.warn('Synk feilet for', item.localId, e);
      const feilmelding = String(e.message || e);
      await queueUpdate(item.localId, { status: 'feilet', feilmelding });
      // Fortsetter med resten av køen i stedet for å stoppe hele batchen her —
      // ett permanent ugyldig element (f.eks. en avvist verdi) skal ikke
      // blokkere andre, gyldige køede funn fra å synkes. Selve elementet
      // forblir i køen (status 'feilet') og prøves på nytt neste gang
      // trySync() kjører, jf. onProgress-varselet caller viser.
      if (onProgress) onProgress(item, 'feilet', feilmelding);
    }
  }
  const gjenstår = (await queueAll()).length;
  return { synket, gjenstår };
}

window.OfflineQueue = { queueAdd, queueUpdate, queueRemove, queueAll, syncQueue };
