# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Engine (src/orbitvision)

Run it: `PYTHONPATH=src python -m orbitvision --offline --out data/output.json` (no `pyproject.toml`, so `PYTHONPATH=src` is required; there is no installed console entry point).
Needs a venv with `numpy`, `scipy`, `requests`, `sgp4` (no `requirements.txt` committed).
`--offline` reads the committed `data/celestrak/` snapshot and makes zero network calls; without it, live fetches go through `src/orbitvision/ingest.py`'s two-hour cache.

CelesTrak enforces one-download-per-update on high-traffic groups (including `active`) and returns HTTP 403 on a repeat request before the underlying data has refreshed, with a firewall block over 100 MB/day.
Never re-fetch outside the two-hour cache window; `--offline` against the committed snapshot is the default way to iterate.

`docs/output-contract.md` pins the shape of `data/output.json` that the frontend (`src/*.js`, Vite + CesiumJS) reads.
Treat it as frozen: additive keys are fine and get documented in the contract and flagged in the PR that adds them (see PR #2 for the precedent: `screening.conjunctions_found`, `distinct_pairs_found`, `pair_collapse_note`, `general_list_cap`, `excluded_pairs`), but nothing existing gets renamed or removed without updating the frontend in the same change.

Each object pair is collapsed to its single worst encounter in the window before ranking (see `pair_collapse_note` in the output), since formation-flying and co-orbiting pairs (COSMOS 2581/2582, TIANHUI 2-02A/B) otherwise repeat every revolution and crowd the ranked list.
Encounters with a relative velocity below `risk.MIN_RELATIVE_VELOCITY_KM_S` at TCA are screened out before scoring, not banded LOW: Chan's method needs relative motion to define the encounter plane, and formation-flying pairs like the two above are exactly this case (see `risk.is_formation_flying` and `screening.formation_flying_screen` in the output for the count excluded).
Risk band comes from `max_collision_probability` alone (see `risk.risk_band`); miss distance was removed from the rule because `combined_position_sigma_km` in this run (single digits to tens of km) dwarfs any distance cutoff worth drawing.

Test: `python tests/test_risk.py` (plain assert-based, no framework) guards the pure Chan-Pc / risk-band / screening-filter logic in `risk.py` and `screening.py`.

## Frontend visual identity (src/style.css, index.html)

The console's type system is three Google Fonts, each with one job: `--font-display` (Martian Mono) for the wordmark, nav, and uppercase labels; `--font-data` (IBM Plex Mono) for numbers and timestamps; `--font-body` (Newsreader, a serif) for the plain-language sentences in risk rows and the detail panel.
Keep new UI in one of these three roles rather than introducing a fourth face or falling back to a system sans.

Risk is never encoded as a flat colour strip or a pill/chip.
The ranked list uses a log-scaled miss-distance ruler (`missRulerHTML` in `src/ui.js`) reading against `screening.reporting_threshold_km`, since that threshold can differ per run (5 km in the current engine config, 10 km in the committed sample); the mark on it is coloured by that row's actual `risk_band`, which no longer correlates with position on the axis (risk_band is driven by max Pc alone, see risk.py) so don't read the two as linked.
The bottom-left legend (`renderLegend` in `src/ui.js`) is a separate log-scaled ruler over `max_collision_probability`, parsed from `risk_bands.rules`, since that is what actually drives the band.
Extend the ruler pattern rather than adding a second risk-colour convention.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
