// SkyRunZim: offline race map with live GPS, run recording and course.
// Keep APP_VERSION in step with SHELL in sw.js.
const APP_VERSION = 'v21 (12 Nov 2026)';
// The indemnity text is data/indemnity.html. Change this when its wording
// changes: every runner is then asked to accept the new one.
const INDEMNITY_VERSION = '2026-1';
const TILE_CACHE = 'tiles-v2';
// The maps the app can show. Each race says which map it uses ("map" in the
// race list). Bump a map's tag when its pieces change, so phones download again.
const MAPS = {
  nyanga: {
    name: 'Nyanga race map', tag: 'turaco2026', approxMB: 42, sets: ['tiles-turaco26'],
    // Far and Wide "Turaco Trail 2026" race map, bounds read from its GeoTIFF.
    bbox: { west: 32.69659612566003, east: 32.992700072259964, south: -18.523914235060392, north: -18.215629827297686 },
    layers: [{ url: 'tiles-turaco26/{z}/{x}/{y}.webp', minNativeZoom: 11, maxNativeZoom: 16 }],
    attribution: 'Race map © Far and Wide',
  },
  // The Harare practice map (tiles-harare, tools/render-harare.mjs) was taken
  // out in v21 with the Harare Prep race, which confused runners. Phones that
  // saved it free the space by themselves (removeOldTiles).
};
const ALL_TILE_SETS = Object.values(MAPS).flatMap(m => m.sets);
const RACE_SOURCE_SHA256 = '2c0463b6ffde958bc8a0b5489d04023cbd628d08b432fdc2262097592d4b9aac';

// Thresholds for GPS warnings and recording. Change here, not in the code below.
const CONFIG = {
  currentMaxAgeSec: 10,     // reading 0-10 s old: current
  delayedMaxAgeSec: 30,     // 11-30 s: delayed; older: stale
  poorAccuracyM: 50,        // ± worse than this is flagged as poor
  headingMinSpeedMs: 0.7,   // GPS heading is only trusted when moving
  nearMapKm: 5,             // "centre on me" works up to this far outside the map
  recordMinMoveM: 5,        // skip points closer than this...
  recordMaxGapSec: 30,      // ...unless this long has passed
  recordMaxAccuracyM: 75,   // readings worse than this are not recorded
  recordMaxSpeedMs: 12,     // faster jumps (43 km/h) are treated as GPS glitches
};

const $ = id => document.getElementById(id);
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pref = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch {} return null; };
$('version').textContent = 'Version ' + APP_VERSION;

// A small spinning wheel shown wherever the app is waiting on something.
const SPIN = '<span class="spin" aria-hidden="true"></span>';
const secondsSince = t => Math.max(0, Math.round((Date.now() - t) / 1000));

let toastTimer;
function toast(msg, ms = 4000) {
  const t = $('toast'); t.textContent = msg; t.style.display = 'block';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.style.display = 'none'), ms);
}

// =====================================================================
// Map
// =====================================================================
const toBounds = b => L.latLngBounds([b.south, b.west], [b.north, b.east]);
let activeMap = MAPS[pref('activeMap')] ? pref('activeMap') : 'nyanga';
// The area of the map on show (also used for the "outside the map" warning).
let raceBounds = toBounds(MAPS[activeMap].bbox);
let bounds = raceBounds;
const map = L.map('map', {
  preferCanvas: true, zoomControl: false, minZoom: 10, maxZoom: 18,
  maxBounds: bounds.pad(0.3), maxBoundsViscosity: 0.8,
});
// Fit an area into the part of the screen not covered by the top bar and bottom panel.
const fitArea = b => map.fitBounds(b, { paddingTopLeft: [10, 60], paddingBottomRight: [10, (document.getElementById('panel').offsetHeight || 120) + 16] });
fitArea(raceBounds);
try {
  const v = JSON.parse(pref('view'));
  if (v && raceBounds.pad(0.3).contains(v.c)) map.setView(v.c, v.z);
} catch {}
map.on('moveend', () => pref('view', JSON.stringify({ c: map.getCenter(), z: map.getZoom() })));

let mapLayers = [], raceLayer = null;
// Shows one of the maps. Returns true if the map on show changed.
function setMap(id) {
  if (!MAPS[id]) id = 'nyanga';
  if (id === activeMap && mapLayers.length) return false;
  const m = MAPS[id];
  activeMap = id; pref('activeMap', id);
  mapLayers.forEach(l => l.remove());
  mapLayers = m.layers.map(l => L.tileLayer(l.url, {
    minZoom: l.minZoom ?? 10, maxZoom: 18, minNativeZoom: l.minNativeZoom, maxNativeZoom: l.maxNativeZoom,
    bounds: toBounds(l.bbox || m.bbox), attribution: m.attribution,
  }).addTo(map));
  raceLayer = mapLayers[0];
  raceBounds = bounds = toBounds(m.bbox);
  map.setMaxBounds(bounds.pad(0.3));
  refreshOfflineStatus();
  return true;
}
setMap(activeMap);
L.control.scale({ imperial: false, position: 'topleft' }).addTo(map);
// The position marker sits in its own layer above every label so it is never hidden.
map.createPane('gps').style.zIndex = 650;

function setZoomClass() {
  map.getContainer().classList.toggle('zoom-lo', map.getZoom() < 13);
  map.getContainer().classList.toggle('zoom-mid', map.getZoom() < 15);
}
map.on('zoomend', setZoomClass); setZoomClass();

const label = (text, cls) => L.divIcon({ className: '', html: `<div class="lbl ${cls}">${text}</div>`, iconSize: [0, 0] });

// Map buttons
$('zoomInBtn').onclick = () => map.zoomIn();
$('zoomOutBtn').onclick = () => map.zoomOut();
$('fitBtn').onclick = () => { setFollow(false); fitArea(raceBounds); };

// =====================================================================
// GPS
// =====================================================================
const gps = { watchId: null, perm: 'unknown', state: 'off', fix: null, errorCode: null, follow: false, detailsOpen: false };

if (navigator.permissions && navigator.permissions.query) {
  navigator.permissions.query({ name: 'geolocation' }).then(p => {
    gps.perm = p.state;
    p.onchange = () => { gps.perm = p.state; renderGps(); };
    renderGps();
  }).catch(() => {});
}

const gpsRenderer = L.svg({ pane: 'gps' });
const accCircle = L.circle([0, 0], { pane: 'gps', renderer: gpsRenderer, radius: 1, color: '#1565c0', weight: 1.5, fillOpacity: 0.12, interactive: false });
const meMarker = L.marker([0, 0], {
  pane: 'gps', interactive: false, keyboard: false,
  icon: L.divIcon({ className: '', iconSize: [0, 0], html: '<div class="me"><div class="me-arrow"></div><div class="me-dot"></div><div class="me-tag"></div></div>' }),
});

function startGps() {
  if (!('geolocation' in navigator)) { gps.state = 'unsupported'; renderGps(); return; }
  if (gps.watchId !== null) return;
  gps.state = 'searching'; gps.errorCode = null; gps.searchSince = Date.now();
  gps.watchId = navigator.geolocation.watchPosition(onFix, onGpsError,
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 60000 });
  pref('gpsOn', '1');
  renderGps();
}

function stopGps() {
  if (gps.watchId !== null) navigator.geolocation.clearWatch(gps.watchId);
  gps.watchId = null;
}

function onFix(pos) {
  const c = pos.coords;
  const num = v => (v == null || Number.isNaN(v) ? null : v);
  const r = {
    lat: c.latitude, lon: c.longitude, acc: num(c.accuracy), alt: num(c.altitude), altAcc: num(c.altitudeAccuracy),
    heading: num(c.heading), speed: num(c.speed), t: pos.timestamp || Date.now(),
  };
  if (!Number.isFinite(r.lat) || !Number.isFinite(r.lon) || Math.abs(r.lat) > 90 || Math.abs(r.lon) > 180) return;
  const first = !gps.fix;
  gps.fix = r; gps.state = 'ok'; gps.errorCode = null;

  // The marker is always placed exactly where the GPS says, never snapped to
  // the course or pulled onto the map.
  accCircle.setLatLng([r.lat, r.lon]).setRadius(r.acc || 0);
  meMarker.setLatLng([r.lat, r.lon]);
  if (!map.hasLayer(accCircle)) { accCircle.addTo(map); meMarker.addTo(map); }

  if (distanceOutsideKm(r.lat, r.lon) <= CONFIG.nearMapKm && (gps.follow || first)) {
    if (first) setFollow(true);
    map.setView([r.lat, r.lon], Math.max(map.getZoom(), 15), { animate: !first });
  }
  updateCourse();
  recorder.add(r);
  renderGps();
}

function onGpsError(err) {
  gps.errorCode = err.code;
  if (err.code === 1) { gps.state = 'denied'; gps.perm = 'denied'; stopGps(); }
  else if (err.code === 2) gps.state = gps.fix ? 'ok' : 'unavailable';
  else gps.state = gps.fix ? 'ok' : 'searching';
  renderGps();
}

// How far outside the whole map a point is, in km (0 when inside).
function distanceOutsideKm(lat, lon) {
  if (bounds.contains([lat, lon])) return 0;
  const cl = Math.min(Math.max(lat, bounds.getSouth()), bounds.getNorth());
  const cn = Math.min(Math.max(lon, bounds.getWest()), bounds.getEast());
  return map.distance([lat, lon], [cl, cn]) / 1000;
}

function freshness(fix) {
  const age = Math.max(0, (Date.now() - fix.t) / 1000);
  const level = age <= CONFIG.currentMaxAgeSec ? 'current' : age <= CONFIG.delayedMaxAgeSec ? 'delayed' : 'stale';
  return { age, level };
}

// Heading: GPS course while moving, otherwise the phone's compass (always on).
// A phone only reports the compass when the direction changes, so a runner
// standing still gets no new readings: the last one stays good until the app
// goes to the background (when readings stop and may be out of date).
const compass = { on: false, deg: null, at: 0 };
function currentHeading() {
  const f = gps.fix;
  if (f && f.heading != null && f.speed != null && f.speed >= CONFIG.headingMinSpeedMs) return { deg: f.heading, src: 'GPS' };
  if (compass.on && compass.deg != null) return { deg: compass.deg, src: 'compass' };
  return null;
}

