// VisualQuakes interactive app. Drives the WebGL2 Okada shader: continuous
// sliders + exact-entry number boxes, full-window canvas, InSAR view modes,
// pan/zoom, fault overlay, presets, and shareable URL state. All heavy compute
// lives in the fragment shader; here we only push uniforms and redraw.

import { VERT_SRC, FRAG_SRC } from "./okada-shader.js";

const DEG = Math.PI / 180;
const TAU = 6.283185307179586;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round2 = (v) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------- state
const state = {
  fault: { strike: 30, dip: 45, rake: 90, depth: 5, length: 10, width: 6, slip: 1, open: 0 },
  insar: { heading: -12, incidence: 34, wavelengthCm: 5.6, pass: "asc", look: "right", band: "C" },
  view: 0,            // 0 fringes, 1 LOS, 2 East, 3 North, 4 Up
  ampCm: 30,          // diverging-colormap saturation for amplitude views
  showFault: true,
  cam: { extent: 40, ox: 0, oy: 0 }, // half-height (km) and center offset (km)
};

const FAULT_FIELDS = [
  ["strike", "Strike", "°", 0, 360],
  ["dip", "Dip", "°", 1, 90],
  ["rake", "Rake", "°", -180, 180],
  ["depth", "Depth", "km", 0.2, 40],
  ["length", "Length", "km", 0.5, 80],
  ["width", "Width", "km", 0.5, 50],
  ["slip", "Slip", "m", 0, 15],
  ["open", "Opening", "m", 0, 10],
];

// Satellite heading by orbit pass (Sentinel-1-like, deg from north).
const PASS_HEADING = { asc: -12, desc: 168 };
// Radar wavelength by band, cm.
const BAND_WAVELENGTH_CM = { X: 3.1, C: 5.6, S: 9.4, L: 23.6 };

const VIEW_NAMES = ["Fringes", "LOS", "East", "North", "Up"];
const PRESETS = {
  "Shallow dip-slip": { strike: 30, dip: 45, rake: 90, depth: 5, length: 10, width: 6, slip: 1, open: 0 },
  "Strike-slip M7": { strike: 0, dip: 90, rake: 0, depth: 7, length: 60, width: 14, slip: 2, open: 0 },
  "Reverse (thrust)": { strike: 0, dip: 30, rake: 90, depth: 10, length: 40, width: 20, slip: 3, open: 0 },
  "Normal": { strike: 0, dip: 55, rake: -90, depth: 6, length: 25, width: 12, slip: 1.5, open: 0 },
  "Dike (opening)": { strike: 0, dip: 90, rake: 0, depth: 3, length: 12, width: 6, slip: 0, open: 1.5 },
};

// Keep the fault buried: its top edge (centroid depth − sin(dip)·W/2) must stay
// below the surface, else the Okada solution is singular right on the pixel grid
// and the displacement mask can't fully clean the trace. SURFACE_MARGIN is just
// large enough (~1 px at the default ±40 km view) to push the singular edge off
// the surface without visibly burying the fault. Bumps the centroid depth up
// whenever depth / dip / width would breach the surface.
const SURFACE_MARGIN = 0.05; // km
function constrainFault() {
  const f = state.fault;
  const minDepth = Math.sin(f.dip * DEG) * f.width / 2 + SURFACE_MARGIN;
  if (f.depth < minDepth) f.depth = minDepth;
}

// ---------------------------------------------------------------- WebGL2
const canvas = document.getElementById("gl");
const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
if (!gl) {
  document.getElementById("nogl").style.display = "grid";
  document.getElementById("panel").style.display = "none";
  throw new Error("WebGL2 unavailable");
}

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}
const prog = gl.createProgram();
gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT_SRC));
gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG_SRC));
gl.linkProgram(prog);
if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
gl.useProgram(prog);
gl.bindVertexArray(gl.createVertexArray()); // empty VAO; gl_VertexID drives the quad

const U = {};
const uniformName = (n) => (U[n] ??= gl.getUniformLocation(prog, n));

