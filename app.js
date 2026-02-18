// Run Tracker — with aerial map route using Leaflet
// Tracks: time, distance (feet/miles), pace, speed, route on map
// Noise filtering: min accuracy + min movement

const UI = {
  status: document.getElementById("status"),
  time: document.getElementById("time"),
  miles: document.getElementById("miles"),
  feet: document.getElementById("feet"),
  pace: document.getElementById("pace"),
  speed: document.getElementById("speed"),
  points: document.getElementById("points"),
  accuracy: document.getElementById("accuracy"),

  startBtn: document.getElementById("startBtn"),
  pauseBtn: document.getElementById("pauseBtn"),
  resumeBtn: document.getElementById("resumeBtn"),
  stopBtn: document.getElementById("stopBtn"),
  clearBtn: document.getElementById("clearBtn"),

  recenterBtn: document.getElementById("recenterBtn"),
  exportGpxBtn: document.getElementById("exportGpxBtn"),
  exportJsonBtn: document.getElementById("exportJsonBtn"),
  copySummaryBtn: document.getElementById("copySummaryBtn"),
};

const SETTINGS = {
  MAX_ACCURACY_M: 50,  // ignore GPS points worse than this
  MIN_STEP_M: 5,       // ignore tiny jitter
};

let watchId = null;
let state = resetState();

// --- Leaflet map objects ---
let map = null;
let routeLine = null;
let startMarker = null;
let endMarker = null;
let currentMarker = null;
let accuracyCircle = null;
let lastLatLng = null;

function resetState() {
  return {
    running: false,
    paused: false,
    startedAtMs: 0,
    pausedAtMs: 0,
    totalPausedMs: 0,

    points: [],      // {lat, lon, t, acc, alt?, spd?}
    distanceM: 0,
    lastAccepted: null,
  };
}

function setStatus(msg) {
  UI.status.textContent = msg;
}

function fmtTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function metersToMiles(m) { return m / 1609.344; }
function metersToFeet(m) { return m * 3.280839895; }