const compassPoint = b => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(b / 45) % 8];
const fmtAge = s => (s < 90 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`);

function setFollow(on) {
  gps.follow = on;
  $('locateBtn').classList.toggle('active', on);
}

$('locateBtn').onclick = () => {
  startGps();
  const f = gps.fix;
  if (f) {
    const away = distanceOutsideKm(f.lat, f.lon);
    if (away > CONFIG.nearMapKm) { toast(`You are ${away.toFixed(0)} km from the map area, so the map cannot show your position.`); return; }
    setFollow(true);
    map.setView([f.lat, f.lon], Math.max(map.getZoom(), 15));
  } else {
    setFollow(true);
    toast('Finding your position…', 2500);
  }
};
map.on('dragstart', () => setFollow(false));

function badge(cls, text) { return `<span class="badge ${cls}">${escapeHtml(text)}</span>`; }

function renderGps() {
  const f = gps.fix, badges = [];
  let hint = '';
  if (gps.state === 'off') { badges.push(badge('off', 'GPS off')); hint = 'Tap the blue target button to show your position.'; }
  else if (gps.state === 'unsupported') { badges.push(badge('bad', '✕ No GPS on this device')); }
  else if (gps.state === 'denied') {
    badges.push(badge('bad', '✕ Location blocked'));
    hint = 'Allow location for this site. iPhone: Settings › Privacy & Security › Location Services › Safari Websites › While Using. Android: tap the lock by the web address › Permissions › Location › Allow. Then tap the target button again.';
  } else if (!f && gps.state === 'unavailable') {
    badges.push(badge('bad', '✕ No GPS signal'));
    hint = 'Check that Location (GPS) is switched on in your phone settings, and move into the open.';
  } else if (!f) {
    badges.push(`<span class="badge warn">${SPIN}Searching for GPS · ${secondsSince(gps.searchSince || Date.now())} s</span>`);
    hint = 'This can take up to a minute. Stand in the open, away from cliffs.';
  } else {
    const { age, level } = freshness(f);
    if (level === 'current') badges.push(badge('ok', `✓ GPS live ±${Math.round(f.acc)} m`));
    else if (level === 'delayed') badges.push(badge('warn', `◷ Delayed: ${fmtAge(age)} old`));
    else badges.push(badge('bad', `✕ OLD POSITION: ${fmtAge(age)}`));
    const poor = f.acc != null && f.acc > CONFIG.poorAccuracyM;
    if (poor) badges.push(badge('warn', `⚠ Poor accuracy ±${Math.round(f.acc)} m`));
    const away = distanceOutsideKm(f.lat, f.lon);
    if (away > 0) badges.push(badge('bad', `⚠ Outside map: ${away < 10 ? away.toFixed(1) : Math.round(away)} km`));
    if (level === 'stale') hint = `No new GPS reading for ${fmtAge(age)}. You may have moved since; the grey dot shows where you were.`;
    else if (poor) hint = 'GPS accuracy is poor. You could be anywhere inside the shaded circle.';
    else if (away > 0) hint = 'You are outside the map area. Your position is shown where it really is, off the map.';
  }
  $('gpsBadges').innerHTML = badges.join('');
  $('gpsHint').textContent = hint; $('gpsHint').hidden = !hint;

  $('gpsStats').hidden = $('gpsCoords').hidden = !f;
  if (f) {
    $('stAlt').textContent = f.alt != null ? `${Math.round(f.alt)} m` : 'n/a';
    $('stSpeed').textContent = f.speed != null ? `${(f.speed * 3.6).toFixed(1)} km/h` : 'n/a';
    const h = currentHeading();
    $('stHeading').textContent = h ? `${Math.round(h.deg)}° ${compassPoint(h.deg)}` : 'n/a';
    $('gpsCoords').textContent = `${f.lat.toFixed(6)}, ${f.lon.toFixed(6)}  ±${Math.round(f.acc)} m`;
  }
  renderDetails();
  updateMarker();
  $('locateBtn').classList.toggle('attn', !!f && !gps.follow && distanceOutsideKm(f.lat, f.lon) <= CONFIG.nearMapKm);
}

function renderDetails() {
  const d = $('gpsDetails');
  d.hidden = !gps.detailsOpen;
  $('detailsBtn').textContent = gps.detailsOpen ? 'Details ▴' : 'Details ▾';
  if (!gps.detailsOpen) return;
  const f = gps.fix, h = currentHeading();
  const permText = { granted: 'Allowed', denied: 'Blocked', prompt: 'Not yet asked', unknown: 'Unknown' }[gps.perm] || gps.perm;
  const rows = [
    ['Permission', permText],
    ['GPS', { off: 'Off', searching: 'Searching', ok: 'Receiving', unavailable: 'Unavailable', denied: 'Blocked', unsupported: 'Not supported' }[gps.state]],
    ['Map following', gps.follow ? 'On' : 'Off (tap target to re-centre)'],
    ['Recording', recorder.status === 'idle' ? 'Not recording' : recorder.status],
  ];
  if (f) {
    rows.push(['Reading time', new Date(f.t).toLocaleTimeString()], ['Reading age', fmtAge(freshness(f).age)],
      ['Latitude', f.lat.toFixed(6)], ['Longitude', f.lon.toFixed(6)], ['Accuracy', `±${Math.round(f.acc)} m`],
      ['Altitude', f.alt != null ? `${Math.round(f.alt)} m${f.altAcc != null ? ` (±${Math.round(f.altAcc)} m)` : ''}` : 'Not available'],
      ['Heading', h ? `${Math.round(h.deg)}° from ${h.src}` : 'Not available yet (from GPS when moving, or the compass)'],
      ['Speed', f.speed != null ? `${(f.speed * 3.6).toFixed(1)} km/h` : 'Not available'],
      ['On the map', raceBounds.contains([f.lat, f.lon]) ? 'Yes' : 'No']);
  }
  d.innerHTML = rows.map(([k, v]) => `<div class="row"><span>${escapeHtml(k)}</span><b>${escapeHtml(v)}</b></div>`).join('');
}
$('detailsBtn').onclick = () => { gps.detailsOpen = !gps.detailsOpen; renderDetails(); };

function updateMarker() {
  const el = meMarker.getElement();
  const f = gps.fix;
  if (!el || !f) return;
  const me = el.firstChild, { age, level } = freshness(f);
  const poor = f.acc != null && f.acc > CONFIG.poorAccuracyM;
  const h = currentHeading();
  me.className = 'me ' + level + (poor ? ' poor' : '') + (h ? ' has-heading' : '');
  me.querySelector('.me-arrow').style.transform = h ? `rotate(${h.deg}deg)` : '';
  me.querySelector('.me-tag').textContent = level === 'stale' ? `OLD ${fmtAge(age)}` : poor ? `±${Math.round(f.acc)} m` : '';
  accCircle.setStyle(level === 'stale'
    ? { color: '#616161', dashArray: '4 6', fillOpacity: 0.06 }
    : poor ? { color: '#b45309', dashArray: '8 6', fillOpacity: 0.12 } : { color: '#1565c0', dashArray: null, fillOpacity: 0.12 });
}

// Compass: always on. It is listened to from the start. Phones that must be
// asked (iPhone, and newer Chrome) are asked straight away, which Chrome
// allows; iPhone only allows it from a tap, and again each time the app is
// opened, so there the first tap anywhere asks (the box shows once).
function onOrient(e) {
  let h = null;
  if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;
  else if (e.absolute && e.alpha != null) h = (360 - e.alpha + ((screen.orientation && screen.orientation.angle) || 0)) % 360;
  if (h == null) return;
  if (!compass.at) document.removeEventListener('click', askOnTap, true);
  compass.deg = h; compass.at = Date.now(); renderCompass();
}
const needsAsking = () => typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function';
function listenCompass() {
  window.removeEventListener('deviceorientationabsolute', onOrient);
  window.removeEventListener('deviceorientation', onOrient);
  window.addEventListener('deviceorientationabsolute', onOrient);
  window.addEventListener('deviceorientation', onOrient);
  compass.on = true;
}
async function askCompass() {
  if (!needsAsking()) return;
  try {
    compass.denied = (await DeviceOrientationEvent.requestPermission()) !== 'granted';
    if (!compass.denied) listenCompass();
  } catch { /* not from a tap: the next tap asks */ }
  renderCompass();
}
function askOnTap() { if (!compass.denied && !compass.at) askCompass(); }
function startCompass() {
  listenCompass();
  if (needsAsking()) { askCompass(); document.addEventListener('click', askOnTap, true); }
}
// Out of sight, readings stop: forget the last one (the runner may have turned)
// and listen afresh on return, as some phones stop sending until then.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { compass.deg = null; return; }
  if (compass.on) listenCompass();
});
function renderCompass() {
  const el = document.getElementById('compassText');
  if (!el) return;
  el.textContent = compass.deg != null ? `Working: facing ${Math.round(compass.deg)}° ${compassPoint(compass.deg)}`
    : compass.denied ? 'Not allowed. To allow it: close the app fully, open it again and tap Allow when asked.'
    : needsAsking() && !compass.at ? 'Tap anywhere on the map to turn it on.'
    : compass.at ? 'Move the phone to wake it.' : 'Not found on this phone: direction is shown only while moving.';
}

// =====================================================================
// Local database (IndexedDB): recordings survive restarts and crashes
// =====================================================================
let dbPromise = null;
function openDb() {
  if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
    const r = indexedDB.open('trailmap', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('tracks', { keyPath: 'id', autoIncrement: true });
      d.createObjectStore('points', { keyPath: 'id', autoIncrement: true }).createIndex('track', 'trackId');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbPromise;
}
const reqDone = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const txDone = tx => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = tx.onabort = () => rej(tx.error); });
async function putTrack(t) { const d = await openDb(); return reqDone(d.transaction('tracks', 'readwrite').objectStore('tracks').put(t)); }
async function getTracks() { const d = await openDb(); return reqDone(d.transaction('tracks').objectStore('tracks').getAll()); }
async function getPoints(id) { const d = await openDb(); return reqDone(d.transaction('points').objectStore('points').index('track').getAll(id)); }
// A point and its track summary are saved together, so they never disagree.
async function savePoint(p, t) {
  const d = await openDb(), tx = d.transaction(['points', 'tracks'], 'readwrite');
  tx.objectStore('points').add(p); tx.objectStore('tracks').put(t);
  return txDone(tx);
}
async function deleteTrack(id) {
  const d = await openDb(), tx = d.transaction(['tracks', 'points'], 'readwrite');
  tx.objectStore('tracks').delete(id);
  const pts = tx.objectStore('points');
  pts.index('track').openKeyCursor(IDBKeyRange.only(id)).onsuccess = e => {
    const c = e.target.result; if (c) { pts.delete(c.primaryKey); c.continue(); }
  };
  return txDone(tx);
}

// =====================================================================
// Run recording
// =====================================================================
const crumbLayer = L.polyline([], { color: '#283593', weight: 3.5, opacity: 0.9, interactive: false });
const recorder = {
  status: 'idle', track: null, last: null, segs: [], skippedPoor: 0, skippedJump: 0, chain: Promise.resolve(), saveError: null,

  async start() {
    if (this.status !== 'idle') return;
    startGps();
    const now = new Date();
    const t = { name: `Run ${now.toLocaleDateString()} ${now.toTimeString().slice(0, 5)}`, startedAt: now.toISOString(), endedAt: null,
      status: 'recording', distanceM: 0, points: 0, activeMs: 0, activeSince: Date.now(), segment: 0 };
    t.id = await putTrack(t);
    Object.assign(this, { status: 'recording', track: t, last: null, segs: [[]], skippedPoor: 0, skippedJump: 0 });
    crumbLayer.setLatLngs([]).addTo(map);
    toast('Recording started. It only records while the app is open on screen.');
    renderRec();
  },

  add(r) {
    if (this.status !== 'recording') return;
    const t = this.track, last = this.last;
    if (r.acc == null || r.acc > CONFIG.recordMaxAccuracyM) { this.skippedPoor++; return; }
    let d = 0;
    if (last) {
      const dt = (r.t - last.t) / 1000;
      if (dt <= 0) return;
      d = map.distance([last.lat, last.lon], [r.lat, r.lon]);
      // A jump faster than a runner can move, and bigger than both readings'
      // error, is a GPS glitch rather than real movement.
      if (d / dt > CONFIG.recordMaxSpeedMs && d > r.acc + last.acc) { this.skippedJump++; return; }
      if (d < CONFIG.recordMinMoveM && dt < CONFIG.recordMaxGapSec) return;
    }
    this.last = r;
    t.distanceM += d; t.points++;
    this.segs[this.segs.length - 1].push([r.lat, r.lon]);
    crumbLayer.setLatLngs(this.segs);
    const p = { trackId: t.id, segment: t.segment, latitude: r.lat, longitude: r.lon, altitude: r.alt,
      horizontalAccuracy: r.acc, heading: r.heading, speed: r.speed, recordedAt: new Date(r.t).toISOString() };
    const snapshot = { ...t };
    this.chain = this.chain.then(() => savePoint(p, snapshot)).then(() => { this.saveError = null; })
      .catch(err => { this.saveError = err.message || String(err); console.error('Saving point failed', err); });
    renderRec();
  },

  pause() {
    if (this.status !== 'recording') return;
    const t = this.track;
    t.activeMs += Date.now() - t.activeSince; t.activeSince = null; t.status = 'paused';
    this.status = 'paused';
    this.chain = this.chain.then(() => putTrack({ ...t }));
    renderRec();
  },

  resume() {
    if (this.status !== 'paused') return;
    startGps();
    const t = this.track;
    t.status = 'recording'; t.activeSince = Date.now(); t.segment++;
    this.status = 'recording'; this.last = null; this.segs.push([]);
    crumbLayer.addTo(map);
    this.chain = this.chain.then(() => putTrack({ ...t }));
    $('resumeBanner').style.display = 'none';
    renderRec();
  },

  async stop() {
    if (this.status === 'idle') return;
    const t = this.track;
    if (t.activeSince) t.activeMs += Date.now() - t.activeSince;
    t.activeSince = null; t.status = 'done'; t.endedAt = new Date().toISOString();
    await (this.chain = this.chain.then(() => putTrack({ ...t })));
    Object.assign(this, { status: 'idle', track: null, last: null, segs: [] });
    crumbLayer.remove();
    $('resumeBanner').style.display = 'none';
    toast(`Saved: ${km(t.distanceM)}, ${t.points} points. Export it from ☰ › My recordings.`);
    renderRec(); renderTracks();
  },

  // After a crash or restart: reload the unfinished recording, paused.
  async recover() {
    const open = (await getTracks()).filter(t => t.status !== 'done').sort((a, b) => b.id - a.id)[0];
    if (!open) return;
    const pts = await getPoints(open.id);
    if (open.activeSince) {
      const lastT = pts.length ? Date.parse(pts[pts.length - 1].recordedAt) : open.activeSince;
      open.activeMs += Math.max(0, lastT - open.activeSince); open.activeSince = null;
    }
    open.status = 'paused';
    await putTrack(open);
    const segs = [];
    for (const p of pts) { (segs[p.segment] = segs[p.segment] || []).push([p.latitude, p.longitude]); }
    Object.assign(this, { status: 'paused', track: open, last: null, segs: segs.filter(Boolean) });
    if (!this.segs.length) this.segs = [[]];
    crumbLayer.setLatLngs(this.segs).addTo(map);
    $('resumeText').textContent = `An unfinished recording was found: ${km(open.distanceM)}, ${open.points} points. Nothing was lost.`;
    $('resumeBanner').style.display = 'block';
    renderRec();
  },
};

const fmtDur = ms => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const activeMs = t => t.activeMs + (t.activeSince ? Date.now() - t.activeSince : 0);

function renderRec() {
  const r = recorder, on = r.status !== 'idle';
  $('recInfo').hidden = !on;
  $('recBtn').classList.toggle('on', r.status === 'recording');
  if (!on) return;
  const t = r.track;
  $('recWhat').textContent = r.status === 'recording' ? '● RECORDING' : '❚❚ PAUSED';
  $('recWhat').className = 'what' + (r.status === 'recording' ? ' on' : '');
  $('pauseBtn').textContent = r.status === 'recording' ? 'Pause' : 'Resume';
  const notes = [];
  if (r.skippedPoor) notes.push(`${r.skippedPoor} poor readings skipped`);
  if (r.skippedJump) notes.push(`${r.skippedJump} GPS jumps ignored`);
  if (r.saveError) notes.push(`⚠ Could not save: ${r.saveError}`);
  if (r.status === 'recording' && (!gps.fix || freshness(gps.fix).level === 'stale')) notes.push('⚠ Waiting for GPS: nothing is being recorded');
  $('recSub').textContent = `${km(t.distanceM)} · ${fmtDur(activeMs(t))} · ${t.points} points` + (notes.length ? ' · ' + notes.join(' · ') : '');
}

$('recBtn').onclick = () => {
  if (recorder.status === 'idle') recorder.start();
  else toast('Use Pause or Stop in the panel at the bottom.');
};
$('pauseBtn').onclick = () => (recorder.status === 'recording' ? recorder.pause() : recorder.resume());
$('stopBtn').onclick = () => { if (confirm('Stop and save this recording?')) recorder.stop(); };
$('resumeBtn').onclick = () => recorder.resume();
$('finishBtn').onclick = () => recorder.stop();

// ---------- Export (GPX and GeoJSON) ----------
const xmlEsc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

function buildGpx(t, pts) {
  const segs = [];
  for (const p of pts) (segs[p.segment] = segs[p.segment] || []).push(p);
  const ext = p => [
    p.horizontalAccuracy != null ? `<tm:accuracy>${p.horizontalAccuracy.toFixed(1)}</tm:accuracy>` : '',
    p.speed != null ? `<tm:speed>${p.speed.toFixed(2)}</tm:speed>` : '',
    p.heading != null ? `<tm:heading>${p.heading.toFixed(1)}</tm:heading>` : '',
  ].join('');
  const trkpt = p => `<trkpt lat="${p.latitude.toFixed(7)}" lon="${p.longitude.toFixed(7)}">` +
    (p.altitude != null ? `<ele>${p.altitude.toFixed(1)}</ele>` : '') + `<time>${p.recordedAt}</time>` +
    `<extensions>${ext(p)}</extensions></trkpt>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="SkyRunZim ${xmlEsc(APP_VERSION)}" xmlns="http://www.topografix.com/GPX/1/1" xmlns:tm="https://nyanga-trail-map/gpx-ext/1">
<metadata><name>${xmlEsc(t.name)}</name><time>${t.startedAt}</time></metadata>
<trk><name>${xmlEsc(t.name)}</name>
${segs.filter(Boolean).map(s => `<trkseg>\n${s.map(trkpt).join('\n')}\n</trkseg>`).join('\n')}
</trk>
</gpx>
`;
}

function buildGeoJson(t, pts) {
  const segs = [];
  for (const p of pts) (segs[p.segment] = segs[p.segment] || []).push(p);
  const list = segs.filter(Boolean);
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { name: t.name, startedAt: t.startedAt, endedAt: t.endedAt, distanceM: Math.round(t.distanceM),
        points: t.points, movingTimeSec: Math.round(t.activeMs / 1000),
        times: list.map(s => s.map(p => p.recordedAt)), accuracyM: list.map(s => s.map(p => p.horizontalAccuracy)) },
      // GeoJSON order is [longitude, latitude, altitude].
      geometry: { type: 'MultiLineString', coordinates: list.map(s => s.map(p => p.altitude != null ? [p.longitude, p.latitude, p.altitude] : [p.longitude, p.latitude])) },
    }],
  };
}

async function saveFile(name, type, text) {
  const file = new File([text], name, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; }
    catch (err) { if (err.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(file), a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function exportTrack(id, kind) {
  toast('Preparing the file…', 2500);
  try {
    const t = (await getTracks()).find(x => x.id === id), pts = await getPoints(id);
    const base = 'run-' + t.startedAt.slice(0, 16).replace(/[:T]/g, '-');
    if (kind === 'gpx') await saveFile(base + '.gpx', 'application/gpx+xml', buildGpx(t, pts));
    else await saveFile(base + '.geojson', 'application/geo+json', JSON.stringify(buildGeoJson(t, pts)));
  } catch (err) { alert('Export failed: ' + (err.message || err)); }
}

let shownTrack = null;
async function showTrack(id) {
  if (shownTrack) shownTrack.remove();
  const pts = await getPoints(id);
  if (!pts.length) { toast('This recording has no points.'); return; }
  const segs = [];
  for (const p of pts) (segs[p.segment] = segs[p.segment] || []).push([p.latitude, p.longitude]);
  shownTrack = L.polyline(segs.filter(Boolean), { color: '#6a1b9a', weight: 4, opacity: 0.85, interactive: false }).addTo(map);
  closeSheet(); setFollow(false);
  map.fitBounds(shownTrack.getBounds(), { padding: [40, 40] });
}

async function renderTracks() {
  const list = $('trackList');
  let tracks = [];
  try { tracks = (await getTracks()).sort((a, b) => b.id - a.id); }
  catch (err) { list.innerHTML = `<div class="small">Could not open saved recordings: ${escapeHtml(err.message || err)}</div>`; return; }
  if (!tracks.length) { list.innerHTML = '<div class="small" style="margin-top:6px">No recordings yet. Tap the red button on the map to start.</div>'; return; }
  list.innerHTML = tracks.map(t => {
    const active = recorder.track && recorder.track.id === t.id;
    return `<div class="track" data-id="${t.id}">
      <b>${escapeHtml(t.name)}</b>${active ? ' <span class="badge warn">in progress</span>' : ''}
      <div class="small">${km(t.distanceM)} · ${fmtDur(activeMs(t))} · ${t.points} points</div>
      <div class="acts">
        <button class="pill" data-act="show">Show on map</button>
        <button class="pill" data-act="gpx">Export GPX</button>
        <button class="pill" data-act="geojson">Export GeoJSON</button>
        ${active ? '' : '<button class="pill danger" data-act="del">Delete</button>'}
      </div></div>`;
  }).join('');
}
$('trackList').onclick = async e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = +btn.closest('.track').dataset.id, act = btn.dataset.act;
  if (act === 'show') showTrack(id);
  else if (act === 'gpx' || act === 'geojson') exportTrack(id, act);
  else if (act === 'del' && confirm('Delete this recording? This cannot be undone.')) {
    await deleteTrack(id);
    if (shownTrack) { shownTrack.remove(); shownTrack = null; }
    renderTracks();
  }
};

// =====================================================================
// Offline map download
// =====================================================================
function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
}

// A function declaration, because the map is set up before this point.
function mapSaved(id = activeMap) { return pref('tilesSaved:' + id) === MAPS[id].tag; }

async function allTileUrls(id = activeMap) {
  const urls = []; let bytes = 0; const sets = {};
  for (const dir of MAPS[id].sets) {
    const idx = await (await fetchWithTimeout(`${dir}/index.json`, 15000)).json();
    idx.tiles.forEach(t => urls.push(`${dir}/${t}.webp`));
    bytes += idx.bytes; sets[dir] = idx.tiles.length;
  }
  return { urls, bytes, sets };
}

// Free space taken by pieces of maps this version no longer uses (once per version).
const CLEAN_TAG = ALL_TILE_SETS.join('+');
async function removeOldTiles() {
  if (pref('tilesCleaned') === CLEAN_TAG || !('caches' in window)) return;
  try {
    const cache = await caches.open(TILE_CACHE);
    for (const req of await cache.keys()) {
      const set = new URL(req.url).pathname.split('/').slice(-4)[0];
      if (set.startsWith('tiles') && !ALL_TILE_SETS.includes(set)) await cache.delete(req);
    }
    pref('tilesCleaned', CLEAN_TAG);
  } catch (err) { console.warn('Could not remove old map pieces', err); }
}

async function storageInfo() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try { return await navigator.storage.estimate(); } catch { return null; }
}

async function refreshOfflineStatus() {
  const chip = $('offlineChip'), saved = mapSaved(), m = MAPS[activeMap];
  chip.textContent = saved ? 'Saved offline ✓' : 'Map not saved offline';
  chip.className = 'chip ' + (saved ? 'good' : 'warn');
  if (saved) {
    $('dlText').textContent = `The ${m.name} is saved on this phone. It works with no signal.`;
    $('dlBtn').textContent = 'Check / repair offline map';
  } else {
    $('dlText').textContent = pref('tilesSaved:' + activeMap)
      ? `A newer ${m.name} is available. Download again on wifi to update it.`
      : `Download the ${m.name} (about ${m.approxMB} MB) once on wifi, then it works with no signal.`;
    $('dlBtn').textContent = 'Download map for offline';
  }
  $('dlDelete').hidden = !saved;
  const s = await storageInfo();
  $('storageText').textContent = s ? `This app is using ${(s.usage / 1e6).toFixed(0)} MB on this phone.` : '';
}

// Downloads every map piece, showing progress in the given button, bar and text.
// Returns true when the whole map is saved on the phone.
async function downloadMap(btn, bar, text, id = activeMap) {
  btn.disabled = true; bar.style.display = 'block';
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    text.innerHTML = `${SPIN}Starting download…`;
    const { urls, bytes } = await allTileUrls(id);
    const s = await storageInfo();
    if (s && s.quota && s.quota - s.usage < bytes * 1.5 &&
        !confirm(`This phone may not have enough free space for the map (${(bytes / 1e6).toFixed(0)} MB). Try anyway?`)) {
      throw new Error('Cancelled: not enough space');
    }
    const cache = await caches.open(TILE_CACHE);
    let done = 0, failed = 0, next = 0;
    const mb = (bytes / 1e6).toFixed(0);
    async function worker() {
      while (next < urls.length) {
        const url = urls[next++];
        // GitHub occasionally answers "busy" (about 1 piece in 3,000 in a load
        // test): try again after 1 s, then 3 s, before counting a piece as missing.
        for (let attempt = 0; ; attempt++) {
          try {
            if (!(await cache.match(url))) {
              const res = await fetchWithTimeout(url, 15000);
              if (!res.ok) throw new Error(res.status);
              await cache.put(url, res);
            }
            break;
          } catch {
            if (attempt === 2) { failed++; break; }
            await new Promise(r => setTimeout(r, attempt ? 3000 : 1000));
          }
        }
        done++;
        if (done % 10 === 0 || done === urls.length) {
          bar.firstElementChild.style.width = (100 * done / urls.length) + '%';
          text.innerHTML = `${SPIN}Downloading… ${done} of ${urls.length} pieces (about ${mb} MB in total)`;
        }
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker));
    // Check every piece really is on the phone before calling it saved.
    text.innerHTML = `${SPIN}Checking every piece is saved…`;
    const have = new Set((await cache.keys()).map(r => new URL(r.url).pathname.split('/').slice(-4).join('/')));
    const missing = urls.filter(u => !have.has(u.split('/').slice(-4).join('/'))).length;
    if (failed || missing) {
      text.textContent = `${Math.max(failed, missing)} pieces are missing. Check your connection and tap the button again; it carries on where it stopped.`;
    } else {
      // Free the space used by pieces of maps the app no longer uses. Pieces
      // of the other current maps are kept.
      // A piece is identified by "<set>/<z>/<x>/<y>.webp", the last 4 parts of its address.
      for (const req of await cache.keys()) {
        const key = new URL(req.url).pathname.split('/').slice(-4).join('/');
        if (key.startsWith('tiles') && !ALL_TILE_SETS.includes(key.split('/')[0])) await cache.delete(req);
      }
      pref('tilesSaved:' + id, MAPS[id].tag);
      text.textContent = 'Done. The map is saved on this phone.';
    }
  } catch (err) {
    text.textContent = 'Download failed: ' + (err.message || err) + '. Connect to the internet and try again.';
  }
  btn.disabled = false;
  refreshOfflineStatus();
  return mapSaved(id);
}
$('dlBtn').onclick = () => downloadMap($('dlBtn'), $('dlProgress'), $('dlText'));

$('dlDelete').onclick = async () => {
  if (!confirm('Delete the offline maps from this phone? You will need internet to download them again. Recordings are kept.')) return;
  await caches.delete(TILE_CACHE);
  try { ['tilesSaved', ...Object.keys(MAPS).map(k => 'tilesSaved:' + k)].forEach(k => localStorage.removeItem(k)); } catch {}
  $('dlBtn').textContent = 'Download map for offline';
  $('dlText').textContent = 'Offline map deleted. Download it again on wifi before the race.';
  refreshOfflineStatus();
};

// =====================================================================
// Race and route: each runner chooses their race at setup, and only that
// route is shown, so nobody follows another distance's route by mistake.
// =====================================================================
// Route points are projected to flat metres; fine at this scale (~40 km).
const LAT0 = -18.3, KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KY = 110574;
let course = null, courseLayer = null, lastAlong = null, races = [];
// The runner's details are kept on this phone and sent to race control, so the
// organisers can see every runner is ready (the setup screen says so).
const profile = (() => { try { return JSON.parse(pref('profile')) || {}; } catch { return {}; } })();
const saveProfile = () => pref('profile', JSON.stringify(profile));
// Accepted the current indemnity form (when, and which wording, go to race control).
const indemnityOk = () => !!(profile.indemnity && profile.indemnity.version === INDEMNITY_VERSION);

// =====================================================================
// Race control: every runner's name, bib, race and app readiness (NEVER
// their position) go to the organisers' dashboard
// (/dashboard/, database: supabase/schema.sql). The whole state is sent each
// time, so a send that fails for lack of signal is simply tried again later.
// =====================================================================
const RACE_CONTROL = { url: 'https://rmyqovbgcqgcvxwbpwgv.supabase.co', key: 'sb_publishable_8BAttBsLnJh--ADME9dMFA_0QHOg4qu' }; // public key
const phoneType = () => (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  ? 'iPhone' : /Android/i.test(navigator.userAgent) ? 'Android' : 'Other');

const sync = {
  timer: null, busy: false,
  deviceId() {
    if (!profile.deviceId) {
      profile.deviceId = crypto.randomUUID ? crypto.randomUUID()
        : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
      saveProfile();
    }
    return profile.deviceId;
  },
  state() {
    const r = races.find(x => x.id === profile.raceId);
    return {
      p_device: this.deviceId(), p_name: profile.name || '', p_bib: profile.bib || '', p_race: profile.raceId || '',
      p_setup: !!profile.setupDone, p_map: mapSaved((r && r.map) || 'nyanga'),
      p_location: gps.perm === 'granted' || !!gps.fix, p_app: APP_VERSION.split(' ')[0], p_phone: phoneType(),
      p_indemnity_at: indemnityOk() ? profile.indemnity.at : null, p_indemnity_ver: indemnityOk() ? profile.indemnity.version : null,
    };
  },
  // Several changes in a row become one send.
  soon(ms = 1500) { clearTimeout(this.timer); this.timer = setTimeout(() => this.send(), ms); },
  async send() {
    if (!profile.name || this.busy) return;
    this.busy = true;
    try {
      await loadRaceList().catch(() => {});
      const body = this.state(), sig = JSON.stringify(body);
      // Unchanged and sent within the hour: nothing to do (hourly = "last seen").
      if (sig === profile.syncedSig && Date.now() - (profile.syncedAt || 0) < 3600e3) return;
      await this.rpc('register_runner', body);
      Object.assign(profile, { syncedSig: sig, syncedAt: Date.now() }); saveProfile();
    } catch (err) {
      console.warn('[race control] not sent, will try again', err.message || err);
    } finally { this.busy = false; }
  },
  async rpc(fn, body) {
    const res = await fetch(`${RACE_CONTROL.url}/rest/v1/rpc/${fn}`, {
      method: 'POST', headers: { apikey: RACE_CONTROL.key, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${fn} ${res.status}`);
    return res;
  },
};