// Ground-to-satellite line-of-sight unit vector (E, N, U). Right-looking puts
// the look azimuth 90 deg clockwise of the flight heading; left-looking, 90 ccw.
function losVec(headingDeg, incDeg, lookSign) {
  const h = headingDeg * DEG, inc = incDeg * DEG, az = h + lookSign * Math.PI / 2;
  return [-Math.sin(inc) * Math.sin(az), -Math.sin(inc) * Math.cos(az), Math.cos(inc)];
}

// Surface (vertical) projection of the fault rectangle corners, in km from the
// centroid. Down-dip horizontal direction is (cos phi, -sin phi) -- to the
// right of strike -- matching okada85's setup_args convention.
function faultCorners() {
  const f = state.fault;
  const phi = f.strike * DEG, del = f.dip * DEG;
  const sp = Math.sin(phi), cp = Math.cos(phi), cd = Math.cos(del);
  const L = f.length, W = f.width;
  const corner = (l, w) => [l * sp + w * cd * cp, l * cp - w * cd * sp];
  return [corner(-L / 2, -W / 2), corner(L / 2, -W / 2),
          corner(L / 2, W / 2), corner(-L / 2, W / 2)];
}

function render() {
  pending = false;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const H = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  gl.viewport(0, 0, W, H);

  const f = state.fault, c = state.cam;
  const ey = c.extent, ex = ey * W / H, kmPerPx = (2 * ey) / H;
  const strike = f.strike * DEG, dip = f.dip * DEG, rake = f.rake * DEG;
  const slipKm = f.slip / 1000, openKm = f.open / 1000;
  const look = losVec(state.insar.heading, state.insar.incidence,
                      state.insar.look === "left" ? -1 : 1);
  const corners = faultCorners();

  gl.uniform2f(uniformName("u_resolution"), W, H);
  gl.uniform2f(uniformName("u_extent"), ex, ey);
  gl.uniform2f(uniformName("u_origin"), c.ox, c.oy);
  gl.uniform1f(uniformName("u_depth"), f.depth);
  gl.uniform1f(uniformName("u_L"), f.length);
  gl.uniform1f(uniformName("u_W"), f.width);
  gl.uniform1f(uniformName("u_nu"), 0.25);
  gl.uniform1f(uniformName("u_sstr"), Math.sin(strike));
  gl.uniform1f(uniformName("u_cstr"), Math.cos(strike));
  gl.uniform1f(uniformName("u_sdip"), Math.sin(dip));
  gl.uniform1f(uniformName("u_cdip"), Math.cos(dip));
  gl.uniform1f(uniformName("u_U1s"), Math.cos(rake) * slipKm / TAU);
  gl.uniform1f(uniformName("u_U2s"), Math.sin(rake) * slipKm / TAU);
  gl.uniform1f(uniformName("u_U3s"), openKm / TAU);
  gl.uniform1i(uniformName("u_vertical"), Math.cos(dip) > Number.EPSILON ? 0 : 1);
  gl.uniform3f(uniformName("u_look"), look[0], look[1], look[2]);
  gl.uniform1f(uniformName("u_fringe"), state.insar.wavelengthCm / 200000); // km/fringe
  gl.uniform1i(uniformName("u_mode"), 0);
  gl.uniform1i(uniformName("u_view"), state.view);
  gl.uniform1f(uniformName("u_ampScale"), state.ampCm / 100000); // cm -> km
  gl.uniform1i(uniformName("u_showFault"), state.showFault ? 1 : 0);
  gl.uniform2f(uniformName("u_c0"), corners[0][0], corners[0][1]);
  gl.uniform2f(uniformName("u_c1"), corners[1][0], corners[1][1]);
  gl.uniform2f(uniformName("u_c2"), corners[2][0], corners[2][1]);
  gl.uniform2f(uniformName("u_c3"), corners[3][0], corners[3][1]);
  gl.uniform1f(uniformName("u_kmPerPx"), kmPerPx);

  gl.drawArrays(gl.TRIANGLES, 0, 3);
  updateReadout();
}

let pending = false;
function requestRender() { if (!pending) { pending = true; requestAnimationFrame(render); } }

// ---------------------------------------------------------------- controls
const refreshers = [];
function refreshAll() { for (const r of refreshers) r(); }

