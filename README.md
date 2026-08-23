# OrbitVision

Satellite conjunction risk dashboard.

OrbitVision tracks objects in Earth orbit, predicts upcoming close approaches between them, and scores how dangerous each one is.
It carries a dedicated, continuous screen for India's operational satellites.

Built for Smart India Hackathon 2026, problem statement PS-04.

## Status

Both halves are working: the engine (`src/orbitvision/`) and the frontend, wired together against `docs/output-contract.md`.
See that file for the schema the pipeline writes and the frontend renders.

## Engine

`src/orbitvision/` ingests cached CelesTrak GP/SATCAT data, propagates the LEO catalogue with SGP4, screens for close approaches, and scores each one, writing `data/output.json`.
The CelesTrak snapshot is committed under `data/celestrak/` so the pipeline runs fully offline from a clean clone; do not re-fetch it outside its own two-hour cache window, since CelesTrak rate-limits repeat requests.

Generate the real output file:

```
PYTHONPATH=src python -m orbitvision --offline --out data/output.json
```

See `AGENTS.md` for dependency setup and more detail.

## Frontend

The frontend is a static Vite app: a CesiumJS globe, a ranked risk list, a time-scrub control, and a dedicated India view.
It has no server component and no network dependency at runtime; CesiumJS is configured with bundled offline imagery only (no Cesium ion token, no CDN assets).

Install dependencies once:

```
npm install
```

Run the dev server:

```
npm run dev
```

Build and preview the production bundle:

```
npm run build
npm run preview
```

### Which data file it loads

The app loads `data/output.json` (served from `public/data/`, which is a symlink to the top-level `data/` directory) when that file exists, and falls back to the fabricated `data/sample-output.json` when it does not, so the demo still runs before the engine has been run.
Generate the real file with the command in [Engine](#engine) above.
To point it at a different file matching the same output contract, pass it as a `data` query parameter:

```
http://localhost:5173/?data=/path/to/other-output.json
```

The path must be reachable over HTTP from the dev/preview server, so either drop the file under `public/` or serve it separately and pass its full URL.