// Messages from race control: collected whenever there is signal, kept on the
// phone so they can be read offline, and shown once as a pop-up when new.
// "Read" is reported back (later, if there is no signal) for the dashboard.
const stored = (k, empty) => { try { return JSON.parse(pref(k)) || empty; } catch { return empty; } };
const inbox = {
  list: stored('messages', []), readIds: stored('msgRead', []), unsent: stored('msgReadUnsent', []), fetchedAt: 0,
  save() { pref('messages', JSON.stringify(this.list)); pref('msgRead', JSON.stringify(this.readIds)); pref('msgReadUnsent', JSON.stringify(this.unsent)); },
  // Every few minutes at most, unless asked now (start-up, reopening, signal back).
  async check(now = false) {
    if (!now && Date.now() - this.fetchedAt < 3 * 60e3) return;
    this.fetchedAt = Date.now();
    routeUpdates.check(now);   // a route change usually comes with a message
    try {
      const res = await sync.rpc('get_messages', { p_race: profile.raceId || '' });
      this.list = await res.json(); this.save(); this.render(); this.popup();
    } catch (err) { console.warn('[race control] messages not checked', err.message || err); }
    this.sendReads();
  },
  async sendReads() {
    if (!this.unsent.length) return;
    const ids = this.unsent.slice();
    try { await sync.rpc('mark_read', { p_device: sync.deviceId(), p_ids: ids }); this.unsent = this.unsent.filter(i => !ids.includes(i)); this.save(); }
    catch (err) { console.warn('[race control] read receipts not sent yet', err.message || err); }
  },
  unread() { return this.list.filter(m => !this.readIds.includes(m.id)); },
  html: m => `<div class="rcmsg"><small>${escapeHtml(new Date(m.created_at).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}` +
    ` · ${m.race_id ? 'Your race' : 'All runners'}</small>${escapeHtml(m.body)}</div>`,
  render() {
    $('msgList').innerHTML = this.list.length ? this.list.map(this.html).join('')
      : '<div class="small">No messages yet. New ones arrive whenever your phone has signal.</div>';
  },
  // Not over the setup screens: shown when setup is finished instead.
  popup() {
    const u = this.unread();
    if (!u.length || $('setup').classList.contains('open')) return;
    $('msgPopList').innerHTML = u.map(this.html).join('');
    $('msgPop').classList.add('open');
  },
  ok() {
    const ids = this.unread().map(m => m.id);
    this.readIds = [...this.readIds, ...ids].slice(-300); this.unsent.push(...ids); this.save();
    $('msgPop').classList.remove('open');
    this.sendReads();
  },
};
$('msgPopOk').onclick = () => inbox.ok();