function addField(container, group, key, label, unit, min, max, persistent = true, onAfter = null) {
  const obj = group ? state[group] : state;
  const row = document.createElement("div");
  row.className = "row";
  const lab = document.createElement("label"); lab.textContent = label;
  const range = Object.assign(document.createElement("input"),
    { type: "range", min, max, step: "any" });
  const num = Object.assign(document.createElement("input"),
    { type: "number", min, max, step: "any" });
  const unitEl = document.createElement("span"); unitEl.className = "unit"; unitEl.textContent = unit;

  const sync = () => { range.value = obj[key]; num.value = round2(obj[key]); };
  range.addEventListener("input", () => {
    obj[key] = clamp(+range.value, min, max); num.value = round2(obj[key]);
    if (onAfter) onAfter();
    onChange();
  });
  num.addEventListener("input", () => {
    const v = +num.value;
    if (!Number.isFinite(v)) return;
    obj[key] = clamp(v, min, max); range.value = obj[key];
    if (onAfter) onAfter();
    onChange();
  });
  num.addEventListener("change", () => { num.value = round2(obj[key]); }); // tidy on blur
  sync();
  if (persistent) refreshers.push(sync);
  row.append(lab, range, num, unitEl);
  container.append(row);
}

function buildViewOpts() {
  const box = document.getElementById("viewopts");
  box.textContent = "";
  if (state.view !== 0) addField(box, null, "ampCm", "Saturation", "cm", 1, 200, false);
}

// Compact inline toggle: "Label  Opt1 Opt2" highlighted on a single line.
function addInlineToggle(container, label, options, getCurrent, onSelect) {
  const row = document.createElement("div"); row.className = "inline-row";
  const lab = document.createElement("span"); lab.className = "ilab"; lab.textContent = label;
  row.append(lab);
  const opts = options.map(([val, text]) => {
    const o = document.createElement("span"); o.className = "opt"; o.textContent = text;
    o.addEventListener("click", () => { onSelect(val); refresh(); });
    row.append(o);
    return [o, val];
  });
  const refresh = () => opts.forEach(([o, val]) => o.classList.toggle("active", val === getCurrent()));
  refresh();
  container.append(row);
}

// Derive heading/wavelength from the semantic pass/band choices.
function applyGeometry() {
  state.insar.heading = PASS_HEADING[state.insar.pass];
  state.insar.wavelengthCm = BAND_WAVELENGTH_CM[state.insar.band];
}

function buildInsar() {
  const box = document.getElementById("insar");
  box.textContent = "";
  addInlineToggle(box, "Orbit pass", [["asc", "Ascending"], ["desc", "Descending"]],
    () => state.insar.pass,
    (v) => { state.insar.pass = v; applyGeometry(); refreshAll(); onChange(); });
  addInlineToggle(box, "Look", [["right", "Right"], ["left", "Left"]],
    () => state.insar.look,
    (v) => { state.insar.look = v; onChange(); });
  addInlineToggle(box, "Band", [["X", "X"], ["C", "C"], ["S", "S"], ["L", "L"]],
    () => state.insar.band,
    (v) => { state.insar.band = v; applyGeometry(); refreshAll(); onChange(); });
  addField(box, "insar", "incidence", "Incidence", "°", 20, 50);
  const det = document.createElement("details"); det.className = "adv";
  const sum = document.createElement("summary"); sum.textContent = "Advanced (manual heading / λ)";
  det.append(sum);
  addField(det, "insar", "heading", "Heading", "°", -180, 180);
  addField(det, "insar", "wavelengthCm", "λ", "cm", 1, 40);
  box.append(det);
}

function buildSegments() {
  const seg = document.getElementById("viewseg");
  seg.textContent = "";
  VIEW_NAMES.forEach((name, i) => {
    const b = document.createElement("button");
    b.textContent = name;
    b.classList.toggle("active", state.view === i);
    b.addEventListener("click", () => {
      state.view = i;
      [...seg.children].forEach((c, j) => c.classList.toggle("active", j === i));
      buildViewOpts();
      onChange();
    });
    seg.append(b);
  });
}

