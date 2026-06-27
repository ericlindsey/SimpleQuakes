# VisualQuakes — Development Plan

A single-page, static website (GitHub Pages) that visualizes surface
deformation from one rectangular dislocation (Okada, 1985). The headline
interaction: **drag a slider, watch the InSAR fringes redraw in realtime.**

This document is the roadmap. Update it in the same commit whenever a step's
status changes.

---

## 1. The performance problem, framed

Every frame we evaluate, for a dense grid of surface points (target: a
1000×1000 = 10⁶-pixel image, ideally larger), the Okada (1985) closed-form
solution for **one** fault, project the 3-D displacement onto an InSAR
line-of-sight, wrap the range change modulo λ/2 into a fringe phase, and color
it. A slider drag changes only the fault parameters (or look geometry) — the
grid is fixed.

Key properties that decide the architecture:

- **Embarrassingly parallel per pixel.** Each output pixel depends only on its
  own `(e, n)` and the (shared) fault parameters. No reductions, no neighbor
  coupling. This is the ideal case for a GPU.
- **Cheap but transcendental.** Per pixel ≈ a few dozen flops plus a handful of
  `sqrt`, `atan`, `log`, and shared `sin`/`cos`. ~10⁶ pixels × tens of ops =
  tens of millions of transcendental ops per frame.
- **Output is literally an image.** The natural product is a colored raster, so
  computing *into* the framebuffer avoids any CPU↔GPU data round-trip.
- **Inputs change, grid doesn't.** Per frame we only need to push a dozen
  scalar uniforms; geometry/buffers stay static.

### Candidate approaches

| Approach | ~Throughput for 10⁶ px/frame | GitHub Pages? | Complexity | Notes |
|----------|------------------------------|---------------|------------|-------|
| **JS on main thread** | ~50–200 ms/frame | yes | low | Blocks UI; only smooth at small grids (~256²). |
| **JS + Web Workers** | ~4–8× CPU cores | yes | medium | Transferable `ArrayBuffer`/`OffscreenCanvas`; still CPU transcendentals; copy cost. |
| **WASM (Rust/C, SIMD)** | ~2–5× JS | yes | medium-high | Faster scalar math; still CPU-bound and still must blit pixels each frame. |
| **WebGL2 fragment shader** | **comfortably 60 fps** | yes | medium | Okada runs in GLSL per fragment; slider = uniform update + redraw. **Recommended.** |
| **WebGPU compute/render** | 60 fps+, headroom | yes (modern browsers) | high | Best for heavy/compute-extra features; narrower support; same fp32 precision as WebGL. |

### Recommendation: **WebGL2 fragment shader** as the primary engine

Port `okada85.displacement` into a GLSL fragment shader. Fault parameters and
the InSAR look vector are `uniform`s; the fullscreen quad's interpolated
`(e, n)` coordinate is the per-pixel input. The shader computes displacement →
LOS range change → wrapped phase → colormap, writing the final pixel directly.
A slider drag updates uniforms and triggers one redraw — no buffers rebuilt, no
data leaves the GPU. This is the simplest design that hits "realtime fringes"
with large headroom, and it deploys as static files on GitHub Pages.

WebGL2 (not WebGL1) for: non-power-of-two textures, `textureLod`, integer ops,
and `highp` guarantees in fragment shaders.

**WebGPU** is kept as a documented future upgrade (Step 8) for compute-heavy
extensions (many faults, on-the-fly inversion, vector-field streamlines). It
does **not** give better float precision in the browser (WGSL is f32 like GLSL
`highp`), so it is not a fix for any precision issue — it is about compute
flexibility and scale.

### Precision note (applies to WebGL *and* WebGPU)

Browser shaders are **fp32**. Okada's formulas have ill-conditioned spots:
`log(R+η)`, `atan(...)`, and divisions near the fault edges/`q→0`. fp32 is
expected to be visually fine for a teaching/visualization tool, but we will:
- keep coordinates fault-relative and reasonably scaled (work in km, not m) to
  preserve mantissa bits,
- guard singular denominators exactly as the reference does
  (`np.spacing`-style epsilons), and
- **quantify** the fp32-vs-float64 error in Step 4 against the Python reference
  before committing to the approach. If error is unacceptable near the fault,
  fall back to CPU float for a thin near-fault band, or render at higher
  internal resolution.