// Phone notifications: race control messages arrive like a text, even with
// the app closed (when the phone has signal). The phone's push address is
// saved with save_push; supabase/functions/send-push wakes the phone, and
// sw.js collects and shows the message.
const VAPID_PUBLIC = 'BMPu63z_Rj9WjL7Kz1hYBj5tmTPu_4zZG-kyDNDGErBToRyKISIYxyzzF6UVjRHZ4gYIDOEclVwJGEyODuNFtm8';
const push = {
  supported: () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
  // granted / denied / default, or why it can't work on this phone.
  state() {
    if (this.supported()) return Notification.permission;
    return isIOS && !isStandalone ? 'ios-install' : 'unsupported';
  },
  on() { return this.state() === 'granted'; },
  text() {
    return {
      granted: profile.pushSig ? '🔔 Notifications are on: race messages reach you even when the app is closed (when you have signal).'
        : '🔔 Notifications allowed. Finishing setup next time you have signal.',
      default: 'Turn on notifications so race messages reach you like a text, even when the app is closed.',
      denied: 'Notifications are blocked for SkyRunZim. To get them, allow notifications for this app in your phone’s Settings. Messages still pop up when you open the app.',
      'ios-install': 'On iPhone, notifications only work when SkyRunZim is opened from its Home Screen icon. Messages still pop up when you open the app.',
      unsupported: 'This phone or browser can’t show notifications from the app. Messages still pop up when you open the app.',
    }[this.state()];
  },
  // Must be called from a tap (iPhones only allow the question after a tap).
  async enable() {
    if (!this.supported()) return false;
    pref('pushAsked', '1');
    await this.saveConfig();
    if (await Notification.requestPermission() === 'granted') {
      try { await this.subscribe(true); toast('Notifications are on.'); }
      catch (err) { console.warn('[push] not subscribed yet', err.message || err); }
    }
    this.render();
    return this.on();
  },
  async subscribe(force) {
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) ||
      await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(atob(VAPID_PUBLIC.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)) });
    const j = sub.toJSON(), sig = `${j.endpoint}|${profile.raceId || ''}`;
    if (!force && sig === profile.pushSig) return;
    await sync.rpc('save_push', { p_device: sync.deviceId(), p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_race: profile.raceId || '' });
    profile.pushSig = sig; saveProfile();
  },
  // Settings the offline worker needs to collect a message when a push arrives.
  async saveConfig() {
    try {
      const c = await caches.open('rc-config');
      await c.put('config', new Response(JSON.stringify({ url: RACE_CONTROL.url, key: RACE_CONTROL.key, race: profile.raceId || '' })));
      const newest = Math.max(0, ...inbox.list.map(m => m.id));   // messages already seen in the app aren't notified again
      const seen = await c.match('seen').then(r => (r ? r.json() : 0));
      if (newest > seen) await c.put('seen', new Response(JSON.stringify(newest)));
    } catch {}
  },
  async refresh() {
    await this.saveConfig();
    if (this.on()) try { await this.subscribe(false); } catch (err) { console.warn('[push] not saved yet, will try again', err.message || err); }
    this.render();
  },
  render() {
    $('pushText').textContent = this.text();
    $('pushBtn').style.display = this.state() === 'default' ? '' : 'none';   // .btn styling overrides "hidden"
    $('pushBanner').style.display = profile.setupDone && this.state() === 'default' && !pref('pushAsked') ? 'block' : 'none';
  },
};
$('pushBtn').onclick = () => push.enable();
$('pushYes').onclick = () => push.enable();
$('pushNo').onclick = () => { pref('pushAsked', '1'); push.render(); };
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', e => { if (e.data === 'check-messages') inbox.check(true); });

