// Run Tracker — GitHub Pages friendly
// Tracks: time, distance (feet/miles), pace, speed, route trace
// Noise filtering: min accuracy, min movement, optional smoothing

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

  exportGpxBtn: document.getElementById("exportGpxBtn"),
  exportJsonBtn: document.getElementById("exportJsonBtn"),
  copySummaryBtn: document.getElementById("copySummaryBtn"),

  canvas: document.getElementById("trace"),
  ctx: document.getElementById("trace").getContext("2d"),
};

const SETTINGS = {
  // Ignore points worse than this (meters). 50–80m is reasonable.
  MAX_ACCURACY_M: 50,

  // Ignore tiny GPS jitter steps (meters). 3–8m is typical.
  MIN_STEP_M: 5,

  // If GPS reports speed, trust it only if accuracy is good.
  MIN_SPEED_ACCURACY_M: 35,

  // Canvas padding
  PAD: 18,
};

let watchId = null;
let state = resetState();

function resetState() {
  return {
    running: false,
    paused: false,
    startedAtMs: 0,
    pausedAtMs: 0,
    totalPausedMs: 0,

    // Points: {lat, lon, t, acc, alt?, spd?}
    points: [],

    // Distance meters
    distanceM: 0,

    // For speed calc
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

function metersToMiles(m) {
  return m / 1609.344;
}
function metersToFeet(m) {
  return m * 3.280839895;
}

function fmtPace(minPerMile) {
  if (!isFinite(minPerMile) || minPerMile <= 0) return "--:-- /mi";
  const totalSec = Math.round(minPerMile * 60);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${mm}:${String(ss).padStart(2, "0")} /mi`;
}

function haversineMeters(a, b) {
  const R = 6371000; // meters
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

function nowMs() {
  return Date.now();
}

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

  // Speed mph (average)
  const hours = ms / 3600000;
  const mph = (hours > 0) ? (miles / hours) : 0;
  UI.speed.textContent = `${mph.toFixed(1)} mph`;

  UI.points.textContent = String(state.points.length);

  drawTrace();
}

function enableButtons() {
  UI.startBtn.disabled = state.running;
  UI.pauseBtn.disabled = !state.running || state.paused;
  UI.resumeBtn.disabled = !state.running || !state.paused;
  UI.stopBtn.disabled = !state.running;

  const hasData = state.points.length > 1;
  UI.exportGpxBtn.disabled = !hasData;
  UI.exportJsonBtn.disabled = !hasData;
  UI.copySummaryBtn.disabled = !hasData;
}

function requestPermissionHint() {
  setStatus("Requesting GPS… If prompted, tap Allow Location.");
}

function startTracking() {
  if (!("geolocation" in navigator)) {
    setStatus("Geolocation not supported on this device/browser.");
    return;
  }
  if (state.running) return;

  state.running = true;
  state.paused = false;
  state.startedAtMs = nowMs();
  state.totalPausedMs = 0;
  state.pausedAtMs = 0;
  state.distanceM = 0;
  state.points = [];
  state.lastAccepted = null;

  requestPermissionHint();

  // High accuracy GPS; may use more battery
  const options = {
    enableHighAccuracy: true,
    maximumAge: 1000,   // accept cached for 1s
    timeout: 20000
  };

  watchId = navigator.geolocation.watchPosition(onPos, onErr, options);

  tick();
  enableButtons();
}

function pauseTracking() {
  if (!state.running || state.paused) return;
  state.paused = true;
  state.pausedAtMs = nowMs();
  setStatus("Paused.");
  enableButtons();
}

function resumeTracking() {
  if (!state.running || !state.paused) return;
  const pauseDur = nowMs() - state.pausedAtMs;
  state.totalPausedMs += pauseDur;
  state.paused = false;
  state.pausedAtMs = 0;
  setStatus("Resumed.");
  enableButtons();
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
  setStatus("Cleared.");
  enableButtons();
  updateUI();
}

function onErr(err) {
  const msg = err?.message || "GPS error.";
  setStatus(`GPS error: ${msg}`);
}

function acceptPoint(p) {
  // Filter by accuracy
  if (isFinite(p.acc) && p.acc > SETTINGS.MAX_ACCURACY_M) {
    setStatus(`Low GPS accuracy (${Math.round(p.acc)} m). Waiting for better signal…`);
    return false;
  }

  // If paused, ignore points but still show accuracy
  if (state.paused) return false;

  if (!state.lastAccepted) return true;

  const d = haversineMeters(state.lastAccepted, p);

  // Filter tiny movements (GPS jitter)
  if (d < SETTINGS.MIN_STEP_M) return false;

  return true;
}

function onPos(pos) {
  const c = pos.coords;
  const p = {
    lat: c.latitude,
    lon: c.longitude,
    t: pos.timestamp || nowMs(),
    acc: c.accuracy,
    alt: c.altitude,
    spd: c.speed, // m/s (may be null)
  };

  UI.accuracy.textContent = isFinite(p.acc) ? `${Math.round(p.acc)} m accuracy` : "-- m accuracy";

  if (!state.running) {
    setStatus("Ready.");
    return;
  }

  if (!state.lastAccepted) {
    // first point always accepted (if accuracy ok)
    if (isFinite(p.acc) && p.acc > SETTINGS.MAX_ACCURACY_M) {
      setStatus(`Low GPS accuracy (${Math.round(p.acc)} m). Waiting for better signal…`);
      return;
    }
    state.points.push(p);
    state.lastAccepted = p;
    setStatus("Tracking…");
    enableButtons();
    updateUI();
    return;
  }

  if (!acceptPoint(p)) {
    // still show tracking status
    if (!state.paused) setStatus("Tracking…");
    return;
  }

  // Add distance
  const d = haversineMeters(state.lastAccepted, p);
  state.distanceM += d;

  state.points.push(p);
  state.lastAccepted = p;
  setStatus("Tracking…");
  enableButtons();
  updateUI();
}

let raf = null;
function tick() {
  // update clock even if no new GPS point arrives
  if (!state.running) return;
  updateUI();
  raf = requestAnimationFrame(tick);
}

function drawTrace() {
  const ctx = UI.ctx;
  const w = UI.canvas.width;
  const h = UI.canvas.height;

  // Clear
  ctx.clearRect(0, 0, w, h);

  // Background grid
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#2b2b34";
  for (let x = 0; x <= w; x += 60) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  for (let y = 0; y <= h; y += 60) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  ctx.globalAlpha = 1;

  const pts = state.points;
  if (pts.length < 2) {
    ctx.fillStyle = "#a7a7b3";
    ctx.font = "16px system-ui, -apple-system, Segoe UI, Roboto, Arial";
    ctx.fillText("Start a run to see your trace here.", 24, 38);
    return;
  }

  // Normalize lon/lat to canvas
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of pts) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }

  const pad = SETTINGS.PAD;
  const spanLat = Math.max(1e-9, maxLat - minLat);
  const spanLon = Math.max(1e-9, maxLon - minLon);

  const scaleX = (w - 2 * pad) / spanLon;
  const scaleY = (h - 2 * pad) / spanLat;

  // Keep aspect roughly correct by using min scale
  const s = Math.min(scaleX, scaleY);

  const ox = pad + (w - 2 * pad - spanLon * s) / 2;
  const oy = pad + (h - 2 * pad - spanLat * s) / 2;

  const xy = (p) => ({
    x: ox + (p.lon - minLon) * s,
    y: oy + (maxLat - p.lat) * s, // invert y
  });

  // Path
  ctx.lineWidth = 4;
  ctx.strokeStyle = "#4f7cff";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  const first = xy(pts[0]);
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < pts.length; i++) {
    const q = xy(pts[i]);
    ctx.lineTo(q.x, q.y);
  }
  ctx.stroke();

  // Start / end dots
  ctx.fillStyle = "#32d583";
  ctx.beginPath();
  ctx.arc(first.x, first.y, 7, 0, Math.PI * 2);
  ctx.fill();

  const last = xy(pts[pts.length - 1]);
  ctx.fillStyle = "#ff4f4f";
  ctx.beginPath();
  ctx.arc(last.x, last.y, 7, 0, Math.PI * 2);
  ctx.fill();

  // Summary text
  ctx.fillStyle = "#f4f4f7";
  ctx.font = "14px system-ui, -apple-system, Segoe UI, Roboto, Arial";
  const ms = elapsedRunMs();
  const miles = metersToMiles(state.distanceM);
  ctx.fillText(`Distance: ${miles.toFixed(3)} mi`, 18, h - 44);
  ctx.fillText(`Time: ${fmtTime(ms)}`, 18, h - 22);
}

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
    // fallback
    download(`run-summary-${Date.now()}.txt`, txt, "text/plain");
    setStatus("Clipboard blocked; downloaded summary instead.");
  }
}

UI.startBtn.addEventListener("click", startTracking);
UI.pauseBtn.addEventListener("click", pauseTracking);
UI.resumeBtn.addEventListener("click", resumeTracking);
UI.stopBtn.addEventListener("click", stopTracking);
UI.clearBtn.addEventListener("click", clearAll);

UI.exportJsonBtn.addEventListener("click", exportJson);
UI.exportGpxBtn.addEventListener("click", exportGpx);
UI.copySummaryBtn.addEventListener("click", copySummary);

// Initial paint
enableButtons();
updateUI();
setStatus("Ready. Tap Start and allow location.");

// Helpful: keep screen awake where supported
if ("wakeLock" in navigator) {
  // optional - request on start
  let wakeLock = null;
  UI.startBtn.addEventListener("click", async () => {
    try { wakeLock = await navigator.wakeLock.request("screen"); } catch {}
  });
  UI.stopBtn.addEventListener("click", async () => {
    try { await wakeLock?.release(); wakeLock = null; } catch {}
  });
}
