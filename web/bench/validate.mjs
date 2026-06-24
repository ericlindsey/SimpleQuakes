// Validate the JS float64 port against the Python float64 reference fixture.
//   node web/bench/validate.mjs
// Regenerate reference.json first via gen_reference.py if params change.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { displacement } from "./okada85.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ref = JSON.parse(readFileSync(join(here, "reference.json"), "utf8"));
const p = ref.params;
const coords = ref.coords_km;
const N = ref.grid_n;
const look = ref.look_enu;

let maxAbs = 0, maxRel = 0;
let losMaxAbs = 0;
const refLosMax = Math.max(...ref.los.map(Math.abs));

for (let j = 0; j < N; j++) {
  for (let i = 0; i < N; i++) {
    const idx = j * N + i;
    const [ue, un, uz] = displacement(
      coords[i], coords[j], p.depth, p.strike, p.dip, p.L, p.W,
      p.rake, p.slip, p.open, p.nu,
    );
    for (const [got, exp] of [[ue, ref.ue[idx]], [un, ref.un[idx]], [uz, ref.uz[idx]]]) {
      const abs = Math.abs(got - exp);
      maxAbs = Math.max(maxAbs, abs);
      if (Math.abs(exp) > 1e-12) maxRel = Math.max(maxRel, abs / Math.abs(exp));
    }
    const los = ue * look[0] + un * look[1] + uz * look[2];
    losMaxAbs = Math.max(losMaxAbs, Math.abs(los - ref.los[idx]));
  }
}

console.log(`grid ${N}x${N}, ${N * N} points`);
console.log(`displacement max abs error: ${maxAbs.toExponential(3)} km`);
console.log(`displacement max rel error: ${maxRel.toExponential(3)}`);
console.log(`LOS max abs error: ${losMaxAbs.toExponential(3)} km` +
            ` (signal peak ${refLosMax.toExponential(3)} km)`);

// float64 vs float64: absolute agreement to round-off. Relative error is not
// gated because it explodes harmlessly where the true displacement is ~0.
const ok = maxAbs < 1e-15;
console.log(ok ? "PASS: JS port matches Python reference" :
                 "FAIL: JS port diverges from Python reference");
process.exit(ok ? 0 : 1);