// Route updates from race control (the dashboard's Race settings tab). Any
// newer version of a race than the one that shipped with the app is
// downloaded when there is signal and kept on the phone, so it works offline.
const ROUTE_CACHE = 'rc-config', routeKey = id => `route/${id}.json`;
const routeUpdates = {
  list: stored('routeUpdates', {}),     // race id -> its line in the race list, for downloaded updates
  checkedAt: 0,
  async check(now = false) {
    if (!now && Date.now() - this.checkedAt < 3 * 60e3) return;
    this.checkedAt = Date.now();
    try {
      const bundled = await loadBundledRaces();
      const latest = await (await sync.rpc('get_route_updates', {})).json();
      let mine = false;
      for (const u of latest) {
        const base = bundled.find(r => r.id === u.race_id), have = this.list[u.race_id];
        if (!base || u.version <= Math.max(base.version, have ? have.version : 0)) continue;
        const route = await (await sync.rpc('get_route', { p_race: u.race_id })).json();
        if (!route || route.version !== u.version) continue;
        await (await caches.open(ROUTE_CACHE)).put(routeKey(u.race_id), new Response(JSON.stringify(route)));
        this.list[u.race_id] = { ...base, ...u.summary, file: base.file, fromRaceControl: true };
        if (u.race_id === profile.raceId) mine = true;
      }
      pref('routeUpdates', JSON.stringify(this.list));
      races = [];                                        // rebuild the race list with the updates
      if (mine && profile.setupDone) await showRace(profile.raceId);   // shows "route has been updated"
      if (mine) sync.soon();
    } catch (err) { console.warn('[race control] route updates not checked', err.message || err); }
  },
  async route(id) {
    try { const r = await (await caches.open(ROUTE_CACHE)).match(routeKey(id)); return r ? await r.json() : null; } catch { return null; }
  },
};

let bundledRaces = null;
async function loadBundledRaces() {
  if (bundledRaces) return bundledRaces;
  const res = await fetch('data/races/index.json');
  if (!res.ok) throw new Error('race list not available (' + res.status + ')');
  return (bundledRaces = await res.json());
}
// The race list: what shipped with the app, with any newer routes from race control.
async function loadRaceList() {
  if (races.length) return races;
  races = (await loadBundledRaces()).map(r => {
    const u = routeUpdates.list[r.id];
    return u && u.version > r.version ? u : r;
  });
  return races;
}