// ---------------------------------------------------------------- legend
function fringeColorJS(t) {
  const a = TAU * t;
  return [0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.cos(a - 2.0943951),
          0.5 + 0.5 * Math.cos(a - 4.1887902)];
}
function divergingJS(x) {
  x = clamp(x, -1, 1);
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  return x < 0 ? mix([1, 1, 1], [0.23, 0.30, 0.75], -x)
               : mix([1, 1, 1], [0.71, 0.09, 0.16], x);
}
const rgb = (c) => `rgb(${c.map((v) => Math.round(v * 255)).join(",")})`;

function updateLegend() {
  const bar = document.getElementById("legbar");
  const text = document.getElementById("legtext");
  const stops = [];
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    const c = state.view === 0 ? fringeColorJS(t) : divergingJS(t * 2 - 1);
    stops.push(`${rgb(c)} ${(t * 100).toFixed(0)}%`);
  }
  bar.style.background = `linear-gradient(90deg, ${stops.join(",")})`;
  if (state.view === 0) {
    text.textContent = `Wrapped interferogram · 1 color cycle = λ/2 = `
      + `${(state.insar.wavelengthCm / 2).toFixed(2)} cm of range change`;
  } else {
    const amp = (+state.ampCm).toFixed(2);
    text.textContent = `${VIEW_NAMES[state.view]} displacement · `
      + `blue −${amp} cm → red +${amp} cm`;
  }
}

// Moment magnitude from the geodetic moment Mo = mu * d * area, with mu = 30 GPa
// and d the displacement-discontinuity magnitude (shear slip + tensile opening).
function momentMagnitude() {
  const f = state.fault;
  const d = Math.hypot(f.slip, f.open);             // m
  const Mo = 3e10 * d * (f.length * 1000) * (f.width * 1000); // N·m
  return Mo > 0 ? (2 / 3) * (Math.log10(Mo) - 9.1) : null;
}

function updateReadout() {
  const f = state.fault;
  const mw = momentMagnitude();
  document.getElementById("readout").innerHTML =
    `<b>M<sub>w</sub> ${mw == null ? "—" : mw.toFixed(2)}</b> · `
    + `strike ${f.strike.toFixed(0)}° dip ${f.dip.toFixed(0)}° rake ${f.rake.toFixed(0)}° · `
    + `slip ${f.slip.toFixed(2)} m · ${f.length.toFixed(0)}×${f.width.toFixed(0)} km · `
    + `view ±${state.cam.extent.toFixed(1)} km`;
}

// ------------------------------------------------------------- URL state
let urlTimer = 0;
function scheduleUrl() {
  clearTimeout(urlTimer);
  urlTimer = setTimeout(writeUrl, 250);
}
function writeUrl() {
  const f = state.fault, i = state.insar, c = state.cam;
  const p = new URLSearchParams();
  for (const k of Object.keys(f)) p.set(k, round2(f[k]));
  p.set("hd", round2(i.heading)); p.set("inc", round2(i.incidence)); p.set("wl", round2(i.wavelengthCm));
  p.set("pass", i.pass); p.set("look", i.look); p.set("band", i.band);
  p.set("view", state.view); p.set("amp", round2(state.ampCm)); p.set("fl", state.showFault ? 1 : 0);
  p.set("ext", round2(c.extent)); p.set("ox", round2(c.ox)); p.set("oy", round2(c.oy));
  history.replaceState(null, "", "#" + p.toString());
}
function readUrl() {
  if (!location.hash.length) return;
  const p = new URLSearchParams(location.hash.slice(1));
  const num = (k, d) => (p.has(k) && Number.isFinite(+p.get(k)) ? +p.get(k) : d);
  const f = state.fault;
  for (const k of Object.keys(f)) f[k] = num(k, f[k]);
  state.insar.heading = num("hd", state.insar.heading);
  state.insar.incidence = num("inc", state.insar.incidence);
  state.insar.wavelengthCm = num("wl", state.insar.wavelengthCm);
  if (p.has("pass")) state.insar.pass = p.get("pass");
  if (p.has("look")) state.insar.look = p.get("look");
  if (p.has("band")) state.insar.band = p.get("band");
  state.view = clamp(Math.round(num("view", state.view)), 0, 4);
  state.ampCm = num("amp", state.ampCm);
  state.showFault = num("fl", 1) !== 0;
  state.cam.extent = num("ext", state.cam.extent);
  state.cam.ox = num("ox", state.cam.ox);
  state.cam.oy = num("oy", state.cam.oy);
}

