# SimpleQuakes — Development Plan

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

---

## 2. Milestones

Status keys: `[ ]` todo · `[~]` in progress · `[x]` done.

### Step 0 — Repo scaffold and reference engine  `[x]`
- [x] Copy Okada85 reference + tests from `geodef` into `python/` (package
      `simplequakes`); 45 tests passing.
- [x] Adapt `CLAUDE.md` / `AGENTS.md` for a web-first repo; add `.gitignore`.
- [x] Write this `PLAN.md`.

### Step 1 — Static site skeleton  `[ ]`
- [ ] Create `web/` with `index.html`, a single `<canvas>`, and a controls
      panel (sliders for strike, dip, rake, depth, length, width, slip; plus
      InSAR heading/incidence and wavelength).
- [ ] Decide tooling: start with **zero-build** (ES modules + plain JS) for
      maximum GitHub Pages simplicity; introduce Vite only if needed.
- [ ] Plain WebGL2 context bring-up: clear color, fullscreen quad, resize
      handling, devicePixelRatio awareness.

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

### Step 3 — Micro-benchmark harness (validate the architecture choice)  `[~]`
- [x] `web/bench/okada-bench.html` times the WebGL2 fragment-shader compute pass
      (256²–2048², ms/frame + fps) and the JS main-thread CPU port (256²/512²).
- [ ] Add the Web Workers variant for a complete CPU comparison.
- [ ] Record real device numbers here (run the page on target hardware) and
      confirm/revise the WebGL2 recommendation.

### Step 4 — GLSL Okada engine + precision check  `[~]`
- [x] `okada85.displacement` implemented in a GLSL ES 3.00 fragment shader
      (`web/bench/okada-shader.js`), in km, with the reference's edge/epsilon
      guards; branches only on the uniform `dip` (no cross-pixel divergence).
- [x] Shader algebra verified in float64 (`check-shader-algo.mjs`) against the
      reference to ~1e-19 km — the restructured kernel is provably correct.
- [ ] Read off fp32-vs-float64 error via the page's **Validate** button on real
      GPUs; quantify near-fault error and decide mitigations if needed.

### Step 5 — InSAR fringes + colormap  `[ ]`
- [ ] LOS projection from heading + incidence angle → unit look vector;
      range change = `dot(displacement, look)`.
- [ ] Wrap to phase modulo λ/2 (default Sentinel-1 C-band, λ≈5.6 cm) and apply
      a cyclic colormap; toggle between wrapped fringes / unwrapped LOS / up /
      east / north.
- [ ] Scale bar, fault outline overlay, north arrow.

### Step 6 — Interaction polish  `[ ]`
- [ ] Live slider → uniform updates with `requestAnimationFrame` coalescing
      (don't redraw more than once per frame).
- [ ] Pan/zoom of the map extent (updates the quad's `(e,n)` mapping uniforms,
      not the geometry).
- [ ] Numeric readouts, shareable URL state (params encoded in the query
      string / hash), and sensible defaults / presets (e.g. a Mw 7 strike-slip).

### Step 7 — Ship on GitHub Pages  `[ ]`
- [ ] GitHub Actions workflow (or Pages-from-branch) to publish `web/` (or
      `dist/`) to `*.github.io`.
- [ ] README with screenshot/GIF and usage.

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

The Python `simplequakes.okada85` (float64, 45 passing tests, traceable to the
original Beauducel/Lindsey Matlab reference) is the **source of truth**. Every
browser engine — JS, and especially the GLSL shader — is checked against it.
Correctness is pinned to the reference; performance is measured, not assumed
(Step 3).