async function showRace(id) {
  $('raceChip').innerHTML = `${SPIN}Loading your race…`;
  let info = (await loadRaceList()).find(r => r.id === id);
  if (!info) throw new Error('Your race is no longer in the app. Please choose your race again.');
  const mapChanged = setMap(info.map || 'nyanga');
  let data = info.fromRaceControl ? await routeUpdates.route(id) : null;
  if (info.fromRaceControl && !data) {
    // The downloaded update has gone from the phone: use the route that shipped with the app.
    delete routeUpdates.list[id]; pref('routeUpdates', JSON.stringify(routeUpdates.list));
    races = []; info = (await loadRaceList()).find(r => r.id === id);
  }
  if (!data) {
    const res = await fetch(info.file);
    if (!res.ok) throw new Error('route not available (' + res.status + ')');
    data = await res.json();
  }
  course = prepareCourse(data);
  course.info = info;
  // Progress along the route is remembered on the phone, so that after a
  // restart the app still knows which pass of a repeated stretch the runner is on.
  try { const p = JSON.parse(pref('progress')); lastAlong = p && p.race === id && p.version === info.version ? { s: p.s, along: p.along } : null; }
  catch { lastAlong = null; }
  drawCourse();
  // A corrected route comes with an app update or from race control.
  if (profile.raceVersion && profile.raceVersion !== info.version) toast(`Your route for ${info.name} has been updated to the latest version.`, 6000);
  profile.raceVersion = info.version; saveProfile();
  renderRaceInfo();
  if (mapChanged) fitArea(L.latLngBounds(course.pts.map(p => [p[0], p[1]])));
}