function onChange() { requestRender(); updateLegend(); scheduleUrl(); }

// ------------------------------------------------------------- pan / zoom
let dragging = false, lastX = 0, lastY = 0;
canvas.addEventListener("pointerdown", (e) => {
  dragging = true; lastX = e.clientX; lastY = e.clientY;
  canvas.classList.add("dragging"); canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const kmPerPx = (2 * state.cam.extent) / (canvas.clientHeight * dpr) * dpr;
  state.cam.ox -= (e.clientX - lastX) * kmPerPx;
  state.cam.oy += (e.clientY - lastY) * kmPerPx; // screen y down -> north up
  lastX = e.clientX; lastY = e.clientY;
  onChange();
});
const endDrag = () => { dragging = false; canvas.classList.remove("dragging"); };
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mx = (e.clientX - rect.left) / rect.width;       // 0..1
  const my = (e.clientY - rect.top) / rect.height;
  const aspect = rect.width / rect.height;
  const eyBefore = state.cam.extent, exBefore = eyBefore * aspect;
  const wx = state.cam.ox + (mx * 2 - 1) * exBefore;
  const wy = state.cam.oy + ((1 - my) * 2 - 1) * eyBefore;
  state.cam.extent = clamp(eyBefore * Math.exp(e.deltaY * 0.0012), 0.5, 5000);
  const eyAfter = state.cam.extent, exAfter = eyAfter * aspect;
  state.cam.ox = wx - (mx * 2 - 1) * exAfter;            // keep cursor point fixed
  state.cam.oy = wy - ((1 - my) * 2 - 1) * eyAfter;
  onChange();
}, { passive: false });

// ------------------------------------------------------------- wiring
const faultBox = document.getElementById("fault");
const burialHook = () => { constrainFault(); refreshAll(); };
for (const [k, label, unit, min, max] of FAULT_FIELDS) {
  const coupled = k === "depth" || k === "dip" || k === "width";
  addField(faultBox, "fault", k, label, unit, min, max, true, coupled ? burialHook : null);
}
const presetSel = document.getElementById("preset");
for (const name of Object.keys(PRESETS)) presetSel.add(new Option(name, name));
presetSel.addEventListener("change", () => {
  Object.assign(state.fault, PRESETS[presetSel.value]);
  constrainFault(); refreshAll(); onChange();
});

document.getElementById("showfault").addEventListener("change", (e) => {
  state.showFault = e.target.checked; onChange();
});
document.getElementById("resetview").addEventListener("click", () => {
  state.cam = { extent: 40, ox: 0, oy: 0 }; onChange();
});
document.getElementById("collapse").addEventListener("click", () => {
  const panel = document.getElementById("panel");
  panel.classList.toggle("collapsed");
  document.getElementById("collapse").textContent = panel.classList.contains("collapsed") ? "+" : "–";
});

// About swaps the control body in place. Class-based so it never fights the
// collapse toggle over inline display styles.
const panelEl = document.getElementById("panel");
const aboutLink = document.getElementById("aboutlink");
function setAbout(show) {
  panelEl.classList.toggle("show-about", show);
  aboutLink.textContent = show ? "controls" : "about";
}
aboutLink.addEventListener("click", () => setAbout(!panelEl.classList.contains("show-about")));
document.getElementById("aboutback").addEventListener("click", () => setAbout(false));

window.addEventListener("resize", requestRender);
window.addEventListener("hashchange", () => {
  readUrl(); constrainFault(); buildInsar(); refreshAll(); buildSegments(); buildViewOpts(); onChange();
});

// ------------------------------------------------------------- init
readUrl();
constrainFault();
buildInsar();
refreshAll();
document.getElementById("showfault").checked = state.showFault;
buildSegments();
buildViewOpts();
updateLegend();
requestRender();
