# VisualQuakes — Development Plan

A single-page, static website (GitHub Pages) that visualizes surface
deformation from one rectangular dislocation (Okada, 1985). The headline
interaction: **drag a slider, watch the InSAR fringes redraw in realtime.**

This document is the roadmap. Update it in the same commit whenever a step's
status changes. The rationale and measured numbers behind the rendering choice
live in [`benchmarks.md`](benchmarks.md).

---

## What's done

The interactive site is built and validated. In short:

- **Architecture chosen and proven.** The full Okada (1985) kernel runs once per
  pixel in a **WebGL2 fragment shader**; a slider drag is just a uniform update
  plus one redraw. Measured throughput leaves ~100–400× headroom over 60 fps at
  full-screen resolution, and fp32 error is ~0.003% of the signal peak — both
  confirmed on real GPU hardware. See [`benchmarks.md`](benchmarks.md).
- **Validated against the Python reference.** The GLSL kernel's algebra and the
  JS float64 port (`web/bench/okada85.mjs`, the CPU oracle/fallback) both match
  `python/src/visualquakes/okada85.py` to ~1e-19 km; on-GPU fp32 output is
  checked against the float64 oracle via the `web/bench/` harness.
- **The app** (`web/index.html` + `web/app.js`, zero-build ES modules sharing
  `web/okada-shader.js`): full-window canvas; continuous sliders with
  exact-entry number boxes for the fault + InSAR geometry; wrapped-fringe / LOS /
  E / N / Up views with adjustable saturation; semantic InSAR geometry (orbit
  pass, look direction, radar band, incidence, with an Advanced manual heading/λ
  override); pan, wheel-zoom, and **pinch-zoom**; fault-outline overlay with
  surface-trace singularity masking and a buried-fault constraint; colorbar
  legend, Mw readout, **scale bar**, presets, an About panel, and shareable URL
  state. Mobile layout collapses to a single scrollable bottom-sheet panel.
- **Deploy.** A GitHub Actions workflow (`.github/workflows/static.yml`)
  publishes `web/` as the site root on push to `main`.

Conventions to preserve: render in **km** (fp32 mantissa), local Cartesian
`x=East, y=North, z=Up`, and reproduce `okada85.setup_args`'
centroid-to-Okada conversion exactly in any port.

---

## Next steps (Step 8)

Status keys: `[ ]` todo · `[~]` in progress · `[x]` done.

### Ship the live site `[x]`
- [x] Enable Pages (Settings → Pages → Source = GitHub Actions); live at
      https://ericlindsey.github.io/visualquakes/.
- [x] Add the live URL + a screenshot to the README.

### USGS event import `[ ]`
- [ ] Accept a **USGS event ID** (e.g. from the ComCat / earthquake.usgs.gov
      API) and build an **approximate fault** from it: pull magnitude and, when
      available, the moment-tensor / focal-mechanism (nodal plane → strike / dip
      / rake) and depth; derive length / width / slip from scaling relations
      (e.g. Wells & Coppersmith) where finite-fault data is absent. Populate the
      sliders so the user lands on a plausible scenario for a real earthquake.
      Network fetch only — keep the site static (no backend).

### tilt / strain `[ ]`
- [ ] Port `okada85.tilt` and `okada85.strain` to JS (validate vs the Python
      reference) and to GLSL, and surface them as additional view modes if the
      app exposes them.

### Other extensions `[ ]`
- [ ] GNSS-style displacement vector arrows overlaid on fringes.
- [ ] Multiple faults / simple finite-fault (sum of patches) — natural point to
      evaluate **WebGPU compute** if the patch count grows.
- [ ] Real basemap / coordinates (a true North arrow becomes meaningful once the
      view is geographically referenced); export PNG.
- [ ] Nice-to-have: keyboard nudges for fine slider control.

---

## Open questions

- **Units in the UI:** expose meters or km? (Internally render in km for fp32.)
- **Default InSAR geometry:** Sentinel-1 ascending (heading ≈ −12°, incidence
  ≈ 34°) is the current default.
- **Build tooling:** stay zero-build as long as possible; revisit if module
  organization or shader includes get unwieldy.

---

## Validation philosophy

The Python `visualquakes.okada85` (float64, 45 passing tests, traceable to the
original Beauducel/Lindsey Matlab reference) is the **source of truth**. Every
browser engine — JS, and especially the GLSL shader — is checked against it.
Correctness is pinned to the reference; performance is measured, not assumed.
