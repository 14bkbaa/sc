/* Carsharing tervező – index.html-hez
   - MOL Limo autók betöltése (mollimo.hu data/cars.js)
   - MOL Limo zóna (mollimo.hu data/homezones.js)
   - Hot zone (300–400 m kör) autókhoz, térképre kattintva
   - Útvonaltervezés: gyalog (OSRM foot) + autó (OSRM driving)
   - Kezdés: hozzád (GPS) legközelebbi autó
   - Frissítés: megőrzi a zónákat/állapotot, eltűnt autóknál töröl
   - Tervezéskor csak érintett elemek látszanak
   - Autólista: pipálható kijelölés, ugrás, elrejtés, zónatörlés
   - Cluster-spiderfy megszüntetése kijelöléskor + "széthúzás" közeli autóknál
   - Opcionális: BKV (GTFS) – csak akkor aktív, ha van gtfs/graph.json

   Megjegyzés: Ez egy "egy fájlos" GitHub Pages barát app. Ha mollimo.hu
   CORS/anti-bot miatt nem engedi a betöltést, a térkép akkor is működik,
   csak autók nélkül.
*/
(() => {
  'use strict';

  // ----------------------- Config -----------------------
  const CFG = {
    // MOL Limo publikus adatfájlok (a query param cserélhető, ha lejár)
    LIMO_CARS_URLS: [
      'https://mollimo.hu/data/cars.js?u7XOvp6hNn',
      'https://mollimo.hu/data/cars.js',
    ],
    LIMO_ZONES_URLS: [
      'https://mollimo.hu/data/homezones.js?UtaHbFc6QF',
      'https://mollimo.hu/data/homezones.js',
    ],

    // OSRM
    OSRM_FOOT: [
      'https://router.project-osrm.org',
      'https://routing.openstreetmap.de',
    ],
    OSRM_CAR: [
      'https://router.project-osrm.org',
      'https://routing.openstreetmap.de',
    ],

    // Hot zone sugár (m)
    HOTZONE_RADIUS_M: 360,
    HOTZONE_RADIUS_MIN: 300,
    HOTZONE_RADIUS_MAX: 400,

    // Gyalog: mennyi stop-ig engedjük el (BKV módnál)
    TRANSIT_MAX_WALK_TO_STOP_M: 900,

    // Kijelöléskor szétfeszítés (ha túl közel vannak)
    SPREAD_DISTANCE_M: 30,
    SPREAD_RING_M: 22,

    // Debounce
    AUTOPLAN_DEBOUNCE_MS: 700,
    REFRESH_COOLDOWN_MS: 1200,

    // Map defaults (Budapest)
    DEFAULT_CENTER: [47.4979, 19.0402],
    DEFAULT_ZOOM: 12,

    // Storage key
    STORAGE_KEY: 'streetcrowd_planner_v4',
  };

  // ----------------------- DOM helpers -----------------------
  const $ = (id) => document.getElementById(id);

  function showStatus(title, text, ms = 2400) {
    const bar = $('statusbar');
    $('statusTitle').textContent = title || '—';
    $('statusText').textContent = text || '—';
    bar.classList.add('show');
    if (ms > 0) {
      clearTimeout(showStatus._t);
      showStatus._t = setTimeout(() => bar.classList.remove('show'), ms);
    }
  }

  function setSubline(text) { $('subLine').textContent = text; }

  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function fmtKm(m) { return (m/1000).toFixed(m >= 10000 ? 0 : 2) + ' km'; }
  function fmtMin(s) {
    const min = Math.max(0, Math.round(s/60));
    if (min < 60) return `${min} perc`;
    const h = Math.floor(min/60);
    const m = min % 60;
    return `${h} ó ${m} p`;
  }

  // ----------------------- Storage -----------------------
  function loadState() {
    try {
      const raw = localStorage.getItem(CFG.STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch { return null; }
  }
  function saveState() {
    const st = {
      hidden: Array.from(state.hiddenCars),
      selected: Array.from(state.selectedCars),
      zonesByCar: state.zonesByCar,
      hotRadius: state.hotRadius,
      ui: {
        zonesOn: state.zonesOn,
        bkvOn: state.bkvOn
      }
    };
    localStorage.setItem(CFG.STORAGE_KEY, JSON.stringify(st));
  }

  // ----------------------- Global state -----------------------
  const state = {
    map: null,

    // layers
    tiles: null,
    carsCluster: null,
    carsSelectedLayer: null,
    carsAllMarkers: new Map(),     // carId -> marker
    carsSelectedMarkers: new Map(),// carId -> marker
    zoneLayer: null,
    hotZoneLayer: null,
    routeLayer: null,
    labelLayer: null,

    // data
    cars: [],               // normalized cars
    carsById: new Map(),    // id -> car
    limoZones: null,        // L.GeoJSON or group
    limoZonesLoaded: false,

    // user
    me: null,               // {lat,lng,acc,ts}
    meMarker: null,
    meCircle: null,

    // selections
    activeCarId: null,      // for hotzone add mode
    selectedCars: new Set(),
    hiddenCars: new Set(),
    zonesByCar: {},         // carId -> [{lat,lng,idx,labelId}, ...]
    hotRadius: CFG.HOTZONE_RADIUS_M,

    // mode flags
    zonesOn: false,
    bkvOn: false,
    planActive: false,
    plan: null,

    // refresh throttling
    _lastRefresh: 0,

    // caches
    osrmCache: new Map(),   // key -> result
    elevationCache: new Map(),
  };

  // ----------------------- Init map -----------------------
  function initMap() {
    const map = L.map('map', {
      zoomControl: true,
      preferCanvas: true
    }).setView(CFG.DEFAULT_CENTER, CFG.DEFAULT_ZOOM);

    state.tiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
      crossOrigin: true,
    }).addTo(map);

    state.carsCluster = L.markerClusterGroup({
      showCoverageOnHover: false,
      spiderfyOnMaxZoom: true,
      maxClusterRadius: 50,
      disableClusteringAtZoom: 18,
    }).addTo(map);

    state.carsSelectedLayer = L.layerGroup().addTo(map);
    state.zoneLayer = L.layerGroup().addTo(map);
    state.hotZoneLayer = L.layerGroup().addTo(map);
    state.routeLayer = L.layerGroup().addTo(map);
    state.labelLayer = L.layerGroup().addTo(map);

    state.map = map;

    map.on('click', onMapClick);

    // Better touch handling
    map.on('popupopen', () => map.closePopup()); // we don't use popups

    // Try get GPS immediately (auto)
    startGps();

    // UI hooks
    $('btnRefresh').addEventListener('click', refreshCars);
    $('btnCars').addEventListener('click', () => toggleDrawer(true));
    $('btnCloseDrawer').addEventListener('click', () => toggleDrawer(false));
    $('btnMe').addEventListener('click', centerOnMe);
    $('btnPlan').addEventListener('click', () => planNow(true));
    $('btnReplan').addEventListener('click', () => planNow(true));
    $('btnClearPlan').addEventListener('click', clearPlanView);
    $('btnShowAll').addEventListener('click', showAllCars);

    $('toggleZones').addEventListener('click', () => setZonesOn(!state.zonesOn));
    $('toggleBkv').addEventListener('click', () => setBkvOn(!state.bkvOn));

    $('carSearch').addEventListener('input', renderCarList);

    // Load previous state
    const st = loadState();
    if (st) {
      state.hiddenCars = new Set(st.hidden || []);
      state.selectedCars = new Set(st.selected || []);
      state.zonesByCar = st.zonesByCar || {};
      state.hotRadius = clampNumber(st.hotRadius ?? CFG.HOTZONE_RADIUS_M, CFG.HOTZONE_RADIUS_MIN, CFG.HOTZONE_RADIUS_MAX);
      state.zonesOn = !!(st.ui && st.ui.zonesOn);
      state.bkvOn = !!(st.ui && st.ui.bkvOn);
    }

    setZonesOn(state.zonesOn, true);
    setBkvOn(state.bkvOn, true);

    // initial load
    refreshCars(true);
    loadLimoZones(); // async, but can fail gracefully

    // GTFS init (optional)
    if (window.GTFS && typeof window.GTFS.init === 'function') {
      window.GTFS.init().then((ok) => {
        if (!ok) {
          showStatus('BKV: KI', 'GTFS graph.json hiányzik – a BKV mód csak akkor működik, ha előkészíted a GTFS hálót.', 6000);
        }
      }).catch(() => {});
    }
  }

  function clampNumber(v, a, b) { return Math.max(a, Math.min(b, v)); }

  // ----------------------- GPS -----------------------
  let gpsWatchId = null;
  function startGps() {
    if (!navigator.geolocation) {
      showStatus('GPS', 'A böngésző nem támogatja a geolokációt.');
      return;
    }
    if (gpsWatchId != null) return;

    gpsWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        state.me = { lat: latitude, lng: longitude, acc: accuracy, ts: Date.now() };
        renderMe();
        updatePills();
      },
      (err) => {
        showStatus('GPS hiba', err.message || String(err));
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 12000 }
    );
  }

  function renderMe() {
    if (!state.me) return;
    const ll = [state.me.lat, state.me.lng];
    if (!state.meMarker) {
      const icon = L.divIcon({
        className: '',
        html: `<div style="
          width:18px;height:18px;border-radius:999px;
          background:#4ade80;
          border:3px solid rgba(0,0,0,.55);
          box-shadow:0 10px 30px rgba(0,0,0,.35);
        "></div>`,
        iconSize: [18,18],
        iconAnchor: [9,9],
      });
      state.meMarker = L.marker(ll, { icon, interactive: false }).addTo(state.labelLayer);
      state.meCircle = L.circle(ll, {
        radius: Math.max(10, Math.min(200, state.me.acc || 30)),
        color: 'rgba(74,222,128,.65)',
        fillColor: 'rgba(74,222,128,.20)',
        fillOpacity: 0.25,
        weight: 2,
        interactive: false
      }).addTo(state.labelLayer);
    } else {
      state.meMarker.setLatLng(ll);
      state.meCircle.setLatLng(ll);
      state.meCircle.setRadius(Math.max(10, Math.min(200, state.me.acc || 30)));
    }
  }

  function centerOnMe() {
    if (!state.me) {
      showStatus('GPS', 'Még nincs pozíció (engedélyezd a helyzetet).', 3000);
      return;
    }
    state.map.setView([state.me.lat, state.me.lng], Math.max(state.map.getZoom(), 15), { animate: true });
  }

  // ----------------------- Limo data loading -----------------------
  async function fetchTextAny(urls) {
    let lastErr = null;
    for (const u of urls) {
      try {
        const r = await fetch(u, { cache: 'no-store', mode: 'cors' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.text();
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('fetch failed');
  }

  // Extract first array/object literal from a JS file and evaluate it safely-ish.
  function extractFirstJsLiteral(text) {
    const start = text.search(/[\[{]/);
    if (start < 0) return null;

    // bracket matching with string awareness
    const stack = [];
    let inStr = null;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];

      if (inStr) {
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === inStr) { inStr = null; continue; }
        continue;
      } else {
        if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
        if (ch === '[' || ch === '{') stack.push(ch);
        if (ch === ']' || ch === '}') {
          const last = stack.pop();
          if (!last) continue;
          if (stack.length === 0) {
            return text.slice(start, i + 1);
          }
        }
      }
    }
    return null;
  }

  function evalJsLiteral(expr) {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`"use strict"; return (${expr});`);
    return fn();
  }

  function normalizeCar(raw) {
    // We try multiple possible key names.
    const lat = raw.lat ?? raw.latitude ?? raw.Latitude ?? raw.LAT ?? raw.y;
    const lng = raw.lng ?? raw.lon ?? raw.longitude ?? raw.Longitude ?? raw.LNG ?? raw.x;
    if (lat == null || lng == null) return null;

    const id = String(raw.plate ?? raw.licensePlate ?? raw.license_plate ?? raw.id ?? raw.carId ?? raw.car_id ?? raw.code ?? (raw.name ? raw.name : `${lat},${lng}`));
    const plate = String(raw.plate ?? raw.licensePlate ?? raw.license_plate ?? raw.reg ?? id).toUpperCase();

    const model = raw.model ?? raw.type ?? raw.carType ?? raw.brand ?? raw.vehicleType ?? '';
    const fuel = raw.fuel ?? raw.fuelLevel ?? raw.battery ?? raw.soc ?? raw.charge ?? raw.percent ?? raw.stateOfCharge ?? raw.fuel_percent;

    return {
      id, plate,
      model: String(model || '').trim(),
      fuel: (typeof fuel === 'number') ? fuel : (fuel != null && String(fuel).match(/^\d+(\.\d+)?$/) ? Number(fuel) : null),
      lat: Number(lat),
      lng: Number(lng),
      raw
    };
  }

  async function refreshCars(isInitial=false) {
    const now = Date.now();
    if (!isInitial && now - state._lastRefresh < CFG.REFRESH_COOLDOWN_MS) return;
    state._lastRefresh = now;

    setSubline(isInitial ? 'Autók betöltése…' : 'Frissítés…');

    let text = null;
    try {
      text = await fetchTextAny(CFG.LIMO_CARS_URLS);
    } catch (e) {
      setSubline('Autók: nem elérhető (CORS / hálózat)');
      showStatus('Autók betöltése nem sikerült', 'A mollimo.hu adatfájl nem érhető el innen. A térkép működik, de autók nélkül.', 6000);
      updatePills();
      renderCarList();
      return;
    }

    const lit = extractFirstJsLiteral(text);
    if (!lit) {
      setSubline('Autók: hibás formátum');
      showStatus('cars.js', 'Nem találtam feldolgozható adatot.', 5000);
      return;
    }

    let rawCars;
    try {
      rawCars = evalJsLiteral(lit);
    } catch (e) {
      setSubline('Autók: nem értelmezhető');
      showStatus('cars.js', 'Nem tudtam kiértékelni az adatot.', 5000);
      return;
    }

    if (!Array.isArray(rawCars)) {
      setSubline('Autók: nem lista');
      showStatus('cars.js', 'Az adat nem tömb.', 5000);
      return;
    }

    // Normalize, filter weird.
    const cars = [];
    for (const rc of rawCars) {
      const c = normalizeCar(rc);
      if (!c) continue;
      // (Optional) filter to Budapest-ish bounding box
      if (c.lat < 47.2 || c.lat > 47.8 || c.lng < 18.7 || c.lng > 19.6) continue;
      cars.push(c);
    }

    // Determine disappeared cars
    const newIds = new Set(cars.map(c => c.id));
    for (const oldId of state.carsById.keys()) {
      if (!newIds.has(oldId)) {
        // remove zones, selection, hidden
        delete state.zonesByCar[oldId];
        state.selectedCars.delete(oldId);
        state.hiddenCars.delete(oldId);
        // remove markers
        const m = state.carsAllMarkers.get(oldId);
        if (m) {
          state.carsCluster.removeLayer(m);
          state.carsAllMarkers.delete(oldId);
        }
        const sm = state.carsSelectedMarkers.get(oldId);
        if (sm) {
          state.carsSelectedLayer.removeLayer(sm);
          state.carsSelectedMarkers.delete(oldId);
        }
      }
    }

    state.cars = cars;
    state.carsById = new Map(cars.map(c => [c.id, c]));

    setSubline(`Autók betöltve: ${cars.length}`);
    updatePills();
    saveState();

    renderCarsOnMap();
    renderHotZones();
    renderCarList();

    // If a plan is open, keep only involved; otherwise just re-apply filters.
    if (state.planActive) {
      showPlanView(state.plan, { keepFocus: true });
    } else {
      applyVisibilityRules();
    }
  }

  async function loadLimoZones() {
    let text = null;
    try {
      text = await fetchTextAny(CFG.LIMO_ZONES_URLS);
    } catch {
      state.limoZonesLoaded = false;
      return;
    }
    const lit = extractFirstJsLiteral(text);
    if (!lit) return;

    let data;
    try { data = evalJsLiteral(lit); } catch { return; }

    // Data might be GeoJSON or array of polygons. We'll support:
    // - GeoJSON FeatureCollection
    // - Array of arrays: [[{lat,lng}...], ...] or [[ [lat,lng], ...], ...]
    let geojson = null;

    if (data && typeof data === 'object' && data.type && (data.type === 'FeatureCollection' || data.type === 'Feature')) {
      geojson = data;
    } else if (Array.isArray(data)) {
      const features = [];
      for (const poly of data) {
        if (!Array.isArray(poly) || poly.length < 3) continue;
        const coords = [];
        for (const p of poly) {
          if (Array.isArray(p) && p.length >= 2) coords.push([Number(p[1]), Number(p[0])]); // [lng,lat] input
          else if (p && typeof p === 'object') coords.push([Number(p.lng ?? p.lon), Number(p.lat)]);
        }
        if (coords.length >= 3) {
          features.push({
            type: 'Feature',
            properties: {},
            geometry: { type: 'Polygon', coordinates: [coords] }
          });
        }
      }
      geojson = { type: 'FeatureCollection', features };
    }

    if (!geojson) return;

    if (state.limoZones) state.zoneLayer.removeLayer(state.limoZones);

    state.limoZones = L.geoJSON(geojson, {
      style: () => ({
        color: 'rgba(34,197,94,.65)',
        weight: 2,
        fillColor: 'rgba(34,197,94,.20)',
        fillOpacity: 0.25,
      }),
      interactive: false
    });

    state.limoZonesLoaded = true;
    if (state.zonesOn) state.zoneLayer.addLayer(state.limoZones);
  }

  function setZonesOn(on, silent=false) {
    state.zonesOn = !!on;
    const el = $('toggleZones');
    el.classList.toggle('on', state.zonesOn);
    if (state.limoZonesLoaded && state.limoZones) {
      if (state.zonesOn) state.zoneLayer.addLayer(state.limoZones);
      else state.zoneLayer.removeLayer(state.limoZones);
    }
    if (!silent) saveState();
  }

  function setBkvOn(on, silent=false) {
    state.bkvOn = !!on;
    const el = $('toggleBkv');
    el.classList.toggle('on', state.bkvOn);
    if (!silent) saveState();

    if (state.bkvOn && !(window.GTFS && window.GTFS.isReady && window.GTFS.isReady())) {
      showStatus('BKV mód', 'GTFS háló nincs előkészítve (gtfs/graph.json).', 5000);
      state.bkvOn = false;
      el.classList.remove('on');
      if (!silent) saveState();
    }
  }

  // ----------------------- Rendering: cars -----------------------
  function carIcon(isSelected=false) {
    const ring = isSelected ? `box-shadow:0 0 0 3px rgba(255,176,0,.35);` : '';
    const border = isSelected ? 'border:2px solid rgba(255,176,0,.85);' : 'border:1px solid rgba(255,255,255,.18);';
    return L.divIcon({
      className: '',
      html: `<div style="
        width:44px;height:44px;border-radius:16px;
        background:rgba(17,24,39,.92);
        ${border}
        ${ring}
        box-shadow:0 18px 40px rgba(0,0,0,.45);
        display:flex;align-items:center;justify-content:center;
      ">
        <div style="
          width:22px;height:22px;border-radius:8px;
          background:rgba(255,255,255,.10);
          display:flex;align-items:center;justify-content:center;
          border:1px solid rgba(255,255,255,.12);
        ">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="white" opacity=".9" aria-hidden="true">
            <path d="M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.22.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.85 6h10.29l1.04 3H5.81l1.04-3zM19 17H5v-6h14v6zm-12.5-1c.83 0 1.5-.67 1.5-1.5S7.33 13 6.5 13 5 13.67 5 14.5 5.67 16 6.5 16zm11 0c.83 0 1.5-.67 1.5-1.5S18.33 13 17.5 13 16 13.67 16 14.5 16.67 16 17.5 16z"/>
          </svg>
        </div>
      </div>`,
      iconSize: [44,44],
      iconAnchor: [22,22],
    });
  }

  function renderCarsOnMap() {
    // Clear layers
    state.carsCluster.clearLayers();
    state.carsSelectedLayer.clearLayers();
    state.carsAllMarkers.clear();
    state.carsSelectedMarkers.clear();

    for (const car of state.cars) {
      const isHidden = state.hiddenCars.has(car.id);
      if (isHidden) continue;

      const isSelected = state.selectedCars.has(car.id) || (state.zonesByCar[car.id] && state.zonesByCar[car.id].length);
      const marker = L.marker([car.lat, car.lng], { icon: carIcon(false), keyboard: false });

      marker._carId = car.id;
      marker.on('click', () => onCarClick(car.id));

      // Label
      const label = L.marker([car.lat, car.lng], {
        interactive: false,
        icon: L.divIcon({
          className: '',
          html: `<div class="plate-label">${escapeHtml(car.plate)}</div>`,
          iconSize: [1,1],
          iconAnchor: [-2, 32],
        })
      });
      marker._labelMarker = label;

      if (isSelected) {
        const sm = L.marker([car.lat, car.lng], { icon: carIcon(true), keyboard: false });
        sm._carId = car.id;
        sm.on('click', () => onCarClick(car.id));
        sm._labelMarker = label;
        state.carsSelectedMarkers.set(car.id, sm);
        state.carsSelectedLayer.addLayer(sm);
        state.labelLayer.addLayer(label);
      } else {
        state.carsAllMarkers.set(car.id, marker);
        state.carsCluster.addLayer(marker);
        state.labelLayer.addLayer(label);
      }
    }

    // Spread selected cars to avoid overlap (and stop spiderfy leftovers)
    try { state.carsCluster.unspiderfy && state.carsCluster.unspiderfy(); } catch {}
    spreadSelectedCars();
    applyVisibilityRules();
  }

  function updateCarMarkerPositions() {
    // called on refresh if we'd kept markers; but we rebuild markers currently
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  function spreadSelectedCars() {
    const markers = Array.from(state.carsSelectedMarkers.values());
    if (markers.length <= 1) return;

    // group by proximity (simple: if all within SPREAD_DISTANCE_M of the centroid)
    const ll = markers.map(m => m.getLatLng());
    const centroid = ll.reduce((a, p) => ({ lat: a.lat + p.lat/ll.length, lng: a.lng + p.lng/ll.length }), {lat:0,lng:0});

    const tooClose = ll.every(p => haversineM(p.lat, p.lng, centroid.lat, centroid.lng) < CFG.SPREAD_DISTANCE_M);
    if (!tooClose) return;

    const ring = CFG.SPREAD_RING_M;
    const angleStep = (Math.PI * 2) / markers.length;

    for (let i=0; i<markers.length; i++) {
      const ang = i * angleStep;
      const dLat = (ring * Math.cos(ang)) / 111111;
      const dLng = (ring * Math.sin(ang)) / (111111 * Math.cos(centroid.lat * Math.PI/180));
      const newLL = L.latLng(centroid.lat + dLat, centroid.lng + dLng);
      markers[i].setLatLng(newLL);
      if (markers[i]._labelMarker) markers[i]._labelMarker.setLatLng(newLL);
    }
  }

  function applyVisibilityRules() {
    // If plan active -> handled elsewhere.
    if (state.planActive) return;

    const hasSelection = state.selectedCars.size > 0 || countHotZones() > 0;

    // If there is any selected/hot-zone car, hide unselected from map (as requested).
    if (hasSelection) {
      // Move all non-selected markers out (cluster cleared)
      for (const [id, m] of state.carsAllMarkers.entries()) {
        state.carsCluster.removeLayer(m);
        if (m._labelMarker) state.labelLayer.removeLayer(m._labelMarker);
      }
    } else {
      // Ensure all markers visible
      for (const [id, m] of state.carsAllMarkers.entries()) {
        if (!state.carsCluster.hasLayer(m)) state.carsCluster.addLayer(m);
        if (m._labelMarker && !state.labelLayer.hasLayer(m._labelMarker)) state.labelLayer.addLayer(m._labelMarker);
      }
    }

    // Selected markers always visible
    for (const [id, sm] of state.carsSelectedMarkers.entries()) {
      if (!state.carsSelectedLayer.hasLayer(sm)) state.carsSelectedLayer.addLayer(sm);
      if (sm._labelMarker && !state.labelLayer.hasLayer(sm._labelMarker)) state.labelLayer.addLayer(sm._labelMarker);
    }

    updatePills();
  }

  function showAllCars() {
    state.selectedCars.clear();
    state.activeCarId = null;
    saveState();
    renderCarsOnMap();
    renderHotZones();
    clearPlanView();
    showStatus('Összes autó', 'Kijelölések törölve. Autók újra látszanak.', 2200);
    renderCarList();
  }

  // ----------------------- Hot zones -----------------------
  function countHotZones() {
    let n = 0;
    for (const k of Object.keys(state.zonesByCar)) n += (state.zonesByCar[k] || []).length;
    return n;
  }

  function renderHotZones() {
    state.hotZoneLayer.clearLayers();

    const involvedCarIds = new Set();
    for (const [carId, zones] of Object.entries(state.zonesByCar)) {
      if (!zones || !zones.length) continue;
      if (!state.carsById.has(carId)) continue; // disappeared
      involvedCarIds.add(carId);
      const car = state.carsById.get(carId);

      zones.forEach((z, idx) => {
        // Hot zone circle
        const circle = L.circle([z.lat, z.lng], {
          radius: state.hotRadius,
          color: 'rgba(220,38,38,.75)',
          fillColor: 'rgba(220,38,38,.18)',
          fillOpacity: 0.25,
          weight: 2,
          interactive: false
        });
        state.hotZoneLayer.addLayer(circle);

        // Number marker + car label
        const num = idx + 1;
        const labelHtml = `<div class="target-label"><small>${escapeHtml(car.plate)}</small> #${num}</div>`;
        const marker = L.marker([z.lat, z.lng], {
          icon: L.divIcon({
            className: '',
            html: labelHtml,
            iconSize: [1,1],
            iconAnchor: [0, 18]
          }),
          interactive: false
        });
        state.hotZoneLayer.addLayer(marker);
      });
    }

    updatePills();
  }

  // Map click adds hotzone if activeCarId is set
  function onMapClick(e) {
    if (!state.activeCarId) return;

    const carId = state.activeCarId;
    if (!state.carsById.has(carId)) {
      state.activeCarId = null;
      updatePills();
      return;
    }

    if (!state.zonesByCar[carId]) state.zonesByCar[carId] = [];
    const z = { lat: e.latlng.lat, lng: e.latlng.lng, createdAt: Date.now() };
    state.zonesByCar[carId].push(z);

    state.selectedCars.add(carId); // ensure selected
    saveState();
    renderCarsOnMap();
    renderHotZones();
    renderCarList();

    showStatus('Hot zone hozzáadva', `${state.carsById.get(carId).plate} – #${state.zonesByCar[carId].length} (${Math.round(state.hotRadius)} m kör)`, 1800);

    // Auto-plan debounce (no need "Kész")
    scheduleAutoPlan();
  }

  function onCarClick(carId) {
    // Always keep clickable if it has zones / selected
    state.activeCarId = carId;
    state.selectedCars.add(carId);

    // Stop cluster spiderfy and spread selected
    try { state.carsCluster.unspiderfy && state.carsCluster.unspiderfy(); } catch {}

    saveState();
    renderCarsOnMap();
    renderHotZones();
    renderCarList();

    const car = state.carsById.get(carId);
    const zCount = (state.zonesByCar[carId] || []).length;

    $('pillMode').textContent = `Mód: Hot zone (${car.plate})`;
    showStatus('Hot zone mód', `${car.plate} – koppints a térképre zóna felvételéhez. (Váltás: másik autóra katt)`, 3800);

    // Focus map on car for mobile ease
    state.map.panTo([car.lat, car.lng], { animate: true });
  }

  function clearZonesForCar(carId) {
    delete state.zonesByCar[carId];
    // If no zones and not explicitly selected, unselect
    if (!state.selectedCars.has(carId)) {
      // keep
    }
    saveState();
    renderHotZones();
    renderCarList();
    scheduleAutoPlan();
  }

  function hideCar(carId) {
    state.hiddenCars.add(carId);
    state.selectedCars.delete(carId);
    delete state.zonesByCar[carId];
    if (state.activeCarId === carId) state.activeCarId = null;
    saveState();
    renderCarsOnMap();
    renderHotZones();
    renderCarList();
    scheduleAutoPlan();
  }

  // ----------------------- Car list drawer -----------------------
  function toggleDrawer(show) {
    $('drawer').classList.toggle('show', !!show);
    if (show) renderCarList();
  }

  function renderCarList() {
    const q = ($('carSearch').value || '').trim().toLowerCase();
    const list = $('carList');
    list.innerHTML = '';

    const cars = state.cars
      .filter(c => !state.hiddenCars.has(c.id))
      .filter(c => !q || c.plate.toLowerCase().includes(q) || c.model.toLowerCase().includes(q))
      .sort((a,b) => a.plate.localeCompare(b.plate));

    $('drawerSub').textContent = `${cars.length} autó (rejtve: ${state.hiddenCars.size})`;

    for (const c of cars) {
      const zCount = (state.zonesByCar[c.id] || []).length;
      const isChecked = state.selectedCars.has(c.id) || zCount > 0;

      const item = document.createElement('div');
      item.className = 'carItem';

      const left = document.createElement('div');
      left.className = 'carLeft';

      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.className = 'chk';
      chk.checked = isChecked;
      chk.addEventListener('change', () => {
        if (chk.checked) {
          state.selectedCars.add(c.id);
          state.activeCarId = c.id; // directly enter hotzone mode
          showStatus('Hot zone mód', `${c.plate} – koppints a térképre zóna felvételéhez.`, 2500);
        } else {
          state.selectedCars.delete(c.id);
          // Keep zones if present – checkbox cannot unselect while zones exist
          if ((state.zonesByCar[c.id] || []).length) state.selectedCars.add(c.id);
          if (state.activeCarId === c.id) state.activeCarId = null;
        }
        saveState();
        renderCarsOnMap();
        renderHotZones();
        updatePills();
      });

      const main = document.createElement('div');
      main.className = 'carMain';
      main.innerHTML = `
        <div class="plate">${escapeHtml(c.plate)}</div>
        <div class="carMeta">${escapeHtml(c.model || '—')} • ${c.fuel != null ? `${Math.round(c.fuel)}%` : '—'} • hot zone: ${zCount}</div>
        ${zCount ? `<div class="tag">🔥 hot zone: <b>${zCount}</b></div>` : ``}
      `;

      left.appendChild(chk);
      left.appendChild(main);

      const btns = document.createElement('div');
      btns.className = 'carBtns';

      const bGo = document.createElement('button');
      bGo.className = 'btn';
      bGo.textContent = 'Odaugrás';
      bGo.addEventListener('click', () => {
        state.map.setView([c.lat, c.lng], Math.max(state.map.getZoom(), 16), { animate: true });
      });

      const bHide = document.createElement('button');
      bHide.className = 'btn danger';
      bHide.textContent = 'Elrejt';
      bHide.addEventListener('click', () => hideCar(c.id));

      const bClr = document.createElement('button');
      bClr.className = 'btn warn';
      bClr.textContent = 'Hot zone törlés';
      bClr.addEventListener('click', () => clearZonesForCar(c.id));

      btns.appendChild(bGo);
      btns.appendChild(bHide);
      btns.appendChild(bClr);

      item.appendChild(left);
      item.appendChild(btns);
      list.appendChild(item);
    }
  }

  // ----------------------- Planning -----------------------
  const scheduleAutoPlan = debounce(() => {
    // Auto-plan only if at least 1 candidate car has zones
    const candidates = getCandidateCars();
    if (!candidates.length) return;
    planNow(false).catch(() => {});
  }, CFG.AUTOPLAN_DEBOUNCE_MS);

  function getCandidateCars() {
    const out = [];
    for (const c of state.cars) {
      const zones = state.zonesByCar[c.id];
      if (!zones || !zones.length) continue;
      if (state.hiddenCars.has(c.id)) continue;
      out.push(c);
    }
    return out;
  }

  async function planNow(forceFocus) {
    const candidates = getCandidateCars();
    if (!candidates.length) {
      showStatus('Tervezés', 'Nincs olyan autó, amihez hot zone-t adtál.', 3000);
      clearPlanView();
      return;
    }
    if (!state.me) {
      showStatus('Tervezés', 'GPS pozíció még nincs. Engedélyezd a helyzetet.', 4000);
      return;
    }

    showStatus('Számolás…', 'Útvonaltervezés folyamatban (OSRM)…', 0);
    $('sheet').classList.add('show');
    $('sheetTitle').textContent = 'Számolás…';
    $('sheetSub').textContent = 'Kérlek várj…';
    $('steps').innerHTML = '';

    // Choose start car = nearest to me by walking duration (or BKV if enabled and faster)
    const start = { lat: state.me.lat, lng: state.me.lng, name: 'Én' };

    // We will solve order with DP over cars (small) – start car fixed.
    const startCar = await pickNearestCar(start, candidates);
    const ordered = await solvePlan(start, candidates, startCar);

    state.plan = ordered;
    showPlanView(ordered, { keepFocus: !forceFocus });

    saveState();
  }

  async function pickNearestCar(start, cars) {
    // Use OSRM table from start to car positions (foot)
    try {
      const coords = [[start.lng, start.lat], ...cars.map(c => [c.lng, c.lat])];
      const res = await osrmTable('foot', coords, [0], cars.map((_,i)=>i+1));
      let best = null;
      for (let i=0;i<cars.length;i++){
        const d = res.durations[0][i];
        if (d == null) continue;
        if (!best || d < best.d) best = { d, car: cars[i] };
      }
      if (best) return best.car;
    } catch {}
    // fallback: haversine
    let best = cars[0], bestM = Infinity;
    for (const c of cars) {
      const m = haversineM(start.lat, start.lng, c.lat, c.lng);
      if (m < bestM) { bestM = m; best = c; }
    }
    return best;
  }

  async function solvePlan(start, cars, startCar) {
    // Build index
    const carList = [startCar, ...cars.filter(c => c.id !== startCar.id)];
    const n = carList.length;

    // Build zones nodes per car
    const zonesNodes = []; // each = {carIdx, zoneIdx, lat,lng, id}
    for (let i=0;i<n;i++) {
      const c = carList[i];
      const zs = (state.zonesByCar[c.id] || []).map((z, idx) => ({
        carIdx: i,
        zoneIdx: idx,
        lat: z.lat, lng: z.lng,
        id: `${c.id}#${idx+1}`,
      }));
      zonesNodes.push(...zs);
    }

    // Helper to list zones for a car index
    const zonesForCar = (ci) => zonesNodes.filter(z => z.carIdx === ci);

    // Precompute walking durations from start and from every zone to every car (foot).
    // We'll use OSRM table:
    // Coordinates list: [start, ...zonesNodes, ...cars]
    // We need durations from origins: start + zones -> destinations: cars
    const coordStartIdx = 0;
    const coordZoneOffset = 1;
    const coordCarOffset = 1 + zonesNodes.length;
    const coords = [
      [start.lng, start.lat],
      ...zonesNodes.map(z => [z.lng, z.lat]),
      ...carList.map(c => [c.lng, c.lat]),
    ];

    let footTable = null;
    try {
      const origins = [coordStartIdx, ...zonesNodes.map((_,i)=>coordZoneOffset+i)];
      const dests = carList.map((_,i)=>coordCarOffset+i);
      footTable = await osrmTable('foot', coords, origins, dests);
    } catch (e) {
      // fallback: no table, we'll route per edge later (slow)
      footTable = null;
    }

    // Precompute driving durations from each car to its own zones.
    // Use per-car table to keep sizes small.
    const driveCost = new Map(); // key carIdx|zoneId -> {duration, distance}
    for (let ci=0; ci<n; ci++) {
      const zs = zonesForCar(ci);
      if (!zs.length) continue;
      try {
        const c = carList[ci];
        const cc = [[c.lng, c.lat], ...zs.map(z => [z.lng, z.lat])];
        const t = await osrmTable('car', cc, [0], zs.map((_,i)=>i+1));
        for (let zi=0; zi<zs.length; zi++) {
          const d = t.durations[0][zi];
          const dist = t.distances ? t.distances[0][zi] : null;
          driveCost.set(`${ci}|${zs[zi].id}`, { duration: d, distance: dist });
        }
      } catch {
        // fallback: approximate by haversine with 20 km/h
        const c = carList[ci];
        for (const z of zs) {
          const m = haversineM(c.lat, c.lng, z.lat, z.lng);
          driveCost.set(`${ci}|${z.id}`, { duration: (m/1000)/(20/60/60), distance: m });
        }
      }
    }

    function footDurationFromNodeToCar(nodeCoordIndex, carIdx) {
      if (!footTable) return null;
      const originIndex = nodeCoordIndex; // actual coord index
      // footTable origins aligned to [start] + zones
      // originIndex -> row index mapping:
      const rowIndex = originIndex === 0 ? 0 : (originIndex - 1 + 1); // start row 0, zone i -> row i+1
      const colIndex = carIdx; // car order in dests
      const d = footTable.durations[rowIndex][colIndex];
      const dist = footTable.distances ? footTable.distances[rowIndex][colIndex] : null;
      return { duration: d, distance: dist };
    }

    // DP state: after servicing some cars, you are at a particular zone node (or start before first).
    // We'll fix first car index 0, but choose which zone of car 0 to end at.
    const remaining = Array.from({length:n}, (_,i)=>i).filter(i=>i!==0);

    // If any car has zero zones -> skip (shouldn't happen)
    for (let ci=0; ci<n; ci++) {
      if (!zonesForCar(ci).length) {
        showStatus('Tervezés', `A(z) ${carList[ci].plate} autóhoz nincs hot zone.`, 5000);
      }
    }

    // For exact DP, limit n to 8 (including start car).
    const EXACT_LIMIT = 8;
    if (n > EXACT_LIMIT) {
      // Greedy after start car
      return greedyPlan(start, carList, zonesForCar, driveCost, footTable, zonesNodes);
    }

    const allMask = (1 << n) - 1;
    // dp[mask][zoneNodeIndexInZonesNodesOrStart(-1)] = best
    // We will represent "last position" as coordIndex:
    // - start position coord index = 0
    // - zone position coord index = 1 + zoneGlobalIndex
    const zoneCoordIndexById = new Map();
    zonesNodes.forEach((z, i) => zoneCoordIndexById.set(z.id, 1 + i));

    const memo = new Map();

    async function solve(mask, lastCoordIdx) {
      const key = `${mask}|${lastCoordIdx}`;
      if (memo.has(key)) return memo.get(key);

      if (mask === allMask) {
        const res = { cost: 0, path: [] };
        memo.set(key, res);
        return res;
      }

      // Determine which car indices are still not done
      let best = { cost: Infinity, path: null };

      for (let ci=0; ci<n; ci++) {
        if (mask & (1<<ci)) continue; // already done
        // service car ci: walk from lastCoordIdx to car ci, drive to one of its zones
        const zs = zonesForCar(ci);
        for (const z of zs) {
          const coordIdx = zoneCoordIndexById.get(z.id);
          let walk = null;
          if (footTable && lastCoordIdx != null) {
            walk = footDurationFromNodeToCar(lastCoordIdx, ci);
          }
          if (!walk || walk.duration == null) {
            // fallback: approximate on haversine (5 km/h)
            const from = coordToLatLng(lastCoordIdx, start, zonesNodes);
            const m = haversineM(from.lat, from.lng, carList[ci].lat, carList[ci].lng);
            walk = { duration: (m/1000)/(5/60/60), distance: m };
          }

          const drive = driveCost.get(`${ci}|${z.id}`);
          if (!drive || drive.duration == null) continue;

          const stepCost = walk.duration + drive.duration;

          const next = await solve(mask | (1<<ci), coordIdx);
          const total = stepCost + next.cost;

          if (total < best.cost) {
            best.cost = total;
            best.path = [{
              type: 'service',
              carIdx: ci,
              zoneId: z.id,
              walk,
              drive,
              fromCoordIdx: lastCoordIdx
            }, ...next.path];
          }
        }
      }

      const res = { cost: best.cost, path: best.path || [] };
      memo.set(key, res);
      return res;
    }

    // First step must be start car idx 0
    const zs0 = zonesForCar(0);
    let bestOverall = { cost: Infinity, steps: null };

    for (const z0 of zs0) {
      const walk0 = footTable ? footDurationFromNodeToCar(0, 0) : null;
      const walk = (walk0 && walk0.duration != null) ? walk0 : (() => {
        const m = haversineM(start.lat, start.lng, carList[0].lat, carList[0].lng);
        return { duration: (m/1000)/(5/60/60), distance: m };
      })();

      const drive0 = driveCost.get(`0|${z0.id}`);
      if (!drive0 || drive0.duration == null) continue;

      const coordIdx0 = zoneCoordIndexById.get(z0.id);
      const next = await solve(1<<0, coordIdx0);
      const total = walk.duration + drive0.duration + next.cost;

      if (total < bestOverall.cost) {
        bestOverall.cost = total;
        bestOverall.steps = [{
          type: 'service',
          carIdx: 0,
          zoneId: z0.id,
          walk,
          drive: drive0,
          fromCoordIdx: 0
        }, ...next.path];
      }
    }

    // Convert bestOverall.steps into display plan with route geometries
    const plan = await buildPlanDetails(start, carList, zonesNodes, bestOverall.steps);
    return plan;
  }

  function coordToLatLng(coordIdx, start, zonesNodes) {
    if (coordIdx === 0) return { lat: start.lat, lng: start.lng };
    const z = zonesNodes[coordIdx - 1];
    return { lat: z.lat, lng: z.lng };
  }

  function haversineM(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (d) => d*Math.PI/180;
    const dLat = toRad(lat2-lat1), dLon = toRad(lon2-lon1);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
    return 2*R*Math.asin(Math.sqrt(a));
  }

  async function greedyPlan(start, carList, zonesForCar, driveCost, footTable, zonesNodes) {
    // Start car already first in carList. Then repeatedly choose next minimal incremental time.
    const n = carList.length;
    const done = new Set();
    const steps = [];

    let lastCoordIdx = 0;

    function footDur(fromCoordIdx, carIdx) {
      if (footTable) {
        // row mapping: start row 0, zone i -> row i+1
        const rowIndex = fromCoordIdx === 0 ? 0 : (fromCoordIdx - 1 + 1);
        const d = footTable.durations[rowIndex][carIdx];
        const dist = footTable.distances ? footTable.distances[rowIndex][carIdx] : null;
        if (d != null) return { duration: d, distance: dist };
      }
      const from = coordToLatLng(fromCoordIdx, start, zonesNodes);
      const m = haversineM(from.lat, from.lng, carList[carIdx].lat, carList[carIdx].lng);
      return { duration: (m/1000)/(5/60/60), distance: m };
    }

    // Force first car 0
    done.add(0);
    {
      const zs = zonesForCar(0);
      let bestZ = zs[0], bestCost = Infinity, bestWalk=null, bestDrive=null;
      for (const z of zs) {
        const walk = footDur(0,0);
        const drive = driveCost.get(`0|${z.id}`) || { duration: Infinity, distance: null };
        const c = walk.duration + drive.duration;
        if (c < bestCost) { bestCost = c; bestZ = z; bestWalk=walk; bestDrive=drive; }
      }
      const coordIdx = 1 + zonesNodes.findIndex(x => x.id === bestZ.id);
      steps.push({ type:'service', carIdx:0, zoneId: bestZ.id, walk: bestWalk, drive: bestDrive, fromCoordIdx: 0 });
      lastCoordIdx = coordIdx;
    }

    while (done.size < n) {
      let best = null;
      for (let ci=0; ci<n; ci++) {
        if (done.has(ci)) continue;
        const zs = zonesForCar(ci);
        for (const z of zs) {
          const walk = footDur(lastCoordIdx, ci);
          const drive = driveCost.get(`${ci}|${z.id}`) || { duration: Infinity, distance: null };
          const cost = walk.duration + drive.duration;
          if (!best || cost < best.cost) best = { ci, z, walk, drive, cost };
        }
      }
      if (!best) break;
      done.add(best.ci);
      const coordIdx = 1 + zonesNodes.findIndex(x => x.id === best.z.id);
      steps.push({ type:'service', carIdx: best.ci, zoneId: best.z.id, walk: best.walk, drive: best.drive, fromCoordIdx: lastCoordIdx });
      lastCoordIdx = coordIdx;
    }

    return buildPlanDetails(start, carList, zonesNodes, steps);
  }

  function findZoneById(zonesNodes, id) {
    return zonesNodes.find(z => z.id === id);
  }

  async function buildPlanDetails(start, carList, zonesNodes, steps) {
    // Build route geometries for each leg (walking + driving)
    // Also optionally compute elevation gain/loss for walking legs.
    const planSteps = [];
    let totalWalk = 0, totalDrive = 0;

    for (let i=0; i<steps.length; i++) {
      const s = steps[i];
      const car = carList[s.carIdx];
      const zone = findZoneById(zonesNodes, s.zoneId);

      const from = coordToLatLng(s.fromCoordIdx, start, zonesNodes);
      const toCar = { lat: car.lat, lng: car.lng };
      const toZone = { lat: zone.lat, lng: zone.lng };

      // Walking leg to car (or BKV if enabled and better)
      const walkLeg = await routeLeg('walk', from, toCar);

      // Driving leg to zone
      const driveLeg = await routeLeg('drive', toCar, toZone);

      totalWalk += walkLeg.duration;
      totalDrive += driveLeg.duration;

      planSteps.push({
        idx: i + 1,
        carId: car.id,
        carPlate: car.plate,
        carModel: car.model,
        zoneNo: Number(zone.id.split('#')[1] || 1),
        fromName: (s.fromCoordIdx === 0) ? 'Én' : `Hot zone`,
        walk: walkLeg,
        drive: driveLeg,
        end: toZone,
      });
    }

    // Add between-cars walking legs (from each zone to next car) are already inside next step's walk "from".
    // The above walk legs cover: start->car1, zone1->car2, zone2->car3, ...
    // Good.

    const total = totalWalk + totalDrive;

    return {
      carsUsed: Array.from(new Set(planSteps.map(p => p.carId))),
      steps: planSteps,
      summary: {
        total,
        walk: totalWalk,
        drive: totalDrive,
      }
    };
  }

  async function routeLeg(kind, from, to) {
    // kind: 'walk' or 'drive'
    // If BKV is enabled, for walk legs we can attempt transit planner (GTFS),
    // but only if GTFS graph is ready. If not ready, fallback to OSRM walking.
    if (kind === 'walk' && state.bkvOn && window.GTFS && window.GTFS.isReady && window.GTFS.isReady()) {
      try {
        const alt = await window.GTFS.plan(from, to, {
          maxWalkToStopM: CFG.TRANSIT_MAX_WALK_TO_STOP_M,
        });
        // Compare alt.totalDuration to OSRM quick estimate (use haversine 5 km/h)
        const m = haversineM(from.lat, from.lng, to.lat, to.lng);
        const approxWalk = (m/1000)/(5/60/60);
        if (alt && alt.totalDuration && alt.totalDuration < approxWalk * 0.90) {
          return {
            mode: 'bkv',
            duration: alt.totalDuration,
            distance: alt.totalDistance ?? null,
            geometry: alt.geometry, // array of latlng
            ascent: null,
            descent: null,
            meta: alt.meta
          };
        }
      } catch {}
    }

    // OSRM
    const profile = (kind === 'walk') ? 'foot' : 'car';
    const res = await osrmRoute(profile, from, to);
    // Elevation for walk legs
    let ascent = null, descent = null;
    if (kind === 'walk') {
      const elev = await getElevationStats(res.geometry);
      ascent = elev ? elev.ascent : null;
      descent = elev ? elev.descent : null;
    }
    return {
      mode: profile,
      duration: res.duration,
      distance: res.distance,
      geometry: res.geometry,
      ascent, descent
    };
  }

  // ----------------------- OSRM helpers -----------------------
  function osrmKey(profile, from, to) {
    return `${profile}|${from.lat.toFixed(6)},${from.lng.toFixed(6)}|${to.lat.toFixed(6)},${to.lng.toFixed(6)}`;
  }

  async function osrmRoute(profile, from, to) {
    const key = osrmKey(profile, from, to);
    if (state.osrmCache.has(key)) return state.osrmCache.get(key);

    const baseUrls = profile === 'foot' ? CFG.OSRM_FOOT : CFG.OSRM_CAR;
    let lastErr = null;

    for (const base of baseUrls) {
      try {
        const url = `${base}/route/v1/${profile}/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson&alternatives=false&steps=false`;
        const r = await fetch(url, { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (!j.routes || !j.routes[0]) throw new Error('no routes');
        const route = j.routes[0];
        const out = {
          duration: route.duration,
          distance: route.distance,
          geometry: route.geometry.coordinates.map(c => ({ lat: c[1], lng: c[0] })),
        };
        state.osrmCache.set(key, out);
        return out;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('OSRM route failed');
  }

  async function osrmTable(profile, coords, origins, destinations) {
    // coords: array of [lng,lat]
    const baseUrls = profile === 'foot' ? CFG.OSRM_FOOT : CFG.OSRM_CAR;
    const coordsStr = coords.map(c => `${c[0]},${c[1]}`).join(';');
    const originsStr = origins.join(';');
    const destStr = destinations.join(';');

    let lastErr = null;
    for (const base of baseUrls) {
      try {
        const url = `${base}/table/v1/${profile}/${coordsStr}?sources=${originsStr}&destinations=${destStr}&annotations=duration,distance`;
        const r = await fetch(url, { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (!j.durations) throw new Error('no durations');
        return j;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('OSRM table failed');
  }

  // ----------------------- Elevation (optional best-effort) -----------------------
  async function getElevationStats(latlngs) {
    // External elevation service; may fail or rate-limit.
    // We'll compute ascent/descent from decimated polyline.
    if (!latlngs || latlngs.length < 2) return null;

    // Hash a few points for cache key
    const key = latlngs.length + '|' +
      latlngs[0].lat.toFixed(5)+','+latlngs[0].lng.toFixed(5)+'|' +
      latlngs[Math.floor(latlngs.length/2)].lat.toFixed(5)+','+latlngs[Math.floor(latlngs.length/2)].lng.toFixed(5)+'|' +
      latlngs[latlngs.length-1].lat.toFixed(5)+','+latlngs[latlngs.length-1].lng.toFixed(5);

    if (state.elevationCache.has(key)) return state.elevationCache.get(key);

    // Decimate to max 50 points
    const N = Math.min(50, latlngs.length);
    const pts = [];
    for (let i=0; i<N; i++) {
      const idx = Math.floor(i * (latlngs.length-1) / (N-1));
      pts.push(latlngs[idx]);
    }

    // OpenTopoData (ASTER 30m). CORS usually OK.
    const loc = pts.map(p => `${p.lat},${p.lng}`).join('|');
    const url = `https://api.opentopodata.org/v1/aster30m?locations=${encodeURIComponent(loc)}`;

    try {
      const r = await fetch(url, { cache: 'force-cache' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (!j || !j.results) throw new Error('bad json');
      const elevs = j.results.map(x => x.elevation).filter(x => typeof x === 'number');
      if (elevs.length < 2) return null;

      let ascent = 0, descent = 0;
      for (let i=1;i<elevs.length;i++){
        const d = elevs[i]-elevs[i-1];
        if (d > 0) ascent += d;
        else descent += -d;
      }
      const out = { ascent: Math.round(ascent), descent: Math.round(descent) };
      state.elevationCache.set(key, out);
      return out;
    } catch {
      // silently ignore
      return null;
    }
  }

  // ----------------------- Show plan on map + UI -----------------------
  function clearPlanView() {
    state.planActive = false;
    state.plan = null;
    state.routeLayer.clearLayers();
    $('sheet').classList.remove('show');
    $('statusbar').classList.remove('show');
    renderCarsOnMap();
    renderHotZones();
    applyVisibilityRules();
  }

  function showPlanView(plan, opts = {}) {
    state.planActive = true;
    state.plan = plan;

    // Hide all cars not involved + hide clusters entirely
    state.carsCluster.clearLayers();
    for (const [id, m] of state.carsAllMarkers.entries()) {
      if (m._labelMarker) state.labelLayer.removeLayer(m._labelMarker);
    }

    // Keep only used cars visible (selected layer)
    for (const [id, sm] of state.carsSelectedMarkers.entries()) {
      if (!plan.carsUsed.includes(id)) {
        state.carsSelectedLayer.removeLayer(sm);
        if (sm._labelMarker) state.labelLayer.removeLayer(sm._labelMarker);
      } else {
        if (!state.carsSelectedLayer.hasLayer(sm)) state.carsSelectedLayer.addLayer(sm);
        if (sm._labelMarker && !state.labelLayer.hasLayer(sm._labelMarker)) state.labelLayer.addLayer(sm._labelMarker);
      }
    }

    // Hot zones: show only involved
    state.hotZoneLayer.clearLayers();
    const involved = new Set(plan.carsUsed);
    for (const carId of involved) {
      const zones = state.zonesByCar[carId] || [];
      const car = state.carsById.get(carId);
      zones.forEach((z, idx) => {
        const circle = L.circle([z.lat, z.lng], {
          radius: state.hotRadius,
          color: 'rgba(220,38,38,.80)',
          fillColor: 'rgba(220,38,38,.20)',
          fillOpacity: 0.25,
          weight: 2,
          interactive: false
        });
        state.hotZoneLayer.addLayer(circle);

        const num = idx+1;
        const marker = L.marker([z.lat, z.lng], {
          icon: L.divIcon({
            className:'',
            html: `<div class="target-label"><small>${escapeHtml(car.plate)}</small> #${num}</div>`,
            iconSize:[1,1],
            iconAnchor:[0,18]
          }),
          interactive: false
        });
        state.hotZoneLayer.addLayer(marker);
      });
    }

    // Draw routes
    state.routeLayer.clearLayers();
    const allLatLngs = [];

    for (const step of plan.steps) {
      // walking
      const w = step.walk;
      const wColor = (w.mode === 'bkv') ? 'rgba(59,130,246,.95)' : 'rgba(37,99,235,.95)';
      const wLine = L.polyline(w.geometry.map(p => [p.lat, p.lng]), { color: wColor, weight: 7, opacity: 0.9 });
      state.routeLayer.addLayer(wLine);
      allLatLngs.push(...w.geometry.map(p => [p.lat, p.lng]));

      // driving
      const d = step.drive;
      const dLine = L.polyline(d.geometry.map(p => [p.lat, p.lng]), { color: 'rgba(34,197,94,.95)', weight: 7, opacity: 0.9 });
      state.routeLayer.addLayer(dLine);
      allLatLngs.push(...d.geometry.map(p => [p.lat, p.lng]));
    }

    // Fit bounds
    if (allLatLngs.length && !opts.keepFocus) {
      const b = L.latLngBounds(allLatLngs);
      state.map.fitBounds(b.pad(0.15), { animate: true });
    }

    // Sheet
    $('sheet').classList.add('show');
    $('sheetTitle').textContent = 'Kész';
    $('sheetSub').textContent =
      `Össz-idő: ${fmtMin(plan.summary.total)} (🚶 ${fmtMin(plan.summary.walk)} + 🚗 ${fmtMin(plan.summary.drive)})`;

    const stepsEl = $('steps');
    stepsEl.innerHTML = '';
    plan.steps.forEach((s, i) => {
      const el = document.createElement('div');
      el.className = 'step';
      const asc = (s.walk.ascent != null && s.walk.descent != null) ? ` • ${s.walk.ascent} m ↗ ${s.walk.descent} m ↘` : '';
      const walkMode = (s.walk.mode === 'bkv') ? '🚇/🚌' : '🚶';
      const walkMeta = `${walkMode} ${fmtMin(s.walk.duration)} • ${s.walk.distance != null ? fmtKm(s.walk.distance) : '—'}${asc}`;
      const driveMeta = `🚗 ${fmtMin(s.drive.duration)} • ${s.drive.distance != null ? fmtKm(s.drive.distance) : '—'}`;

      el.innerHTML = `
        <div class="badge">${i+1}</div>
        <div style="min-width:0;">
          <div class="stepTitle">${escapeHtml(s.carPlate)} → Hot zone #${s.zoneNo}</div>
          <div class="stepMeta">${walkMeta}<br>${driveMeta}</div>
          <div class="kv">
            <span>Start: ${escapeHtml(s.fromName)}</span>
            <span>Autó: ${escapeHtml(s.carModel || '—')}</span>
          </div>
        </div>
      `;
      stepsEl.appendChild(el);
    });

    showStatus(
      'Kész',
      `Legjobb sorrend: ${plan.steps.map(s => s.carPlate).join(' → ')}`,
      3000
    );

    updatePills();
  }

  // ----------------------- UI pills -----------------------
  function updatePills() {
    $('pillCars').textContent = `Autók: ${state.cars.length}`;
    const selectedCount = (() => {
      let n = 0;
      for (const c of state.cars) {
        const z = (state.zonesByCar[c.id] || []).length;
        if (state.selectedCars.has(c.id) || z) n++;
      }
      return n;
    })();
    $('pillSelected').textContent = `Kijelölt: ${selectedCount}`;
    $('pillTargets').textContent = `Hot zone: ${countHotZones()}`;
    $('pillMode').textContent = state.activeCarId
      ? `Mód: Hot zone (${(state.carsById.get(state.activeCarId)?.plate)||'—'})`
      : 'Mód: —';
  }

  // ----------------------- Boot -----------------------
  initMap();

})();