function renderRaceInfo() {
  const info = course && course.info;
  $('raceChip').textContent = info ? `${info.name} · ${info.distanceKm} km` : 'Choose your race';
  const rows = [
    ['Name', profile.name || '-'],
    ['Bib number', profile.bib || '-'],
    ['Race', info ? `${info.name}, ${info.stages ? info.stages.length + ' days, ' : ''}${info.distanceKm} km, ${info.climbM} m climb` : 'Not chosen'],
    ['Route version', info ? String(info.version) : '-'],
    ['Indemnity form', indemnityOk() ? 'Accepted ' + new Date(profile.indemnity.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Not accepted'],
  ];
  $('raceText').innerHTML = rows.map(([k, v]) => `<div class="row"><span>${escapeHtml(k)}</span><b>${escapeHtml(v)}</b></div>`).join('');
}

// A race has one or more stages (one per day for multi-day races). Each stage
// is followed separately; nothing is drawn or measured between stages.
function prepareStage(st) {
  const xy = st.pts.map(([lat, lon]) => [lon * KX, lat * KY]);
  const cum = [0];
  for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  // Climb still to come from each point to the end of the stage. Height
  // changes under 5 m are ignored so small wobbles don't inflate it.
  const climbLeft = new Array(st.pts.length).fill(0);
  const hasEle = st.pts.every(p => p[2] != null);
  if (hasEle) {
    let ref = st.pts[st.pts.length - 1][2], acc = 0;
    for (let i = st.pts.length - 2; i >= 0; i--) {
      const e = st.pts[i][2];
      if (ref - e >= 5) { acc += ref - e; ref = e; } else if (e > ref) ref = e;
      climbLeft[i] = acc;
    }
  }
  return { ...st, xy, cum, total: cum[cum.length - 1], climbLeft, hasEle };
}

function prepareCourse(c) {
  const stages = (c.stages || [{ name: c.name, short: '', pts: c.pts }]).map(prepareStage);
  // Each checkpoint belongs to the stage it is closest to.
  const wpts = (c.wpts || []).map(w => {
    const near = stages.map(st => nearestOnCourse(st, w.lat, w.lon));
    const s = near.reduce((b, n, k) => (n.d < near[b].d ? k : b), 0);
    return { ...w, stage: s, along: near[s].along };
  }).sort((a, b) => a.stage - b.stage || a.along - b.along);
  return { ...c, stages, wpts, pts: stages.flatMap(st => st.pts) };
}

// Finds the closest point on a stage. Where the route passes the same spot
// twice, prefer the pass closest to where the runner was last seen.
function nearestOnCourse(st, lat, lon, prevAlong = null) {
  const px = lon * KX, py = lat * KY;
  const hits = [];
  for (let i = 0; i < st.xy.length - 1; i++) {
    const [ax, ay] = st.xy[i], [bx, by] = st.xy[i + 1];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    const qx = ax + t * dx, qy = ay + t * dy;
    hits.push({ i, t, d: Math.hypot(px - qx, py - qy), along: st.cum[i] + t * Math.sqrt(len2), qx, qy });
  }
  let best = hits.reduce((a, b) => (b.d < a.d ? b : a));
  if (prevAlong != null) {
    const near = hits.filter(h => h.d < best.d + 40);
    best = near.reduce((a, b) => (Math.abs(b.along - prevAlong) < Math.abs(a.along - prevAlong) ? b : a));
  }
  best.bearing = (Math.atan2(best.qx - px, best.qy - py) * 180 / Math.PI + 360) % 360;
  return best;
}

const km = m => (m / 1000).toFixed(m < 10000 ? 2 : 1) + ' km';
const CHECKPOINT_ICON = { water: '💧', station: '★', point: '◆' };

// A point (and the direction of travel there) a given distance along a stage.
function alongPoint(st, dist) {
  let i = 0;
  while (i < st.cum.length - 2 && st.cum[i + 1] < dist) i++;
  const seg = st.cum[i + 1] - st.cum[i], t = seg ? (dist - st.cum[i]) / seg : 0;
  const [a, b] = [st.pts[i], st.pts[i + 1]];
  const bearing = (Math.atan2(st.xy[i + 1][0] - st.xy[i][0], st.xy[i + 1][1] - st.xy[i][1]) * 180 / Math.PI + 360) % 360;
  return { lat: a[0] + t * (b[0] - a[0]), lon: a[1] + t * (b[1] - a[1]), bearing };
}

function drawCourse() {
  if (courseLayer) courseLayer.remove();
  if (!course) return;
  courseLayer = L.layerGroup();
  for (const st of course.stages) {
    const ll = st.pts.map(p => [p[0], p[1]]);
    courseLayer.addLayer(L.polyline(ll, { color: '#fff', weight: 7, opacity: 0.9, interactive: false }));
    courseLayer.addLayer(L.polyline(ll, { color: '#e65100', weight: 4, interactive: false }));
    // Direction arrows every 400 m, so loops and out-and-backs are clear.
    for (let d = 200; d < st.total; d += 400) {
      if (d % 1000 < 150 || d % 1000 > 850) continue; // keep clear of km markers
      const p = alongPoint(st, d);
      courseLayer.addLayer(L.marker([p.lat, p.lon], { interactive: false, icon: L.divIcon({ className: '', iconSize: [0, 0],
        html: `<div class="lbl arrow" style="transform: translate(-50%, -50%) rotate(${p.bearing.toFixed(0)}deg)">▲</div>` }) }));
    }
    for (let k = 1000; k < st.total; k += 1000) {
      const p = alongPoint(st, k);
      courseLayer.addLayer(L.marker([p.lat, p.lon], { icon: label(String(k / 1000), 'km'), interactive: false }));
    }
    // Loops start and finish in the same place, so they get one label.
    const prefix = st.short ? escapeHtml(st.short) + ' ' : '';
    const isLoop = map.distance(ll[0], ll[ll.length - 1]) < 150;
    if (isLoop) courseLayer.addLayer(L.marker(ll[0], { icon: label(prefix + 'START / FINISH', 'wpt'), interactive: false }));
    else {
      courseLayer.addLayer(L.marker(ll[0], { icon: label(prefix + 'START', 'wpt'), interactive: false }));
      courseLayer.addLayer(L.marker(ll[ll.length - 1], { icon: label(prefix + 'FINISH', 'wpt'), interactive: false }));
    }
  }
  for (const w of course.wpts) {
    const html = `<span class="ico">${CHECKPOINT_ICON[w.kind] || '◆'}</span><span class="nm"> ${escapeHtml(w.name)}</span>`;
    courseLayer.addLayer(L.marker([w.lat, w.lon], { icon: label(html, 'wpt cp-' + (w.kind || 'point')), interactive: false }));
  }
  courseLayer.addTo(map);
  $('courseInfo').hidden = false;
  updateCourse();
}

function updateCourse() {
  if (!course) return;
  const f = gps.fix, multi = course.stages.length > 1;
  if (!f) {
    const info = course.info;
    $('courseStatus').textContent = info ? info.name : 'Route loaded'; $('courseStatus').className = 'course-status';
    $('courseDone').textContent = info ? `${multi ? course.stages.length + ' days · ' : 'Total '}${info.distanceKm} km` : '';
    $('courseLeft').textContent = info ? `${info.climbM} m climb` : '';
    $('courseDir').textContent = ''; $('courseNext').textContent = '';
    return;
  }
  // Find the stage the runner is on: the nearest one, but stay on the last
  // stage they were following unless another is clearly closer.
  const near = course.stages.map((st, s) => nearestOnCourse(st, f.lat, f.lon, lastAlong && lastAlong.s === s ? lastAlong.along : null));
  let s = near.reduce((b, n, k) => (n.d < near[b].d ? k : b), 0);
  if (lastAlong && near[lastAlong.s].d <= near[s].d + 40) s = lastAlong.s;
  const st = course.stages[s], n = near[s];
  const tolerance = Math.max(40, f.acc + 15);
  const onCourse = n.d <= tolerance;
  if (onCourse) {
    lastAlong = { s, along: n.along };
    pref('progress', JSON.stringify({ race: course.info && course.info.id, version: course.info && course.info.version, s, along: Math.round(n.along) }));
  }
  const prefix = multi ? `${st.short}: ` : '';
  const el = $('courseStatus');
  // Metres when close; kilometres once more than 1 km away.
  const off = n.d < 1000 ? `${Math.round(n.d)} m` : `${(n.d / 1000).toFixed(n.d < 10000 ? 1 : 0)} km`;
  el.textContent = onCourse ? '✓ On your route' : `⚠ ${off} off your route`;
  el.className = 'course-status ' + (onCourse ? 'ok' : 'off');
  $('courseDir').textContent = onCourse ? '' : `Your route is ${compassPoint(n.bearing)} of you`;
  $('courseDone').textContent = `${prefix}${km(n.along)} done`;
  const climb = st.hasEle ? ` · ${Math.round(st.climbLeft[n.i])} m climb left` : '';
  $('courseLeft').textContent = `${km(st.total - n.along)} to go${climb}`;
  const next = course.wpts.find(w => w.stage === s && w.along > n.along + 20);
  $('courseNext').textContent = next ? `Next: ${CHECKPOINT_ICON[next.kind] || '◆'} ${next.name} in ${km(next.along - n.along)}` : '';
}

// ---------- First-time setup ----------
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

const setup = {
  step: 'welcome', picked: null, changing: false,

  open(step = 'welcome', changing = false) {
    Object.assign(this, { step, changing, picked: changing ? null : this.picked });
    closeSheet();
    $('setup').classList.add('open');
    this.render();
  },
  close() { $('setup').classList.remove('open'); },
  go(step) { this.step = step; this.render(); $('setupBody').scrollTo({ top: 0 }); },

  async finish() {
    profile.setupDone = true;
    profile.raceId = this.picked;
    saveProfile();
    sync.soon();
    this.close();
    inbox.check(true);   // the new race may have its own messages; shows any waiting
    push.refresh();      // notifications follow the new race
    try {
      await showRace(profile.raceId);
      setFollow(false);
      fitArea(L.latLngBounds(course.pts.map(p => [p[0], p[1]])));
    } catch (err) { renderRaceInfo(); alert(err.message || err); }
  },

  render() {
    const b = $('setupBody'), steps = ['welcome', 'indemnity', 'details', 'race', 'map', 'location', 'alerts', 'ready'];
    $('setupStep').textContent = this.changing ? '' : `Step ${steps.indexOf(this.step) + 1} of ${steps.length}`;
    const html = this[this.step]();
    b.innerHTML = html;
    if (this['wire_' + this.step]) this['wire_' + this.step]();
  },

  welcome() {
    const iphoneWarning = isIOS && !isStandalone ? `
      <div class="note warnbox"><b>iPhone: add to Home Screen first.</b> Tap the Share button, then <b>Add to Home Screen</b>.
      Close Safari and open the app from the new icon, then set up there. Anything set up here in Safari does not carry over to the icon.</div>` : '';
    return `<h2>Welcome to SkyRunZim</h2>
      <p>This app shows your position and your race route on the official race map, with no phone signal needed.</p>
      <p>Setup takes about 3 minutes. <b>Use wifi</b>: the map download is about 30 to 45 MB.</p>${iphoneWarning}
      <button class="btn" data-go="details">${isIOS && !isStandalone ? 'Set up in Safari anyway' : 'Start'}</button>`;
  },
  wire_welcome() { $('setupBody').querySelector('[data-go]').onclick = () => this.go(indemnityOk() ? 'details' : 'indemnity'); },

  // The organisers' indemnity form: read to the end, acknowledge, then confirm
  // again in a box of its own, for anyone who skimmed it. There is no way past it.
  indemnity() {
    return `<h2>Indemnity form</h2>
      <p>Every runner must read and accept this before taking part.${this.changing ? ' It is new since you set up the app.' : ''}</p>
      <div class="indem" id="indemText">${SPIN}Loading the form…</div>
      <button class="btn" id="indemAck" disabled>Acknowledge and proceed</button>
      ${this.changing ? '' : '<button class="btn secondary" id="suBack">Back</button>'}`;
  },
  async wire_indemnity() {
    const box = $('indemText'), ack = $('indemAck');
    if ($('suBack')) $('suBack').onclick = () => this.go('welcome');
    ack.onclick = () => $('indemPop').classList.add('open');
    try {
      const res = await fetch('data/indemnity.html');
      if (!res.ok) throw new Error('status ' + res.status);
      box.innerHTML = await res.text();
      ack.disabled = false;
    } catch (err) {
      box.textContent = 'The form could not be opened (' + (err.message || err) + '). Close the app, connect to the internet and open it again.';
    }
  },
  acceptIndemnity() {
    $('indemPop').classList.remove('open');
    profile.indemnity = { version: INDEMNITY_VERSION, at: new Date().toISOString() };
    saveProfile();
    sync.soon();
    if (this.changing) { this.close(); renderRaceInfo(); toast('Thank you. The indemnity form is accepted.'); } else this.go('details');
  },

  details() {
    return `<h2>Your details</h2>
      <p class="small">Saved on this phone and used on your recordings.</p>
      <label class="field">Your name<input id="suName" autocomplete="name" value="${escapeHtml(profile.name || '')}"></label>
      <label class="field">Bib number (optional)<input id="suBib" inputmode="numeric" value="${escapeHtml(profile.bib || '')}"></label>
      <p class="tick">Your name, bib, race and whether the app is ready (map saved, location on) are sent to the race organisers,
        so they can check every runner is set up before race day. <b>Your location is never shared.</b></p>
      <button class="btn" id="suNext">${this.changing ? 'Save' : 'Next'}</button>
      ${this.changing ? '<button class="btn secondary" id="suCancel">Cancel</button>' : '<button class="btn secondary" id="suBack">Back</button>'}`;
  },
  wire_details() {
    const name = $('suName'), next = $('suNext');
    const check = () => { next.disabled = !name.value.trim(); };
    name.oninput = check; check();
    next.onclick = () => {
      profile.name = name.value.trim(); profile.bib = $('suBib').value.trim(); saveProfile();
      if (this.changing) sync.soon();
      if (this.changing) { this.close(); renderRaceInfo(); toast('Details saved.'); } else this.go('race');
    };
    if ($('suBack')) $('suBack').onclick = () => this.go('indemnity');
    if ($('suCancel')) $('suCancel').onclick = () => this.close();
  },

  race() {
    return `<h2>Choose your race</h2>
      <p class="small">Only your race's route will be shown on the map. Check you pick the distance you entered.</p>
      <div id="raceCards">${SPIN}Loading races…</div>
      <button class="btn" id="suConfirm" disabled>Choose a race above</button>
      <button class="btn secondary" id="suBack">${this.changing ? 'Cancel' : 'Back'}</button>`;
  },
  async wire_race() {
    $('suBack').onclick = () => (this.changing ? this.close() : this.go('details'));
    let list;
    try { list = await loadRaceList(); }
    catch (err) { $('raceCards').textContent = 'Could not load the races: ' + (err.message || err) + '. Connect to the internet and try again.'; return; }
    const days = r => (r.stages ? `<span class="days">${r.stages.map(s => `${escapeHtml(s.name)}: ${s.distanceKm} km`).join('<br>')}</span>` : '');
    const card = r => `<button class="racecard${this.picked === r.id ? ' picked' : ''}" data-id="${escapeHtml(r.id)}">
      ${r.practice ? '<span class="practice">Practice run</span>' : ''}<b>${escapeHtml(r.name)}</b><span>${r.stages ? r.stages.length + ' days · ' : ''}${r.distanceKm} km · ${r.climbM} m climb${r.start ? ' · start ' + escapeHtml(r.start) : ''}${r.checkpoints ? ` · ${r.checkpoints} checkpoints` : ''}</span>${days(r)}</button>`;
    $('raceCards').innerHTML = list.map(card).join('');
    const confirmBtn = $('suConfirm');
    const update = () => {
      const r = list.find(x => x.id === this.picked);
      confirmBtn.disabled = !r;
      confirmBtn.textContent = r ? `I am running ${r.name} (${r.distanceKm} km)` : 'Choose a race above';
      $('raceCards').querySelectorAll('.racecard').forEach(el => el.classList.toggle('picked', el.dataset.id === this.picked));
    };
    $('raceCards').onclick = e => { const el = e.target.closest('.racecard'); if (el) { this.picked = el.dataset.id; update(); } };
    update();
    confirmBtn.onclick = () => {
      if (this.changing) {
        const r = list.find(x => x.id === this.picked);
        if (!confirm(`Change your race to ${r.name} (${r.distanceKm} km)? Only that route will be shown.`)) return;
        if (mapSaved(this.mapId())) this.finish(); else this.go('map');
      } else this.go('map');
    };
  },

  // The map the chosen race uses.
  mapId() { const r = races.find(x => x.id === this.picked); return (r && r.map) || 'nyanga'; },

  map() {
    const id = this.mapId(), m = MAPS[id], saved = mapSaved(id);
    return `<h2>Save the ${m.name} on your phone</h2>
      <p>The map must be saved on your phone so it works with no signal.</p>
      <div class="small" id="suDlText">${saved ? 'This map is already saved on this phone ✓' : `About ${m.approxMB} MB. Use wifi.`}</div>
      <div class="progress" id="suDlBar"><div></div></div>
      ${saved ? '' : '<button class="btn" id="suDl">Download the map</button>'}
      <button class="btn${saved ? '' : ' secondary'}" id="suNext"${saved ? '' : ' hidden'}>Next</button>
      ${saved ? '' : '<button class="linkbtn" id="suSkip">Skip for now (not recommended)</button>'}`;
  },
  wire_map() {
    const next = () => (this.changing ? this.finish() : this.go('location'));
    $('suNext').onclick = next;
    if ($('suSkip')) $('suSkip').onclick = () => {
      if (confirm('Without the saved map, the app will not work with no signal. You can download it later from the menu. Skip for now?')) next();
    };
    if ($('suDl')) $('suDl').onclick = async () => {
      const ok = await downloadMap($('suDl'), $('suDlBar'), $('suDlText'), this.mapId());
      if (ok) { $('suDl').hidden = true; $('suSkip').hidden = true; const n = $('suNext'); n.hidden = false; n.classList.remove('secondary'); }
    };
  },

  location() {
    return `<h2>Allow your location</h2>
      <p>The app uses your phone's GPS to show where you are. GPS works without signal. Your location never leaves your phone.</p>
      <div class="small" id="suGps"></div>
      <button class="btn" id="suGpsBtn">Allow location</button>
      <button class="btn secondary" id="suNext">Next</button>`;
  },
  wire_location() {
    $('suGpsBtn').onclick = () => { startGps(); askCompass(); };
    $('suNext').onclick = () => this.go('alerts');
    this.tick();
  },
  // Called every second while setup is open, to show live GPS status.
  tick() {
    const el = document.getElementById('suGps');
    if (!el || this.step !== 'location') return;
    if (gps.state === 'denied') el.textContent = '✕ Location is blocked. You can allow it later in your phone settings; see Details on the map screen.';
    else if (gps.fix) el.textContent = `✓ Location found (±${Math.round(gps.fix.acc)} m)`;
    else if (gps.state === 'searching') {
      const s = secondsSince(gps.searchSince || Date.now());
      el.innerHTML = `${SPIN}Looking for GPS… ${s} s. If your phone asked for permission, tap Allow.` +
        (s >= 15 ? '<br>This can take a minute or two, especially indoors. You can tap <b>Next</b>: it keeps looking in the background.' : '');
    } else el.textContent = 'Tap "Allow location" and accept when your phone asks.';
  },

  alerts() {
    const ask = push.state() === 'default';
    return `<h2>Messages from race control</h2>
      <p>The organisers send updates here: start times, weather, route changes. With notifications on, they reach you like a text, even when the app is closed.</p>
      <div class="small" id="suPush">${escapeHtml(push.text())}</div>
      ${ask ? '<button class="btn" id="suPushBtn">🔔 Turn on notifications</button>' : ''}
      <button class="btn${ask ? ' secondary' : ''}" id="suNext">${ask ? 'Not now' : 'Next'}</button>
      <button class="btn secondary" id="suBack">Back</button>`;
  },
  wire_alerts() {
    if ($('suPushBtn')) $('suPushBtn').onclick = async () => { await push.enable(); this.render(); };
    $('suNext').onclick = () => this.go('ready');
    $('suBack').onclick = () => this.go('location');
  },

  ready() {
    const r = races.find(x => x.id === this.picked);
    const row = (ok, text) => `<div class="check ${ok ? 'ok' : 'warn'}">${ok ? '✓' : '⚠'} ${text}</div>`;
    return `<h2>Ready to race</h2>
      ${row(indemnityOk(), indemnityOk() ? 'Indemnity form accepted' : 'Indemnity form not accepted')}
      ${row(!!profile.name, `Name: ${escapeHtml(profile.name || 'not given')}${profile.bib ? ', bib ' + escapeHtml(profile.bib) : ''}`)}
      ${row(!!r, r ? `Race: ${escapeHtml(r.name)}, ${r.distanceKm} km` : 'No race chosen')}
      ${row(mapSaved(this.mapId()), mapSaved(this.mapId()) ? 'Map saved for offline use' : 'Map NOT saved: download it from the menu before you go')}
      ${row(!!gps.fix, gps.fix ? 'Location working' : 'Location not found yet: it will keep looking')}
      ${row(push.on(), push.on() ? 'Notifications on' : 'Notifications off: you can turn them on in the menu')}      <p class="small">Keep the app open on screen while you run. It is a navigation aid: follow the course markings and marshals.</p>
      <button class="btn" id="suDone">Open my map</button>
      <button class="btn secondary" id="suBack">Back</button>`;
  },
  wire_ready() {
    $('suDone').onclick = () => this.finish();
    $('suBack').onclick = () => this.go('alerts');
  },
};

$('indemYes').onclick = () => setup.acceptIndemnity();
$('indemNo').onclick = () => $('indemPop').classList.remove('open');
$('changeRaceBtn').onclick = () => setup.open('race', true);
$('editDetailsBtn').onclick = () => setup.open('details', true);
$('raceChip').onclick = () => openSheet();

// =====================================================================
// Screen wake lock, debug overlay, menu
// =====================================================================
let wakeLock = null;
async function setWake(on) {
  try {
    if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch {}
}
$('wakeToggle').onchange = e => setWake(e.target.checked);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && $('wakeToggle').checked) setWake(true);
});
if (!('wakeLock' in navigator)) $('wakeToggle').disabled = true;

