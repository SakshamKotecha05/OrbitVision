# OrbitVision

Satellite conjunction risk dashboard.

OrbitVision tracks objects in Earth orbit, predicts upcoming close approaches between them, and scores how dangerous each one is.
It carries a dedicated, continuous screen for India's operational satellites.

Built for Smart India Hackathon 2026, problem statement PS-04.

## Status

Frontend is a working build against the frozen sample output.
See `docs/output-contract.md` for the schema it renders.

## Frontend

The frontend is a static Vite app: a CesiumJS globe, a ranked risk list, a time-scrub control, and a dedicated India view, all built against `data/sample-output.json`.
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

### Pointing it at a different data file

By default the app loads `data/sample-output.json` (served from `public/data/`, which is a symlink to the top-level `data/` directory).
To point it at a different file matching the same output contract, pass it as a `data` query parameter:

```
http://localhost:5173/?data=/path/to/other-output.json
```

The path must be reachable over HTTP from the dev/preview server, so either drop the file under `public/` or serve it separately and pass its full URL.
