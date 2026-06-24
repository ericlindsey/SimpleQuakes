// Verify the *algorithm* used by okada-shader.js (FRAG_SRC) is mathematically
// correct, independent of GPU/fp32. This mirrors the shader's restructured
// kernel exactly -- combined subAt corner evaluation, i4 threaded into I3, i5
// into I1, the once-per-pixel atan term, and the q / xi guards -- in float64,
// then compares to the Python reference fixture. A pass means the shader's
// algebra matches the reference; the remaining fp32 gap is what the in-browser
// "Validate" button measures.  Run: node web/bench/check-shader-algo.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DEG = Math.PI / 180;

// Globals set per-fault, mirroring the shader uniforms.
let SD, CD, NU, VERTICAL;

function I5f(xi, eta, q, R, db) {
  const X = Math.sqrt(xi * xi + q * q);
  const xs = xi === 0 ? 1e-12 : xi;
  if (!VERTICAL)
    return (1 - 2 * NU) * 2 / CD *
      Math.atan((eta * (X + q * CD) + X * (R + X) * SD) / (xs * (R + X) * CD));
  return -(1 - 2 * NU) * xi * SD / (R + db);
}
function I4f(db, eta, q, R) {
  if (!VERTICAL)
    return (1 - 2 * NU) / CD * (Math.log(R + db) - SD * Math.log(R + eta));
  return -(1 - 2 * NU) * q / (R + db);
}
function I3f(eta, q, R, i4) {
  const yb = eta * CD + q * SD, db = eta * SD - q * CD;
  if (!VERTICAL)
    return (1 - 2 * NU) * (yb / (CD * (R + db)) - Math.log(R + eta)) + SD / CD * i4;
  return (1 - 2 * NU) / 2 *
    (eta / (R + db) + yb * q / ((R + db) * (R + db)) - Math.log(R + eta));
}
function I1f(xi, eta, q, R, i5) {
  const db = eta * SD - q * CD;
  if (!VERTICAL)
    return (1 - 2 * NU) * (-xi / (CD * (R + db))) - SD / CD * i5;
  return -(1 - 2 * NU) / 2 * xi * q / ((R + db) * (R + db));
}

// Returns {ss:[x,y,z], ds:[...], tf:[...]} at one Chinnery corner.
function subAt(xi, eta, q) {
  const R = Math.sqrt(xi * xi + eta * eta + q * q);
  const db = eta * SD - q * CD;
  const Re = R + eta, Rx = R + xi;
  const at = Math.atan(xi * eta / (q * R));
  const i5 = I5f(xi, eta, q, R, db);
  const i4 = I4f(db, eta, q, R);
  const i3 = I3f(eta, q, R, i4);
  const i2 = (1 - 2 * NU) * (-Math.log(Re)) - i3;
  const i1 = I1f(xi, eta, q, R, i5);
  return {
    ss: [xi * q / (R * Re) + at + i1 * SD,
         (eta * CD + q * SD) * q / (R * Re) + q * CD / Re + i2 * SD,
         db * q / (R * Re) + q * SD / Re + i4 * SD],
    ds: [q / R - i3 * SD * CD,
         (eta * CD + q * SD) * q / (R * Rx) + CD * at - i1 * SD * CD,
         db * q / (R * Rx) + SD * at - i5 * SD * CD],
    tf: [q * q / (R * Re) - i3 * SD * SD,
         -db * q / (R * Rx) - SD * (xi * q / (R * Re) - at) - i1 * SD * SD,
         (eta * CD + q * SD) * q / (R * Rx) + CD * (xi * q / (R * Re) - at) - i5 * SD * SD],
  };
}

function shaderDisp(e, n, p) {
  const strike = p.strike * DEG, dip = p.dip * DEG, rake = p.rake * DEG;
  const sstr = Math.sin(strike), cstr = Math.cos(strike);
  SD = Math.sin(dip); CD = Math.cos(dip); NU = p.nu;
  VERTICAL = !(Math.cos(dip) > Number.EPSILON);
  const U1s = Math.cos(rake) * p.slip / (2 * Math.PI);
  const U2s = Math.sin(rake) * p.slip / (2 * Math.PI);
  const U3s = p.open / (2 * Math.PI);

  const d = p.depth + SD * p.W / 2;
  const ec = e + cstr * CD * p.W / 2, nc = n - sstr * CD * p.W / 2;
  const x = cstr * nc + sstr * ec + p.L / 2;
  const y = sstr * nc - cstr * ec + CD * p.W;
  const pp = y * CD + d * SD;
  let q = y * SD - d * CD;
  if (Math.abs(q) < 1e-12) q = 1e-12;

  const a = subAt(x, pp, q), b = subAt(x, pp - p.W, q);
  const c = subAt(x - p.L, pp, q), dd = subAt(x - p.L, pp - p.W, q);
  const comb = (k, i) => a[k][i] - b[k][i] - c[k][i] + dd[k][i];
  const ux = -U1s * comb("ss", 0) - U2s * comb("ds", 0) + U3s * comb("tf", 0);
  const uy = -U1s * comb("ss", 1) - U2s * comb("ds", 1) + U3s * comb("tf", 1);
  const uz = -U1s * comb("ss", 2) - U2s * comb("ds", 2) + U3s * comb("tf", 2);
  return [sstr * ux - cstr * uy, cstr * ux + sstr * uy, uz];
}

const here = dirname(fileURLToPath(import.meta.url));
const ref = JSON.parse(readFileSync(join(here, "reference.json"), "utf8"));
const p = ref.params, N = ref.grid_n, coords = ref.coords_km;
let maxAbs = 0;
for (let j = 0; j < N; j++)
  for (let i = 0; i < N; i++) {
    const idx = j * N + i;
    const [ue, un, uz] = shaderDisp(coords[i], coords[j], p);
    maxAbs = Math.max(maxAbs, Math.abs(ue - ref.ue[idx]),
      Math.abs(un - ref.un[idx]), Math.abs(uz - ref.uz[idx]));
  }
console.log(`shader algorithm (float64) vs reference, ${N}x${N}`);
console.log(`max abs displacement error: ${maxAbs.toExponential(3)} km`);
const ok = maxAbs < 1e-15;
console.log(ok ? "PASS: shader algebra matches reference"
               : "FAIL: shader algebra diverges -- transcription bug");
process.exit(ok ? 0 : 1);
