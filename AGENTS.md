# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Engine (src/orbitvision)

Run it: `PYTHONPATH=src python -m orbitvision --offline --out data/output.json` (no `pyproject.toml`, so `PYTHONPATH=src` is required; there is no installed console entry point).
Needs a venv with `numpy`, `scipy`, `requests`, `sgp4` (no `requirements.txt` committed).
`--offline` reads `data/celestrak/` (gitignored, not committed) and makes zero network calls; without it, live fetches go through `src/orbitvision/ingest.py`'s two-hour cache.

CelesTrak enforces one-download-per-update on high-traffic groups (including `active`) and returns HTTP 403 on a repeat request before the underlying data has refreshed, with a firewall block over 100 MB/day.
Never re-fetch outside the two-hour cache window; `--offline` against the committed snapshot is the default way to iterate.

`docs/output-contract.md` pins the shape of `data/output.json` that the frontend (`src/*.js`, Vite + CesiumJS) reads.
Treat it as frozen: additive keys are fine and get flagged in the PR that adds them (see PR #2 for the precedent: `screening.conjunctions_found`, `general_list_cap`, `excluded_pairs`), but nothing existing gets renamed or removed without updating the frontend in the same change.

Test: `python tests/test_risk.py` (plain assert-based, no framework) guards the pure Chan-Pc / risk-band / screening-filter logic in `risk.py` and `screening.py`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
