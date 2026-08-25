# OrbitVision architecture

Technical reference for the prototype's structure.
Precise where `overview.md` is plain: every module, function, and threshold named here is verified against the source in this repository, not inferred from a name.

## Technology stack

**Engine** (`src/orbitvision/`, Python, pinned in `requirements.txt`):

| Dependency | Version | Why it's here |
|---|---|---|
| `numpy` | 2.5.2 | Vectorised position/velocity arrays for propagation, screening, and frame conversion. Nothing in the engine loops over objects in plain Python where an array operation will do. |
| `scipy` | 1.18.1 | `scipy.spatial.cKDTree` in `screening.py`'s coarse sweep - the only practical way to find close-together points among ~15,000 objects at each timestep. |
| `requests` | 2.34.2 | HTTP client for the live CelesTrak fetch in `ingest.py`. Unused in `--offline` mode. |
| `sgp4` | 2.27 | The actual orbit propagator (`Satrec`, `SatrecArray`, `sgp4.omm`) - turns a catalogue element set into a position and velocity at a given time. |

CI (`.github/workflows/tests.yml`) pins Python 3.12.
A local `.venv` at whatever Python 3.x you have works equally, since none of the above pin a Python version.

**Frontend** (root `package.json`, Node/npm):

| Dependency | Version | Why it's here |
|---|---|---|
| `cesium` | 1.144.0 | The 3D globe: WebGL rendering, camera control, entity/primitive management. |
| `satellite.js` | 6.0.2 | Client-side SGP4 (`json2satrec`, `propagate`, `eciToEcf`, `gstime`) so the globe can animate object positions continuously between the engine's own pre-sampled track points, instead of only snapping to them. |
| `vite` | 8.2.2 (dev) | Dev server and production bundler. |
| `vite-plugin-cesium` | 1.2.23 (dev) | Copies Cesium's static assets (workers, textures) into the build and points Cesium at them; Cesium does not work correctly under a bare Vite config without it. |

