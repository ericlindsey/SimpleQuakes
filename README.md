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

Early development. The deformation reference engine and project plan are in
place; the web app is being built next. See [`PLAN.md`](PLAN.md) for the
roadmap and the rationale for the chosen rendering approach (a WebGL2 fragment
shader that runs the Okada solution per pixel on the GPU).

## Layout

```
python/   Reference Okada (1985) implementation + tests (NumPy, float64).
          The trusted source of truth used to validate the browser engine.
          Not shipped to the browser.
web/      The static site (added during development; see PLAN.md).
```

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
