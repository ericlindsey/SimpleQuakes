# CLAUDE.md - Agent Onboarding Guide

## Project Overview

**VisualQuakes** is a simple, interactive website for visualizing geodetic
deformation from an earthquake, idealized as a **single rectangular dislocation
in an elastic half-space** (Okada, 1985). The user adjusts fault parameters with
sliders (strike, dip, rake, depth, length, width, slip) and an InSAR viewing
geometry, and watches surface displacement and **InSAR fringes update in
realtime**.

Design goals, in priority order:

1. **Fast and smooth** — dragging a slider must update the fringe pattern at
   interactive frame rates (target 60 fps) over a dense grid of points.
2. **Simple** — a static site that runs on GitHub Pages (`*.github.io`) with no
   backend, no build server, minimal dependencies.
3. **Correct** — the in-browser deformation engine is validated against the
   double-precision Python reference in `python/`.

The repository is **web-first**. Python is present only as a trusted reference
implementation and validation oracle; it is not shipped to the browser.

---

## Repository Layout

```
VisualQuakes/
├── CLAUDE.md              # This file
├── AGENTS.md              # Same guidance for non-Claude agents
├── PLAN.md                # Development roadmap (read before starting work)
├── README.md
├── python/                # Reference implementation + validation (NOT shipped)
│   ├── pyproject.toml
│   ├── src/visualquakes/
│   │   ├── __init__.py
│   │   └── okada85.py     # Okada (1985) displacement/tilt/strain (NumPy, float64)
│   └── tests/
│       └── test_okada85.py
└── web/                   # The static site (added during development; see PLAN.md)
```

---

## The deformation engine

`python/src/visualquakes/okada85.py` is the reference. It exposes three
vectorized NumPy functions for surface (z=0) observations:

| Function | Returns |
|----------|---------|
| `displacement(e, n, depth, strike, dip, L, W, rake, slip, open, nu=0.25)` | `(ue, un, uz)` |
| `tilt(...)` | `(uze, uzn)` |
| `strain(...)` | `(unn, une, uen, uee)` |

Conventions (shared by reference and the browser port):
- `e`, `n` are East/North offsets from the fault **centroid** (same length units
  throughout, e.g. meters).
- `depth` is the centroid depth (positive down); `strike`/`dip`/`rake` in
  degrees; `nu` is Poisson's ratio.
- Internally the reference uses Okada's reference point at the **center of the
  top edge**; `setup_args` performs the centroid-to-Okada conversion. The
  browser port MUST reproduce this conversion exactly.

For the interactive app, the per-pixel hot path is `displacement` projected onto
the InSAR line-of-sight, then wrapped to fringes. The closed-form Okada formula
is **embarrassingly parallel per observation point** — this is what makes a GPU
fragment-shader implementation the natural fastest path (see `PLAN.md`).

---

## Important Rules

- **Read `PLAN.md` before starting work**, and update it in the same logical
  unit when you complete or change a step.
- **Validate the browser engine against the Python reference.** Any port of
  Okada85 (JS / WASM / GLSL / WGSL) must be checked against
  `python/src/visualquakes/okada85.py` to an appropriate tolerance (float64 for
  CPU ports; relaxed fp32 tolerance for shader ports).
- **Keep it deployable to GitHub Pages.** No server-side code. Prefer plain
  static files or a build that emits a static `dist/`. Keep runtime
  dependencies minimal.
- **Performance is a feature.** Avoid per-frame allocations on the hot path;
  prefer updating GPU uniforms over rebuilding buffers; profile before
  optimizing.
- Coordinate convention: local Cartesian `x=East, y=North, z=Up`; convert at
  interfaces.
- Use clear, descriptive commit messages. AI co-authorship is also summarized
  once in `README.md` — update that note, this file, and `AGENTS.md` if a new AI
  model materially contributes.

---

## Working with Python (reference only)

```bash
cd python
uv run pytest          # 45 tests; validates the Okada85 reference
uv run ruff check .
uv run mypy src
```

Python style: PEP 8, 4-space indent, type hints + docstrings on public
functions, NumPy vectorization (no Python loops over observation points), no
emoji in source.

---

## Working with the web app

See `PLAN.md` for the chosen architecture. General rules:

- Static, GitHub Pages-deployable. If a bundler is used, it must emit a static
  `dist/` and the dev server must be runnable with `npm` only.
- The deformation/fringe computation should live where it is fastest (a WebGL2
  fragment shader is the current plan); keep a small CPU/JS implementation
  available for validation against the Python reference.
- No secrets in code.

---

## Git Workflow

**Commit after every logical unit of work** — each commit should leave tests
passing and represent a coherent, revertable change. Stage specific files
(avoid blind `git add -A`). Do not bundle unrelated changes.