Two Google Fonts are loaded via a CDN `<link>` in `index.html` (not an npm dependency): **IBM Plex Sans** and **IBM Plex Mono**.
See [Design system](#design-system) below.

No backend framework, no database, no server-side language.
The frontend is a static site; see [The two halves](#the-two-halves-and-the-boundary-between-them).

## The two halves, and the boundary between them

OrbitVision is two independent programs that never call each other at runtime:

1. The **engine** (`src/orbitvision/`, Python) reads a satellite catalogue, computes risk, and writes one file: `data/output.json`.
2. The **frontend** (`src/*.js`, `index.html`, Vite) reads that one file and renders it.
   It has no server component and makes no other network call at runtime - CesiumJS is configured with bundled offline imagery only, no Cesium ion token.

`data/output.json` is the entire contract between them.
Its shape is pinned by `docs/output-contract.md` and treated as frozen: existing keys are never renamed or removed without updating the frontend in the same change, though additive keys are allowed (and documented in that file and the PR that adds them).
Because the contract is a plain JSON file rather than a live API, the frontend can be built and iterated on before the engine finishes a run, using the hand-authored `data/sample-output.json`, which matches the same contract with fabricated data.

```
                         ┌───────────────────────────────────────────┐
                         │              ENGINE (Python)               │
                         │            src/orbitvision/                │
                         │                                             │
  CelesTrak GP + SATCAT  │  ingest ──▶ catalog ──▶ propagate           │
  (public catalogue) ───▶│                            │                │
  data/celestrak/*        │              ┌─────────────┘                │
  (offline snapshot)       │              ▼                              │
                         │          screening (3-pass cascade)         │
                         │       perigee/apogee → coarse → refine      │
                         │              │                                │
                         │              ▼                                │
                         │      frames (TEME → ECEF)  +  risk (Chan Pc) │
                         │              │                                │
                         │              ▼                                │
                         │            output ──▶ data/output.json       │
                         └───────────────────────────┬───────────────────┘
                                                       │
                                     the entire contract, pinned by
                                     docs/output-contract.md - no other
                                     coupling between the two halves
                                                       │
                         ┌─────────────────────────────▼───────────────┐
                         │            FRONTEND (browser)                │
                         │              src/*.js, Vite                  │
                         │                                               │
                         │  data.js ──▶ main.js (state + render loop)   │
                         │                  │         │                  │
                         │                  ▼         ▼                  │
                         │             globe.js     ui.js                │
                         │          (Cesium globe) (list/detail/legend/  │
                         │                           scrub ticks)        │
                         │                  ▲                            │
                         │             propagate.js                     │
                         │        (client-side SGP4, satellite.js)      │
                         └───────────────────────────────────────────────┘
```

## The engine pipeline

All of this runs inside `pipeline.run()` (`src/orbitvision/pipeline.py`), called from `__main__.py`.
Numbers below are the actual counts from a real `--offline` run against the committed CelesTrak snapshot (15,587-object catalogue, 72-hour window): they will differ run to run as the catalogue and window change, but the shape of the cascade will not.

### 1. Ingest and cache

**Module/function:** `ingest.py`, `load()`.
**In:** nothing (network) or the committed snapshot (offline).
**Out:** `(gp_records, satcat_rows, source)` - raw GP element sets, raw SATCAT rows, and a metadata block recording where they came from.

Fetches CelesTrak's GP element set feed (`gp.php?GROUP=active`) and SATCAT catalogue (`satcat.csv`), or reads the committed `data/celestrak/` snapshot when `--offline` is passed, making zero network calls.
Live fetches are cached to disk and refused if under `CACHE_MAX_AGE_SECONDS` (2 hours) old; a 403/404/301 response is treated as terminal and never retried, because CelesTrak enforces one download per real data refresh on high-traffic groups.
See [Known limitations](#known-limitations-and-sharp-edges).

### 2. Catalogue filtering

**Module/function:** `catalog.py`, `build_catalog()`.
**In:** raw GP + SATCAT rows.
**Out:** a list of `CatalogObject` - one per object with a usable GP element set, restricted to LEO.
**Threshold:** `leo_apogee_limit_km`, set to `LEO_APOGEE_LIMIT_KM = 2000.0` in `pipeline.py`.

Joins each GP record to its SATCAT row by NORAD ID (owner, object type, RCS size, launch date - `UNKNOWN`/`null` when SATCAT has no matching row, since GP is propagation-critical and SATCAT is metadata-only), derives semi-major axis / perigee / apogee altitude / orbital period from mean motion and eccentricity, and drops anything whose derived apogee altitude exceeds the LEO limit.
A malformed GP record (missing/unparseable fields) is skipped, not fatal.

### 3. SGP4 propagation

**Module/function:** `propagate.py`, `build_satrec()` + `propagate()`, called from `pipeline.run()`.
**In:** one `Satrec` per catalogue object, plus a `(jd, fr)` time grid.
**Out:** position and velocity arrays in TEME, shape `(n_objects, n_times, 3)`.

Uses `sgp4.api.SatrecArray` to batch-propagate every object across a block of timesteps in one C-extension call, rather than looping per object in Python.
The whole window is processed in blocks of `BLOCK_STEPS = 240` steps (a full-catalogue, full-window state array would run to roughly 3 GB).

### 4. Coarse screening (passes 1 and 2)

**Module/functions:** `screening.py` - `perigee_apogee_can_conjunct()` / `perigee_apogee_survivor_count()` (pass 1), `sweep_block_gated()` and `sweep_block_exhaustive()` (pass 2), `cluster_encounters()`.
**In:** the propagated position/velocity arrays.
**Out:** a list of `(i, j, t_seconds, d_km)` - one row per distinct encounter, closest-sample time and straight-line distance.

Screening every object pair at every timestep is not tractable (15,587 objects is ~121.5 million pairs; a 72-hour window at 60 s steps is 4,321 samples), so a cascade of increasingly expensive filters is applied:

- **Pass 1 - perigee/apogee filter** (Hoots, Crawford & Roehrich 1984): purely analytic, no propagation.
  Two orbits can never meet if the lower of their two apoapses sits more than a pad below the higher of their two periapses.
  The pad reuses `COARSE_GATE_KM` (500 km, see pass 2) as `pad_km`, applied both once globally to count survivors (105,276,019 of 121,469,491 pairs in the sample run) and per-candidate-pair inside pass 2.
  Same-mega-constellation pairs (`MEGA_CONSTELLATIONS = {"STARLINK", "ONEWEB"}`, matched by name substring) and same-docked-assembly pairs (objects sharing an identical GP element-set fingerprint - see `_assembly_groups()` in `pipeline.py`) are dropped here too: the operator flies both objects and coordinates them internally, so no external screening applies.
  See `screening.excluded_pairs` in the output for the exact counts.
- **Pass 2 - coarse temporal sweep**, `COARSE_STEP_SECONDS = 60.0`, `COARSE_GATE_KM = 500.0` (both in `screening.py`): for the general catalogue, a KD-tree (`scipy.spatial.cKDTree.query_pairs`) finds every pair within the 500 km gate at each 60 s sample, then a straight-line closest-approach estimate (`_linear_closest_approach`) narrows that to pairs whose linear extrapolation lands inside `candidate_guard_km(reporting_threshold_km)` - the reporting threshold plus a curvature bound derived from LEO's maximum relative acceleration (~9 km in the current configuration).
  The 500 km gate itself is deliberately loose: at up to 15 km/s relative velocity, a tighter gate can let a pair approach and separate entirely between two 60 s samples, silently missing a real conjunction - the rationale is shipped in the output as `screening.coarse_gate_rationale`.
  For the India screen, `sweep_block_exhaustive()` skips the KD-tree gate entirely and differences every Indian operational object against the whole catalogue at every step, so nothing is excluded by a spatial pre-filter.
  `cluster_encounters()` then collapses same-pair samples within `ENCOUNTER_GAP_SECONDS = 600.0` of each other into one encounter, keeping the closest sample (292,147 distinct encounters in the sample run, from a combined 447,516 general pair-samples and 5,278 India pair-samples).

### 5. Fine screening to closest approach (pass 3)

**Module/function:** `screening.py`, `refine_pair()`, called per-encounter from `pipeline._refine_and_score()`.
**In:** one coarse-sample time per encounter.
**Out:** true time of closest approach, exact miss distance, relative velocity, and both objects' TEME state at that instant - or `None` if the pair doesn't survive.
**Thresholds:** `REFINE_STEP_SECONDS = 1.0`, `REFINE_WINDOW_SECONDS = COARSE_STEP_SECONDS` (both `screening.py`); `REPORTING_THRESHOLD_KM = 5.0`, `MIN_RELATIVE_VELOCITY_KM_S = 0.1` (`pipeline.py` / `risk.py`).

Resamples ±60 s around the coarse sample at a 1 s step, then solves the closest-approach vertex analytically from the bracketing state and re-propagates both objects at that exact instant - a 1 s grid alone is not accurate enough (at 14 km/s, a half-second grid offset can inflate a true 200 m miss to ~7 km).
An encounter is dropped here if the true miss distance is at or beyond the 5 km reporting threshold, or if the relative velocity at closest approach is below the 0.1 km/s formation-flying floor (see [The risk model](#the-risk-model)).
In the sample run, 292,147 candidate encounters refine down to 37,094 true conjunctions, with 1,058 further excluded as formation-flying.

### 6. Frame conversion

**Module/function:** `frames.py`, `teme_to_ecef()`, used from `output.py`'s `sample_track()`.
**In:** TEME position vectors and a UT1 Julian date.
**Out:** ECEF position vectors.

SGP4 output is TEME (inertial); screening and miss-distance math never need to leave that frame, since distance between two objects is frame-invariant.
Anything drawn relative to the ground does need ECEF, so the pre-sampled orbit `track` emitted per object carries both `positions_teme_km` and `positions_ecef_km`, converted point-by-point with that point's own Greenwich Mean Sidereal Time (IAU 1982 formula) - a single whole-ellipse rotation would be wrong, since the Earth keeps turning under the orbit through the sampled period.
Polar motion (under 20 m) is neglected as immaterial at the kilometre scale this pipeline reports.

### 7. Risk scoring

**Module:** `risk.py`.
See [The risk model](#the-risk-model) below for the full explanation; this stage produces `collision_probability`, `max_collision_probability`, and `risk_band` per conjunction.

### 8. Output writing

**Module/functions:** `output.py` (`object_block()`, `sample_track()`, `india_object_summary()`) + `pipeline.py` (`_build_conjunction()`, `run()`).
**In:** scored conjunctions plus their source catalogue objects.
**Out:** `data/output.json`, matching `docs/output-contract.md` exactly.

The expensive per-object detail (full orbit block, one-period track sample) is built only for the conjunctions that survive selection, not for all 37,094 scored candidates - `_refine_and_score()` deliberately returns a light record with no track, and `_build_conjunction()` fills in the full object blocks only afterward.
Selection is: collapse each object pair to its single worst encounter across the window (`pair_collapse_note` in the output - worst by risk band, then max Pc, then miss distance; 37,094 conjunctions collapse to 28,665 distinct pairs in the sample run), then keep the worst `GENERAL_LIST_CAP = 300` (`pipeline.py`) plus every India-related conjunction regardless of rank (540 conjunctions emitted in the sample run).
The full pre-cap counts (`conjunctions_found`, `distinct_pairs_found`) are always reported so nothing is dropped silently.

## The risk model

`risk.py` implements **Chan's (1997) method**, on the Foster (1992) formulation, for probability of collision (Pc).

**Why Pc, not distance.**
GP/TLE element sets carry no covariance - there is no measured uncertainty to read.
OrbitVision synthesises a 1-sigma position uncertainty from element-set age instead (`synthesized_sigma_km()`: 1 km at epoch, growing 2 km/day, against a published range of 1-3 km/day), which is a legitimate, standard workaround but is explicitly flagged in the output as modelled, not measured (`uncertainty_model.is_measured_covariance: false`).
Because this per-object sigma is a single isotropic value rather than a directional covariance, the combined uncertainty is isotropic by construction, which lets Chan's method reduce to a closed form: given the combined 1-sigma position uncertainty (`sigma`), the miss distance (`m`), and the combined hard-body radius (`R`),

```
Pc = P( noncentral-chi2(df=2, lambda=(m/sigma)^2) <= (R/sigma)^2 )
```

computed as a truncated Poisson-mixture series (`chan_pc()`), validated against `scipy.stats.ncx2` to ~1e-10 relative error.
Hard-body radius is looked up by SATCAT RCS size class (`HARD_BODY_RADIUS_M`: SMALL 0.25 m, MEDIUM 1.0 m, LARGE 3.0 m, UNKNOWN 1.0 m) - RCS is a radar cross-section proxy for physical size, not physical size itself.

**Nominal vs. maximum Pc.**
Pc is not monotonic in uncertainty: past a point, more covariance smears probability mass outside the hard-body radius and Pc falls again, so a stale, uncertain element set can score a *lower* nominal Pc than a fresh one at the same miss distance - the opposite of what worse data should imply.
`max_chan_pc()` searches (golden-section search, since Pc is unimodal in the covariance scale factor) for the scale that maximises Pc, following the NASA CARA maximum-Pc treatment.
**`risk_band()` is driven by `max_collision_probability` alone - never nominal Pc, and never miss distance.**
Nominal Pc is excluded because probability dilution can make stale data look deceptively safe; miss distance is excluded because `combined_position_sigma_km` in this engine's regime runs from single digits to tens of km, which dwarfs any fixed distance cutoff worth drawing - a 14 m miss and a 400 m miss are indistinguishable inside that error bar.

**Relative-velocity floor.**
`MIN_RELATIVE_VELOCITY_KM_S = 0.1`.
Chan's method defines an encounter plane from the relative-velocity direction and assumes locally linear relative motion across a brief flyby; both requirements need actual relative motion to exist.
Below this floor the method is *undefined*, not merely imprecise - `is_formation_flying()` screens these encounters out before scoring entirely (`screening.formation_flying_screen` in the output records the count: 1,058 in the sample run), rather than banding them LOW.
The floor sits an order of magnitude above published formation/station-keeping differential velocities (~0.01 km/s) and several orders of magnitude below genuine LEO conjunction speeds (up to ~15 km/s), so it is not tuned to any specific pair - see `MIN_RELATIVE_VELOCITY_KM_S`'s docstring for the full reasoning, including the COSMOS 2581/2582 and TIANHUI 2-02A/B examples.

**Band thresholds and provenance.** `RISK_BAND_RULES`, all on `max_collision_probability`:

| Band | Threshold | Real-world provenance |
|---|---|---|
| CRITICAL | `>= 1e-4` | NASA/CARA manoeuvre threshold for crewed assets (e.g. ISS) |
| HIGH | `>= 1e-5` | Standard CARA manoeuvre threshold for robotic spacecraft |
| MODERATE | `>= 1e-6` | General "conjunction of interest" watch threshold, NASA / 18th Space Defense Squadron practice |
| LOW | `< 1e-6` | - |

**Per-pair collapse.**
Covered in [stage 8](#8-output-writing) above - the same worst-first ordering (band, then max Pc, then miss distance) is used both to collapse repeat encounters of one pair and to rank the final list.

## Frontend architecture

| Module | Owns |
|---|---|
| `main.js` | Composition root: the single `state` object (mode, selected conjunction, scrub time, play/pause, speed), data-source resolution (`resolveDataUrl()`), all DOM event wiring, and the `requestAnimationFrame` render loop (`frame()` → `tickVisuals()`). |
| `globe.js` | The Cesium `Viewer` (`createGlobe()`), the bulk object cloud as a `PointPrimitiveCollection` for scrub performance (`buildObjectCloud()`), the highlighted pair's orbit polylines and markers for a selected conjunction (`highlightConjunction()`), and camera flights (`flyToConjunction()`, `flyToIndia()`). Also owns `BAND_COLOR`, a Cesium-side mirror of the CSS risk-band colours. |
| `ui.js` | The ranked-list cards (`renderRiskList()`), the detail panel (`renderDetail()`), the legend's log-scaled Pc ruler (`renderLegend()`, parsing live thresholds out of `risk_bands.rules` via `parsePcBoundary()` rather than duplicating the numbers), the mission-timeline scrub ticks (`renderTicks()`), and the day-gridline/label scaffolding (`renderRuler()`). |
| `data.js` | Loading the JSON file (`loadData()`), de-duplicating objects across the conjunction list (`uniqueObjects()`), and every display-string formatter (`fmtUtc`, `fmtDuration`, `fmtDayLabel`, `fmtClockTime`, `fmtCompactUtc`). |
| `propagate.js` | Client-side SGP4 via `satellite.js`: turns a contract `orbit` block directly into a satrec (`buildSatrec()`, no TLE string round-trip) and computes an ECEF position at an arbitrary date (`positionEcefKm()`) - this is what lets the globe animate continuously between the engine's pre-sampled track points. |

**State flow:** `main.js`'s `state` object is the single source of truth.
User input (the scrub slider, play/pause, a risk-card click, a mode switch) only ever mutates `state`; a `requestAnimationFrame` loop then calls `tickVisuals()` every frame, which reads `state.currentMs` and pushes it down into `cloud.update()` (globe.js), the active highlight's `.update()` (globe.js), and the clock/needle DOM text - regardless of whether the user is dragging, playing, or idle.
Nothing renders by reacting to a specific event; everything renders as a pure function of current state, recomputed continuously.
Mode switching (`setMode()`) swaps which conjunction list (`activeConjunctions()`) and which subset of NORAD IDs (`visibleNoradIds()`) are in scope, and re-renders the list and ticks accordingly.

**The time scrub drives everything.**
`state.currentMs` is the one clock in the system.
Dragging the slider, pressing play, or clicking a risk card (which jumps to five minutes before that conjunction's TCA via `jumpToTca()`) all just set `state.currentMs` and let the next animation frame do the rest.

## Design system

The pass-2 redesign (`src/style.css`, `index.html`) settled on two Google Fonts, not the three-font system of the original build:

- `--font-display` and `--font-body` are both **IBM Plex Sans** - one merged role covering the wordmark, nav, all uppercase labels and chrome, and the plain-language prose in the detail panel.
- `--font-data` is **IBM Plex Mono** - used for tabular/numeric readouts: the header's window/screened stats, detail-panel metric values, timestamps, and a risk card's inline max-Pc figure.
- Two numbers are deliberately set in the display face rather than the data face for visual weight: a risk card's hero miss-distance figure and the scrub bar's large clock readout.
  This is an intentional exception to "numbers are mono," not an inconsistency.

**Risk colour** uses four shared CSS custom properties (`--critical #FF3B47`, `--high #FF8A3D`, `--moderate #F2C94C`, `--low #4FD1C5`), mirrored on the Cesium side as `globe.js`'s `BAND_COLOR`.
It is never a flat colour strip or a pill/chip - it appears as band-coloured text, a small dot indicator, a soft gradient wash on a risk card's background, or a mark's position on a ruler.
Two ruler/axis idioms currently carry this: the legend's log-scaled Pc ruler, and the mission-timeline scrub bar's height- and colour-coded TCA ticks.
New UI extending risk-colour should reuse one of these two, not invent a third convention.

## How to run it

All commands below were run against this repository and produce what's described.

**Engine, offline** (default way to iterate - zero network calls, reads the committed snapshot):
```
PYTHONPATH=src python -m orbitvision --offline --out data/output.json
```
Needs a Python environment with `requirements.txt` installed (`pip install -r requirements.txt`).
A full run against the committed 15,587-object catalogue takes about 5 minutes and writes a ~21 MB `data/output.json`.

**Engine, live** (subject to CelesTrak's 2-hour cache and rate limit - see [Known limitations](#known-limitations-and-sharp-edges)):
```
PYTHONPATH=src python -m orbitvision --out data/output.json
```

**Frontend, dev server:**
```
npm install
npm run dev
```
Serves on `http://localhost:5173/` (or the next free port).
Loads `data/output.json` if present, else falls back to the fabricated `data/sample-output.json`.

**Frontend, production build and preview:**
```
npm run build
npm run preview
```
`npm run build` produces `dist/` (an `index.html`, one CSS bundle, one JS bundle) in under a second; `npm run preview` serves that build locally.

**Tests:**
```
PYTHONPATH=src python tests/test_risk.py
```
Plain assert-based, no framework - six checks covering Chan Pc at its extremes, max-Pc-never-below-nominal, the exact band thresholds, the formation-flying floor, and the perigee/apogee filter.

## What CI checks

`.github/workflows/tests.yml` runs on every push to `main` and every pull request: checks out the repo, sets up Python 3.12, installs `requirements.txt`, and runs `PYTHONPATH=src python tests/test_risk.py`.
There is no frontend build, lint, or test step in CI - a break in `src/*.js` or `src/style.css` is not caught automatically.

## Known limitations and sharp edges

- **CelesTrak rate limit.** High-traffic groups (including `active`) allow one download per real data refresh; a repeat request before the underlying data has actually changed returns HTTP 403, and CelesTrak firewalls clients over 100 MB/day outright.
  `ingest.py` caches both files to disk and refuses to re-fetch inside a 2-hour window, treating 403/404/301 as terminal (never retried).
  Always prefer `--offline` against the committed snapshot for iteration; the CelesTrak endpoints only refresh every two hours regardless, so polling faster gains nothing.
- **Two CSS traps**, both now called out in the code itself:
  - `.scrub-new .track` must stay `flex: none` with an explicit height; `flex: 1` collapses it to a hairline, because its implicit `flex-basis: 0` beats the explicit height in that column flex parent.
  - The `.unc-new` / `.india-new` glass overlays' `text-shadow` is load-bearing given their low background fill-opacity - remove it and the overlay text stops being legible over a bright day-side Earth background.
- **`docs/methodology.md` is referenced but does not exist.** Several source comments (`frames.py`, `pipeline.py`, `screening.py`) and the pipeline's own output text point to `docs/methodology.md` for GEO-scope rationale and frame-conversion detail.
  That file is not present in this repository; treat those references as pointing at a document that has not been written yet, not as a dead link to fix by removing the mention.
- **The dev-server data-file fallback is not reliable before the engine has run.** `main.js`'s `resolveDataUrl()` decides whether to load the real `data/output.json` or fall back to `data/sample-output.json` with a `HEAD` request and checks `res.ok`.
  Under `vite dev`, a request for a missing `data/output.json` does not 404 - Vite's dev-server SPA fallback returns `200 text/html` (the app shell) for it, so the `HEAD` check reports the file as present, the frontend then tries to `fetch()` and `JSON.parse()` that HTML, and the app fails to load with `Unexpected token '<'`.
  This only shows up on a clean checkout before the engine has produced a real `data/output.json`; once that file exists (or if you're running the production build via `npm run preview`, which does not have this fallback behaviour) it is not an issue.
- **GEO is out of scope.** The engine and the India screen both only cover LEO (`leo_apogee_limit_km`); a higher-orbit Indian asset is invisible to this pipeline entirely, not merely deprioritised.
- **Uncertainty is modelled, not measured**, everywhere in this system - see [The risk model](#the-risk-model).
  This is disclosed in the output itself (`uncertainty_model.summary`) and is not a bug, but it means every Pc figure in the UI is only as good as the age-based sigma model, not a true tracked-covariance figure.