let tileCounts = '';
function renderDebug() {
  const on = $('debugToggle').checked;
  $('debug').style.display = on ? 'block' : 'none';
  if (!on) return;
  const f = gps.fix, c = map.getCenter(), h = currentHeading();
  const lines = [
    `lat/lon  ${f ? `${f.lat.toFixed(7)}, ${f.lon.toFixed(7)}` : '-'}`,
    `accuracy ${f ? `±${f.acc.toFixed(1)} m` : '-'}   alt ${f && f.alt != null ? f.alt.toFixed(1) + ' m' : '-'}`,
    `heading  gps ${f && f.heading != null ? f.heading.toFixed(0) : '-'} · compass ${compass.deg != null ? compass.deg.toFixed(0) : '-'} · used ${h ? h.src : 'none'}`,
    `speed    ${f && f.speed != null ? f.speed.toFixed(2) + ' m/s' : '-'}`,
    `age      ${f ? freshness(f).age.toFixed(1) + ' s (' + freshness(f).level + ')' : '-'}`,
    `zoom     ${map.getZoom()}   centre ${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`,
    `inside   map ${f ? raceBounds.contains([f.lat, f.lon]) : '-'}`,
    `gps      ${gps.state} · perm ${gps.perm} · follow ${gps.follow}`,
    `rec      ${recorder.status}${recorder.track ? ` #${recorder.track.id} ${recorder.track.points} pts` : ''}`,
    `app      ${APP_VERSION} · map ${activeMap} (${MAPS[activeMap].tag}) · saved ${mapSaved()}`,
    `pieces   ${tileCounts || '…'}`,
    `race src sha256 ${RACE_SOURCE_SHA256.slice(0, 16)}…`,
  ];
  $('debug').textContent = lines.join('\n');
}
$('debugToggle').onchange = e => {
  pref('debug', e.target.checked ? '1' : '0');
  if (e.target.checked && !tileCounts) {
    allTileUrls().then(r => { tileCounts = Object.entries(r.sets).map(([k, v]) => `${k} ${v}`).join(' · '); }).catch(() => { tileCounts = 'offline'; });
  }
  renderDebug();
};

// Emergency and medical guide: the race's official guide, loaded only when opened.
let medLoaded = false;
async function openMedical() {
  $('medical').classList.add('open');
  if (medLoaded) return;
  $('medContent').innerHTML = `${SPIN}Loading the guide…`;
  try {
    const res = await fetch('data/medical.html');
    if (!res.ok) throw new Error('status ' + res.status);
    $('medContent').innerHTML = await res.text();
    medLoaded = true;
  } catch (err) {
    $('medContent').textContent = 'The medical guide could not be opened (' + (err.message || err) + '). Open the app once with internet so it is saved on this phone.';
  }
}
$('medBtn').onclick = () => { closeSheet(); openMedical(); };
$('medClose').onclick = () => $('medical').classList.remove('open');
$('medTop').onclick = () => $('medBody').scrollTo({ top: 0 });
// The guide's own "jump to" buttons scroll within the guide; diagrams enlarge on tap.
$('medBody').addEventListener('click', e => {
  const fig = e.target.closest('.med-img');
  if (fig) { fig.classList.toggle('zoomed'); return; }
  const a = e.target.closest('a[href^="#med-"]');
  if (!a) return;
  e.preventDefault();
  const target = document.getElementById(a.getAttribute('href').slice(1));
  if (target) target.scrollIntoView({ block: 'start' });
});

function openSheet() {
  renderTracks(); refreshOfflineStatus(); renderCompass();
  $('sheetBg').style.display = 'block'; requestAnimationFrame(() => $('sheet').classList.add('open'));
}
function closeSheet() { $('sheet').classList.remove('open'); setTimeout(() => ($('sheetBg').style.display = 'none'), 200); }
$('menuBtn').onclick = openSheet;
$('closeSheet').onclick = closeSheet;
$('sheetBg').onclick = closeSheet;

// Keep the side buttons just above the bottom panel as it grows and shrinks.
const fitButtons = () => document.documentElement.style.setProperty('--panel-h', $('panel').offsetHeight + 'px');
if ('ResizeObserver' in window) new ResizeObserver(fitButtons).observe($('panel'));
fitButtons();

// =====================================================================
// Start up: local data only, never waits on the network
// =====================================================================
try { localStorage.removeItem('course'); } catch {} // courses loaded by hand in earlier versions
renderRaceInfo();
if (profile.setupDone && profile.raceId) {
  showRace(profile.raceId).catch(err => { renderRaceInfo(); toast(err.message || String(err), 6000); setup.open('race', true); });
  // Set up before the indemnity form was in the app (or its wording changed): accept it first.
  if (!indemnityOk()) setup.open('indemnity', true);
} else {
  setup.open('welcome');
}
// Earlier versions kept one saved flag for the Nyanga map only.
if (['turaco2026', 'contours2+turaco2026'].includes(pref('tilesSaved'))) { pref('tilesSaved:nyanga', MAPS.nyanga.tag); try { localStorage.removeItem('tilesSaved'); } catch {} }
removeOldTiles();
refreshOfflineStatus();
startCompass();
if (pref('debug') === '1') { $('debugToggle').checked = true; $('debugToggle').onchange({ target: $('debugToggle') }); }
if (pref('gpsOn') === '1') startGps();
renderGps();
recorder.recover().catch(err => console.error('Could not check for unfinished recording', err));
setInterval(() => { renderGps(); renderRec(); renderDebug(); setup.tick(); }, 1000);
// Race control: check in at start-up, when signal returns, on reopening, and
// once a minute (a send only happens when something changed, or hourly).
sync.soon(4000);
inbox.render();
setTimeout(() => inbox.check(true), 4500);
addEventListener('online', () => { sync.soon(); inbox.check(true); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { sync.soon(); inbox.check(true); } });
setInterval(() => { sync.send(); inbox.check(); push.refresh(); }, 60000);
push.render();
setTimeout(() => push.refresh(), 5000);
// The app is running: take down the start-up screen.
$('boot').remove();

// =====================================================================
// Service worker
// =====================================================================
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) $('updateBanner').style.display = 'block';
      });
    });
  }).catch(err => console.warn('Service worker failed', err));
  // Never reload by itself mid-run: the runner chooses when.
  $('updateBtn').onclick = () => {
    if (recorder.status === 'recording' && !confirm('A recording is running. It will be paused and can be resumed after the update. Update now?')) return;
    location.reload();
  };
}