**Resolved (Step 4):** fp32 was measured on real GPU hardware at **0.0032% of
the signal peak** (~0.009 mm) for the canonical scenario — comfortably within
budget with the km-scaling + epsilon guards above. None of the fallbacks are
needed for typical geometries. Keep an eye on extreme cases (observations on
the fault trace, very shallow/near-vertical faults).

---

## 2. Milestones

Status keys: `[ ]` todo · `[~]` in progress · `[x]` done.

### Step 0 — Repo scaffold and reference engine  `[x]`
- [x] Copy Okada85 reference + tests from `geodef` into `python/` (package
      `visualquakes`); 45 tests passing.
- [x] Adapt `CLAUDE.md` / `AGENTS.md` for a web-first repo; add `.gitignore`.
- [x] Write this `PLAN.md`.

### Step 1 — Static site  `[x]`
- [x] `web/index.html` + `web/app.js`: full-window canvas with a translucent,
      collapsible control overlay. Zero-build (ES modules + plain JS), shares
      the validated `web/okada-shader.js`.
- [x] **Continuous** sliders (`step="any"`) paired with exact-entry number
      boxes, for strike/dip/rake/depth/length/width/slip/opening and InSAR
      heading/incidence/wavelength — no stair-stepping while dragging.
- [x] WebGL2 bring-up with devicePixelRatio (capped at 2), resize handling,
      and `requestAnimationFrame`-coalesced redraws. Graceful no-WebGL2 notice.

> **Note:** a standalone proof-of-concept landed early in `web/bench/` (ahead
> of the full site, by request) to de-risk the architecture. It already covers
> most of Steps 2–4; remaining items are called out below.

### Step 2 — CPU reference port in JS  `[~]`
- [x] Port `okada85.displacement` to plain JS float64 (`web/bench/okada85.mjs`),
      mirroring `setup_args` and the Chinnery/sub-function structure 1:1.
- [x] Node check vs a Python-exported fixture (`web/bench/gen_reference.py` →
      `reference.json`; `validate.mjs`): matches to ~1e-19 km. This JS port is
      the shader's correctness oracle and a CPU fallback renderer.
- [ ] (later) tilt/strain ports if the app surfaces them.

### Step 3 — Micro-benchmark harness (validate the architecture choice)  `[x]`
- [x] `web/bench/okada-bench.html` times the WebGL2 fragment-shader compute pass
      (256²–2048², ms/frame + fps) and the JS main-thread CPU port (256²/512²).
- [x] Fixed GPU timing to use `EXT_disjoint_timer_query` (true GPU
      time-elapsed), with a per-frame-sync fallback. The first pass used a
      single end-of-loop sync, which measured CPU dispatch (non-monotonic,
      implausibly fast) rather than GPU execution.
- [x] **On-device baseline recorded — Apple M3 Pro (Chrome/ANGLE-Metal),
      timer-query path:**

      | grid  | pixels    | GPU ms/frame | throughput |
      |-------|-----------|--------------|------------|
      | 256²  | 65,536    | ~0.001 (floor) | ~65 Gpix/s |
      | 512²  | 262,144   | ~0.001 (floor) | underutilized |
      | 1024² | 1,048,576 | 0.009        | ~116 Gpix/s |
      | 2048² | 4,194,304 | 0.039        | ~107 Gpix/s |

      CPU JS port for comparison: 256² ≈ 105 ms, 512² ≈ 295 ms (≈10⁵× slower).
      The 1024²→2048² step scales linearly in area (4× pixels → 4.33× time),
      confirming a genuine compute-bound measurement. Small grids pin to the
      ~1 µs timer floor because there is too little work to saturate the GPU
      (throughput, not ms, is the meaningful axis there). **Conclusion:**
      WebGL2 has ~100–400× headroom over 60 fps at full-screen resolution; a 4K
      fringe field (~8.3M px) recomputes in ~0.08 ms. Performance is a
      non-constraint — confirmed, not assumed. The GPU is this fast because the
      kernel is pure-ALU, divergence-free, near-zero memory traffic, and Metal
      compiles transcendentals with fast-math approximations (also why fp32
      error is ~0.003% rather than near-zero).
- [ ] (optional) Web Workers CPU variant — deprioritized; GPU dominance is
      unambiguous and the CPU path is only a fallback/oracle.

