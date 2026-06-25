# Okada WebGL2 proof-of-concept + benchmark

A minimal, framework-free probe of the core SimpleQuakes bet: **run the full
Okada (1985) kernel once per pixel in a WebGL2 fragment shader**, so dragging a
slider is just a uniform update + one redraw.

## Why "nonlinear" doesn't hurt the GPU

GPUs care about *data parallelism* and *control-flow divergence*, not about
whether the math is linear. Okada is:

- **per-pixel independent** — each pixel depends only on its own `(e, n)` plus
  shared fault parameters (ideal data parallelism);
- **straight-line transcendental math** — `sqrt`, `atan`, `log`, `sin/cos`,
  divisions, which GPUs run in dedicated hardware units;
- **branch-free across pixels** — the only conditionals key on `dip` (a uniform),
  so every thread in a frame takes the same path. Zero divergence.

So "nonlinear" just means each thread does a fixed chunk of FLOPs — the GPU's
best case. The real questions are fp32 precision near the fault and whether
you're compute- vs overhead-bound, which the benchmark answers on your hardware.

## Run it

ES modules and `reference.json` need HTTP (not `file://`):

```bash
cd web/bench
python -m http.server 8000
# open http://localhost:8000/okada-bench.html
```

- **Drag the sliders** — fringes redraw in realtime from updated uniforms.
- **Run benchmark** — GPU compute-pass ms/frame (and fps) at 256²–2048²,
  vs the JS float64 CPU port at 256²/512².
- **Validate GPU vs Python reference** — renders LOS on the reference grid,
  reads it back, and reports max fp32 error against the float64 oracle.

## Result so far

On real GPU hardware the **Validate** button reports fp32 vs float64 LOS error
of **~0.003% of the signal peak** (sub-millimeter) for the canonical scenario —
so plain `highp` fp32 is sufficient; no double-precision emulation needed.

GPU frame timing uses `EXT_disjoint_timer_query` for true GPU time-elapsed (the
header shows whether it is available). If your first run showed implausibly fast,
non-monotonic numbers, that was a single-end-of-loop sync measuring CPU dispatch
instead of GPU execution — now fixed; re-run for honest per-frame GPU time.

## Files

| File | Role |
|------|------|
| `../okada-shader.js` | GLSL ES 3.00 port of `displacement` + LOS + colormaps (shared with the app) |
| `okada85.mjs` | float64 JS port (CPU baseline **and** correctness oracle) |
| `okada-bench.html` | WebGL2 harness: live view, benchmark, validation |
| `gen_reference.py` | writes `reference.json` from the Python float64 engine |
| `reference.json` | ground-truth fixture (params + displacement + LOS on a grid) |
| `validate.mjs` | Node: JS port vs Python reference |
| `check-shader-algo.mjs` | Node: shader's restructured algebra vs reference |

## Trust chain (the parts checkable without a GPU)

```bash
node web/bench/validate.mjs           # JS float64  vs Python float64
node web/bench/check-shader-algo.mjs  # shader algebra (float64) vs Python
```

Both pass to ~1e-19 km (float64 round-off), so the shader's math is correct by
construction. The browser **Validate** button adds the only device-dependent
piece: fp32 vs float64 on your GPU.

## Regenerate the fixture

If the scenario in `gen_reference.py` changes:

```bash
cd python && uv run python ../web/bench/gen_reference.py
```
