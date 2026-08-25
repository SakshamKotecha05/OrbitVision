# OrbitVision

Satellite conjunction risk dashboard.

## Why this exists

There are tens of thousands of tracked objects in orbit around Earth: working satellites, dead satellites, spent rocket stages, and debris from old collisions.
All of them are moving at several kilometres per second, fast enough that a graze destroys both objects involved and sprays out a cloud of new debris that threatens everything else nearby.

A satellite operator can move a satellite out of the way of an oncoming object, but only if they know the danger is coming, and only by spending fuel, a resource no satellite can restock in orbit.
The real question an operator faces is which of the many daily close passes are actually worth spending that fuel on.

OrbitVision is a prototype built to answer that question.
It reads a public catalogue of tracked objects, predicts where each one will be over the next three days, finds the pairs that come dangerously close, and scores how dangerous each encounter is: not by how close the two objects pass, but by the probability that they actually collide.
It carries a dedicated, continuous screen for India's operational satellites.

Built for Smart India Hackathon 2026, problem statement PS-04.

## Documentation

- [`docs/overview.md`](docs/overview.md) - the project explained in plain language, no orbital-mechanics or software background needed. Start here if you're presenting or reviewing OrbitVision without having read the code.
- [`docs/architecture.md`](docs/architecture.md) - the full technical architecture: stack, engine pipeline, risk model, frontend structure, design system, and how to run everything. Start here if you're working on the code.
- [`docs/output-contract.md`](docs/output-contract.md) - the frozen shape of `data/output.json`, the single contract between the engine and the frontend.

## Using the dashboard

Open the dashboard and you land on Global Screen: a 3D globe with every tracked object moving along its orbit, and a ranked list of risky conjunctions on the right, worst first.

Each row in the list is one encounter between two objects: which two, how close they pass, and a risk band.
Click a row and three things happen at once: the globe flies to that encounter and draws both orbital paths, a detail panel opens with the full numbers behind the score, and the clock jumps to five minutes before closest approach so you can watch it happen.

The **time scrub** along the bottom is a slider across the whole prediction window (72 hours by default).
Drag it, or press play, and every object on the globe moves to its position at that moment.
Marks along the scrub bar show when each listed encounter occurs, taller for the more dangerous ones.

**India Watch**, the second tab at the top, narrows the list to only the encounters involving an Indian-operated satellite.
Those satellites are screened against the entire catalogue with no shortcuts taken, so this isn't just the general list filtered down; it's an independent, exhaustive check.

Every encounter is rated CRITICAL, HIGH, MODERATE, or LOW, based on its maximum probability of collision, never on how close the two objects pass.
Two objects with old, uncertain tracking data can be a bigger risk at 400 metres apart than two objects with fresh data at 300 metres.
The legend in the bottom-left corner shows the probability thresholds behind each band.
See [`docs/overview.md`](docs/overview.md) for why probability is the right way to rank these encounters, and why some near-misses are deliberately left off the list entirely.

## Status

Both halves are working: the engine (`src/orbitvision/`) and the frontend, wired together against `docs/output-contract.md`.
See that file for the schema the pipeline writes and the frontend renders.

## Engine

`src/orbitvision/` ingests cached CelesTrak GP/SATCAT data, propagates the LEO catalogue with SGP4, screens for close approaches, and scores each one, writing `data/output.json`.
The CelesTrak snapshot is committed under `data/celestrak/` so the pipeline runs fully offline from a clean clone; do not re-fetch it outside its own two-hour cache window, since CelesTrak rate-limits repeat requests.

Install dependencies once:

```
pip install -r requirements.txt
```

Generate the real output file:

```
PYTHONPATH=src python -m orbitvision --offline --out data/output.json
```

See [`docs/architecture.md`](docs/architecture.md) for the full dependency list, the pipeline stage by stage, and the risk model behind the scores.

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
