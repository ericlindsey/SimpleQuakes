# VisualQuakes — Performance & Benchmarks

Why VisualQuakes renders the way it does, and the measured numbers that back the
choice. The roadmap lives in [`PLAN.md`](PLAN.md); this file is the deep dive on
speed and precision.

## The performance problem, framed

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

## Candidate approaches

| Approach | ~Throughput for 10⁶ px/frame | GitHub Pages? | Complexity | Notes |
|----------|------------------------------|---------------|------------|-------|
| **JS on main thread** | ~50–200 ms/frame | yes | low | Blocks UI; only smooth at small grids (~256²). |
| **JS + Web Workers** | ~4–8× CPU cores | yes | medium | Transferable `ArrayBuffer`/`OffscreenCanvas`; still CPU transcendentals; copy cost. |
| **WASM (Rust/C, SIMD)** | ~2–5× JS | yes | medium-high | Faster scalar math; still CPU-bound and still must blit pixels each frame. |
| **WebGL2 fragment shader** | **comfortably 60 fps** | yes | medium | Okada runs in GLSL per fragment; slider = uniform update + redraw. **Chosen.** |
| **WebGPU compute/render** | 60 fps+, headroom | yes (modern browsers) | high | Best for heavy/compute-extra features; narrower support; same fp32 precision as WebGL. |

### Why WebGL2 fragment shader

Port `okada85.displacement` into a GLSL fragment shader. Fault parameters and
the InSAR look vector are `uniform`s; the fullscreen quad's interpolated
`(e, n)` coordinate is the per-pixel input. The shader computes displacement →
LOS range change → wrapped phase → colormap, writing the final pixel directly.
A slider drag updates uniforms and triggers one redraw — no buffers rebuilt, no
data leaves the GPU. This is the simplest design that hits "realtime fringes"
with large headroom, and it deploys as static files on GitHub Pages.

WebGL2 (not WebGL1) for: non-power-of-two textures, `textureLod`, integer ops,
and `highp` guarantees in fragment shaders.

**WebGPU** is kept as a documented future upgrade for compute-heavy extensions
(many faults, on-the-fly inversion, vector-field streamlines). It does **not**
give better float precision in the browser (WGSL is f32 like GLSL `highp`), so
it is not a fix for any precision issue — it is about compute flexibility and
scale.

## Measured GPU baseline

Recorded on Apple M3 Pro (Chrome/ANGLE-Metal), `EXT_disjoint_timer_query` path
(true GPU time-elapsed, with a per-frame-sync fallback):

| grid  | pixels    | GPU ms/frame | throughput |
|-------|-----------|--------------|------------|
| 256²  | 65,536    | ~0.001 (floor) | ~65 Gpix/s |
| 512²  | 262,144   | ~0.001 (floor) | underutilized |
| 1024² | 1,048,576 | 0.009        | ~116 Gpix/s |
| 2048² | 4,194,304 | 0.039        | ~107 Gpix/s |

CPU JS port for comparison: 256² ≈ 105 ms, 512² ≈ 295 ms (≈10⁵× slower).

The 1024²→2048² step scales linearly in area (4× pixels → 4.33× time),
confirming a genuine compute-bound measurement. Small grids pin to the ~1 µs
timer floor because there is too little work to saturate the GPU (throughput,
not ms, is the meaningful axis there).

**Conclusion:** WebGL2 has ~100–400× headroom over 60 fps at full-screen
resolution; a 4K fringe field (~8.3M px) recomputes in ~0.08 ms. Performance is
a non-constraint — confirmed, not assumed. The GPU is this fast because the
kernel is pure-ALU, divergence-free, near-zero memory traffic, and Metal
compiles transcendentals with fast-math approximations (also why fp32 error is
~0.003% rather than near-zero).

> An early timing pass used a single end-of-loop sync, which measured CPU
> dispatch (non-monotonic, implausibly fast) rather than GPU execution; the
> numbers above use the timer-query path instead.

## Precision (fp32) — applies to WebGL *and* WebGPU

Browser shaders are **fp32**. Okada's formulas have ill-conditioned spots:
`log(R+η)`, `atan(...)`, and divisions near the fault edges / `q→0`. To keep
fp32 visually exact for a teaching tool we:

- keep coordinates fault-relative and reasonably scaled (work in **km**, not m)
  to preserve mantissa bits,
- guard singular denominators exactly as the reference does (`np.spacing`-style
  epsilons), and
- verified the shader's restructured algebra in float64
  (`web/bench/check-shader-algo.mjs`) against the Python reference to ~1e-19 km.

**Measured on real GPU hardware:** for the canonical scenario (64² grid),
max abs LOS error was **8.7e-9 km against a 2.77e-4 km signal peak = 0.0032% of
peak (~0.009 mm)**. No double-precision emulation or near-fault CPU fallback is
needed; plain `highp` fp32 is sufficient. Re-check if extreme geometries (very
shallow, near-vertical, observations on the fault trace) are exercised.

## The benchmark harness

`web/bench/` is a standalone, framework-free probe that produced the numbers
above:

- `okada-bench.html` — times the WebGL2 compute pass (256²–2048², ms/frame +
  fps) and the JS main-thread CPU port (256²/512²); a **Validate** button
  renders LOS on the reference grid, reads it back, and reports max fp32 error
  vs the float64 oracle.
- `okada85.mjs` — the JS float64 port (CPU oracle / fallback renderer).
- `gen_reference.py` → `reference.json`, `validate.mjs` — Node check of the JS
  port vs a Python-exported fixture (matches to ~1e-19 km).
- `check-shader-algo.mjs` — float64 replay of the shader's algebra vs the
  reference.

Run it the same way as the site (ES modules need HTTP):

```bash
cd web/bench
python -m http.server 8000
# open http://localhost:8000/okada-bench.html
```
