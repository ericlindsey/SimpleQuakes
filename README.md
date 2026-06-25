# SimpleQuakes

A simple, interactive website for visualizing geodetic deformation from an
earthquake, idealized as a **single rectangular dislocation** in an elastic
half-space (Okada, 1985). Drag a slider to change the fault — strike, dip, rake,
depth, length, width, slip — and watch the surface displacement and **InSAR
fringes update in realtime**.

Designed to be **fast** (interactive frame rates over a dense grid of points),
**simple** (a static site that runs on GitHub Pages, no backend), and
**correct** (the in-browser engine is validated against a double-precision
Python reference).

## Status

Interactive site is up: a full-window WebGL2 canvas with a translucent control
panel — continuous sliders (with exact-entry boxes) for the fault and InSAR
geometry, wrapped-fringe / LOS / E / N / Up views, pan & zoom, a fault overlay,
presets, and shareable URL state. The Okada solution runs per pixel in a
fragment shader, validated against the Python reference. See [`PLAN.md`](PLAN.md)
for the roadmap and the rationale for the rendering approach.

## Layout

```
python/   Reference Okada (1985) implementation + tests (NumPy, float64).
          The trusted source of truth used to validate the browser engine.
          Not shipped to the browser.
web/      The static site.
          index.html + app.js   the interactive app
          okada-shader.js        the GLSL Okada engine (shared)
          bench/                 proof-of-concept + GPU/CPU benchmark + validation
```

## Run the site locally

ES modules need HTTP (not `file://`):

```bash
cd web
python -m http.server 8000
# open http://localhost:8000/
```

Deployment to GitHub Pages is automated (`.github/workflows/pages.yml`); enable
it once via Settings → Pages → Source = "GitHub Actions".

## Reference engine (Python)

```bash
cd python
uv run pytest        # 45 tests validating the Okada85 reference
```

## AI co-authorship

This repository is developed with the assistance of Claude (Opus 4.8). The
Okada85 reference and its tests originate from the `geodef` project. Keep this
note current when future AI models make material contributions.

## References

- Okada, Y. (1985), *Surface deformation due to shear and tensile faults in a
  half-space*, BSSA 75(4), 1135–1154.
- Matlab original by F. Beauducel (1997–2012); Python port by E. Lindsey (2014).

## License

MIT — see [`LICENSE`](LICENSE).