function fmtPace(minPerMile) {
  if (!isFinite(minPerMile) || minPerMile <= 0) return "--:-- /mi";
  const totalSec = Math.round(minPerMile * 60);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${mm}:${String(ss).padStart(2, "0")} /mi`;
}

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  const h = s1 * s1 + Math.cos(lat1) * Math.cos(lat2) * s2 * s2;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return R * c;
}

function nowMs() { return Date.now(); }

function elapsedRunMs() {
  if (!state.startedAtMs) return 0;
  const end = state.paused ? state.pausedAtMs : nowMs();
  return Math.max(0, end - state.startedAtMs - state.totalPausedMs);
}

function updateUI() {
  const ms = elapsedRunMs();
  UI.time.textContent = fmtTime(ms);

  const miles = metersToMiles(state.distanceM);
  UI.miles.textContent = `${miles.toFixed(3)} mi`;
  UI.feet.textContent = `${Math.round(metersToFeet(state.distanceM))} ft`;

  const mins = ms / 60000;
  const pace = miles > 0 ? (mins / miles) : Infinity;
  UI.pace.textContent = fmtPace(pace);

  const hours = ms / 3600000;
  const mph = hours > 0 ? (miles / hours) : 0;
  UI.speed.textContent = `${mph.toFixed(1)} mph`;

  UI.points.textContent = String(state.points.length);

  // enable exports when you have a path
  const hasData = state.points.length > 1;
  UI.exportGpxBtn.disabled = !hasData;
  UI.exportJsonBtn.disabled = !hasData;
  UI.copySummaryBtn.disabled = !hasData;
  UI.recenterBtn.disabled = !lastLatLng;
}

function enableButtons() {
  UI.startBtn.disabled = state.running;
  UI.pauseBtn.disabled = !state.running || state.paused;
  UI.resumeBtn.disabled = !state.running || !state.paused;
  UI.stopBtn.disabled = !state.running;
}

function initMapOnce() {
  if (map) return;

  map = L.map("map", {
    zoomControl: true,
    attributionControl: true,
  }).setView([33.9533, -117.3962], 13); // default-ish (Riverside area); will recenter on first GPS point

  // Aerial / satellite imagery (Esri World Imagery)
  const esriImagery = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 19,
      attribution: "Tiles © Esri",
    }
  ).addTo(map);

  // Optional: overlay labels (roads/place names) on top of imagery
  const esriLabels = L.tileLayer(
    "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, opacity: 0.9, attribution: "Labels © Esri" }
  ).addTo(map);

  // Route polyline
  routeLine = L.polyline([], { weight: 5 }).addTo(map);

  // Markers
  startMarker = L.circleMarker([0, 0], { radius: 7 }).addTo(map);
  endMarker = L.circleMarker([0, 0], { radius: 7 }).addTo(map);
  currentMarker = L.circleMarker([0, 0], { radius: 6 }).addTo(map);

  // Colors via direct style (keeps your CSS simple)
  startMarker.setStyle({ color: "#32d583", fillColor: "#32d583", fillOpacity: 1 });
  endMarker.setStyle({ color: "#ff4f4f", fillColor: "#ff4f4f", fillOpacity: 1 });
  currentMarker.setStyle({ color: "#4f7cff", fillColor: "#4f7cff", fillOpacity: 1 });
  routeLine.setStyle({ color: "#4f7cff" });

  accuracyCircle = L.circle([0, 0], { radius: 0 }).addTo(map);
  accuracyCircle.setStyle({ color: "#9aa7ff", fillColor: "#9aa7ff", fillOpacity: 0.12 });

  // Hide markers until we have real points
  startMarker.setLatLng([0, 0]).setStyle({ opacity: 0, fillOpacity: 0 });
  endMarker.setLatLng([0, 0]).setStyle({ opacity: 0, fillOpacity: 0 });
  currentMarker.setLatLng([0, 0]).setStyle({ opacity: 0, fillOpacity: 0 });
  accuracyCircle.setRadius(0);

  // Recenter button
  UI.recenterBtn?.addEventListener("click", () => {
    if (lastLatLng) {
      map.setView(lastLatLng, Math.max(map.getZoom(), 17), { animate: true });
    }
  });
}

function requestPermissionHint() {
  setStatus("Requesting GPS… If prompted, tap Allow Location.");
}

function startTracking() {
  initMapOnce();

  if (!("geolocation" in navigator)) {
    setStatus("Geolocation not supported on this device/browser.");
    return;
  }
  if (state.running) return;

  // reset state
  state.running = true;
  state.paused = false;
  state.startedAtMs = nowMs();
  state.totalPausedMs = 0;
  state.pausedAtMs = 0;
  state.distanceM = 0;
  state.points = [];
  state.lastAccepted = null;
  lastLatLng = null;

  // clear map layers
  routeLine.setLatLngs([]);
  accuracyCircle.setRadius(0);
  startMarker.setStyle({ opacity: 0, fillOpacity: 0 });
  endMarker.setStyle({ opacity: 0, fillOpacity: 0 });
  currentMarker.setStyle({ opacity: 0, fillOpacity: 0 });

  requestPermissionHint();

  const options = {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 20000
  };

  watchId = navigator.geolocation.watchPosition(onPos, onErr, options);

  tick();
  enableButtons();
  updateUI();
  setStatus("Tracking…");
}

function pauseTracking() {
  if (!state.running || state.paused) return;
  state.paused = true;
  state.pausedAtMs = nowMs();
  setStatus("Paused.");
  enableButtons();
  updateUI();
}

function resumeTracking() {
  if (!state.running || !state.paused) return;
  const pauseDur = nowMs() - state.pausedAtMs;
  state.totalPausedMs += pauseDur;
  state.paused = false;
  state.pausedAtMs = 0;
  setStatus("Resumed.");
  enableButtons();
  updateUI();
}

function stopTracking() {
  if (!state.running) return;
  state.running = false;
  state.paused = false;

  if (watchId != null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  setStatus("Stopped.");
  enableButtons();
  updateUI();
}

function clearAll() {
  if (watchId != null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  state = resetState();

  if (map) {
    routeLine.setLatLngs([]);
    accuracyCircle.setRadius(0);
    startMarker.setStyle({ opacity: 0, fillOpacity: 0 });
    endMarker.setStyle({ opacity: 0, fillOpacity: 0 });
    currentMarker.setStyle({ opacity: 0, fillOpacity: 0 });
  }

  lastLatLng = null;
  setStatus("Cleared.");
  enableButtons();
  updateUI();
}

function onErr(err) {
  const msg = err?.message || "GPS error.";
  setStatus(`GPS error: ${msg}`);
}

function acceptPoint(p) {
  if (isFinite(p.acc) && p.acc > SETTINGS.MAX_ACCURACY_M) {
    setStatus(`Low GPS accuracy (${Math.round(p.acc)} m). Waiting for better signal…`);
    return false;
  }
  if (state.paused) return false;
  if (!state.lastAccepted) return true;

  const d = haversineMeters(state.lastAccepted, p);
  if (d < SETTINGS.MIN_STEP_M) return false;

  return true;
}

function onPos(pos) {
  initMapOnce();

  const c = pos.coords;
  const p = {
    lat: c.latitude,
    lon: c.longitude,
    t: pos.timestamp || nowMs(),
    acc: c.accuracy,
    alt: c.altitude,
    spd: c.speed, // m/s
  };

  UI.accuracy.textContent = isFinite(p.acc) ? `${Math.round(p.acc)} m accuracy` : "-- m accuracy";

  if (!state.running) {
    setStatus("Ready.");
    return;
  }

  const latlng = L.latLng(p.lat, p.lon);
  lastLatLng = latlng;

  // show current marker + accuracy bubble even if not accepted
  currentMarker.setLatLng(latlng).setStyle({ opacity: 1, fillOpacity: 1 });
  if (isFinite(p.acc)) {
    accuracyCircle.setLatLng(latlng);
    accuracyCircle.setRadius(p.acc);
  }

  if (!state.lastAccepted) {
    // first accepted point
    if (isFinite(p.acc) && p.acc > SETTINGS.MAX_ACCURACY_M) {
      setStatus(`Low GPS accuracy (${Math.round(p.acc)} m). Waiting for better signal…`);
      updateUI();
      return;
    }

    state.points.push(p);
    state.lastAccepted = p;

    routeLine.addLatLng(latlng);

    startMarker.setLatLng(latlng).setStyle({ opacity: 1, fillOpacity: 1 });
    endMarker.setLatLng(latlng).setStyle({ opacity: 1, fillOpacity: 1 });

    map.setView(latlng, 17, { animate: true });

    setStatus("Tracking…");
    enableButtons();
    updateUI();
    return;
  }

  if (!acceptPoint(p)) {
    if (!state.paused) setStatus("Tracking…");
    updateUI();
    return;
  }

  // add distance
  const d = haversineMeters(state.lastAccepted, p);
  state.distanceM += d;

  // store + draw
  state.points.push(p);
  state.lastAccepted = p;

  routeLine.addLatLng(latlng);
  endMarker.setLatLng(latlng).setStyle({ opacity: 1, fillOpacity: 1 });

  // keep view mostly stable; only gently follow while running
  map.panTo(latlng, { animate: true, duration: 0.3 });

  setStatus("Tracking…");
  enableButtons();
  updateUI();
}

let raf = null;
function tick() {
  if (!state.running) return;
  updateUI();
  raf = requestAnimationFrame(tick);
}

// ------- Export helpers (same as before) -------
function toSummaryText() {
  const ms = elapsedRunMs();
  const miles = metersToMiles(state.distanceM);
  const feet = metersToFeet(state.distanceM);
  const mins = ms / 60000;
  const pace = miles > 0 ? mins / miles : Infinity;
  return [
    "Run Summary",
    `Time: ${fmtTime(ms)}`,
    `Distance: ${miles.toFixed(3)} mi (${Math.round(feet)} ft)`,
    `Pace: ${fmtPace(pace)}`,
    `Points: ${state.points.length}`,
    `Ended: ${new Date().toLocaleString()}`
  ].join("\n");
}

function download(filename, text, mime = "text/plain") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportJson() {
  const payload = {
    app: "run-tracker",
    exportedAt: new Date().toISOString(),
    elapsedMs: elapsedRunMs(),
    distanceM: state.distanceM,
    points: state.points
  };
  download(`run-${Date.now()}.json`, JSON.stringify(payload, null, 2), "application/json");
}

function exportGpx() {
  const pts = state.points;
  if (pts.length < 2) return;

  const gpxHeader =
`<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="run-tracker" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Run ${new Date().toLocaleString()}</name>
    <trkseg>`;

  const gpxPts = pts.map(p => {
    const t = new Date(p.t).toISOString();
    const ele = (p.alt != null && isFinite(p.alt)) ? `\n        <ele>${p.alt}</ele>` : "";
    return `      <trkpt lat="${p.lat}" lon="${p.lon}">${ele}\n        <time>${t}</time>\n      </trkpt>`;
  }).join("\n");

  const gpxFooter =
`    </trkseg>
  </trk>
</gpx>`;

  download(`run-${Date.now()}.gpx`, `${gpxHeader}\n${gpxPts}\n${gpxFooter}`, "application/gpx+xml");
}

async function copySummary() {
  const txt = toSummaryText();
  try {
    await navigator.clipboard.writeText(txt);
    setStatus("Summary copied to clipboard.");
  } catch {
    download(`run-summary-${Date.now()}.txt`, txt, "text/plain");
    setStatus("Clipboard blocked; downloaded summary instead.");
  }
}

// ------- Wire up buttons -------
UI.startBtn.addEventListener("click", startTracking);
UI.pauseBtn.addEventListener("click", pauseTracking);
UI.resumeBtn.addEventListener("click", resumeTracking);
UI.stopBtn.addEventListener("click", stopTracking);
UI.clearBtn.addEventListener("click", clearAll);

UI.exportJsonBtn.addEventListener("click", exportJson);
UI.exportGpxBtn.addEventListener("click", exportGpx);
UI.copySummaryBtn.addEventListener("click", copySummary);

// Initial
enableButtons();
updateUI();
setStatus("Ready. Tap Start and allow location.");

// Optional wake lock
if ("wakeLock" in navigator) {
  let wakeLock = null;
  UI.startBtn.addEventListener("click", async () => {
    try { wakeLock = await navigator.wakeLock.request("screen"); } catch {}
  });
  UI.stopBtn.addEventListener("click", async () => {
    try { await wakeLock?.release(); wakeLock = null; } catch {}
  });
}