### Step 4 — GLSL Okada engine + precision check  `[x]`
- [x] `okada85.displacement` implemented in a GLSL ES 3.00 fragment shader
      (`web/bench/okada-shader.js`), in km, with the reference's edge/epsilon
      guards; branches only on the uniform `dip` (no cross-pixel divergence).
- [x] Shader algebra verified in float64 (`check-shader-algo.mjs`) against the
      reference to ~1e-19 km — the restructured kernel is provably correct.
- [x] **fp32 precision confirmed adequate on real GPU hardware.** Validate
      button (reference scenario, 64² grid): max abs LOS error 8.7e-9 km vs a
      2.77e-4 km signal peak = **0.0032% of peak** (~0.009 mm). No
      double-precision emulation or near-fault CPU fallback needed; plain
      `highp` fp32 is sufficient. Re-check if extreme geometries (very shallow,
      near-vertical, observations on the fault trace) are exercised.

### Step 5 — InSAR fringes + colormap  `[x]`
- [x] LOS projection from heading + incidence → unit look vector; range change
      = `dot(displacement, look)`.
- [x] Wrap to phase modulo λ/2 (cyclic colormap) with adjustable wavelength
      (C-band default ≈5.6 cm); view toggle between wrapped fringes / unwrapped
      LOS / East / North / Up (diverging colormap with adjustable saturation).
- [x] Fault-outline overlay (surface-projected rectangle, bright top edge) and
      an in-panel colorbar legend. (North arrow / scale bar: still to add.)
- [x] Mask the Okada surface-trace singularity: flag pixels with |disp| > 20 m
      (the `!(mag < T)` test also catches NaN/Inf) and paint them neutral gray.
      Two comparisons per pixel — no measurable cost.
- [x] Keep the fault buried: enforce centroid `depth ≥ sin(dip)·W/2 + margin`
      whenever depth/dip/width change, so the top edge never breaches the
      surface (the residual singular case the mask alone could not clean).

### Step 6 — Interaction polish  `[~]`
- [x] Live slider → uniform updates with `requestAnimationFrame` coalescing.
- [x] Pan (drag) / zoom (wheel, about the cursor) of the map extent via the
      `(e,n)` mapping uniforms, not geometry.
- [x] Numeric readout incl. moment magnitude (Mw), shareable URL state (params
      in `location.hash`), presets (strike-slip / thrust / normal / dike /
      shallow dip-slip).
- [x] Semantic InSAR geometry: orbit pass (ascending/descending), look
      direction (right/left), radar band (X/C/S/L → wavelength), incidence
      slider, with an Advanced manual heading/λ override for unusual cases.
- [x] In-header About panel describing how it works.
- [x] Layout: colorbar + stats live in a compact lower-right info panel; InSAR
      geometry uses single-line inline toggles to keep the main panel short.
- [ ] Nice-to-have: keyboard nudges, mobile pinch-zoom, North arrow + scale bar.

### Step 7 — Ship on GitHub Pages  `[~]`
- [x] GitHub Actions workflow (`.github/workflows/static.yml`) publishing `web/`
      as the site root on push to `main`.
- [ ] One-time: enable Pages (Settings → Pages → Source = GitHub Actions);
      then add the live URL + a screenshot/GIF to the README.

### Step 8 — Optional extensions  `[ ]`
- [ ] GNSS-style displacement vector arrows overlaid on fringes.
- [ ] Multiple faults / simple finite-fault (sum of patches) — natural point to
      evaluate **WebGPU compute** if the patch count grows.
- [ ] Real basemap / coordinates; export PNG.

---

## 3. Open questions / decisions to confirm

- **Units in the UI:** expose meters or km? (Internally render in km for fp32.)
- **Default InSAR geometry:** Sentinel-1 ascending (heading ≈ −12°, incidence
  ≈ 39°) as the default preset?
- **Build tooling:** stay zero-build as long as possible; revisit if module
  organization or shader includes get unwieldy.

---

## 4. Validation philosophy

The Python `visualquakes.okada85` (float64, 45 passing tests, traceable to the
original Beauducel/Lindsey Matlab reference) is the **source of truth**. Every
browser engine — JS, and especially the GLSL shader — is checked against it.
Correctness is pinned to the reference; performance is measured, not assumed
(Step 3).
