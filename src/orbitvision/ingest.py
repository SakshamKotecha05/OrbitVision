"""CelesTrak GP and SATCAT ingest, with disk caching and rate-limit safety.

Since March 2026 CelesTrak enforces one-download-per-update on high-traffic
groups, including `active`: a repeat request before the underlying data has
actually refreshed returns HTTP 403, and clients exceeding 100 MB/day risk a
firewall block outright. CelesTrak itself only checks for new data once every
two hours, so polling faster gains nothing.

We therefore cache both files to disk, refuse to re-fetch a cache under two
hours old, and treat HTTP 403/404/301 as terminal: log clearly and stop,
never retry. The committed data/celestrak/ snapshot doubles as the seed
cache and as the fixture --offline runs from with zero network calls.
"""

import csv
import io
import json
from pathlib import Path

import requests

from .timeutil import iso_utc, now_utc, parse_iso

DATA_DIR = Path(__file__).resolve().parents[2] / "data" / "celestrak"
GP_FILE = DATA_DIR / "gp_active.json"
SATCAT_FILE = DATA_DIR / "satcat.csv"
META_FILE = DATA_DIR / "meta.json"

GP_ENDPOINT = "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json"
SATCAT_ENDPOINT = "https://celestrak.org/pub/satcat.csv"
USER_AGENT = (
    "OrbitVision-SIH2026-PS04/0.1 "
    "(SIH internal hackathon conjunction screening pipeline; "
    "contact: chogosihsoham@gmail.com)"
)

CACHE_MAX_AGE_SECONDS = 2 * 3600
TERMINAL_STATUS_CODES = {403, 404, 301}


class TerminalFetchError(RuntimeError):
    """A CelesTrak response we must log and stop on. Never retried."""


def _load_meta():
    if not META_FILE.exists():
        return {}
    return json.loads(META_FILE.read_text())


def _save_meta(meta):
    META_FILE.write_text(json.dumps(meta, indent=2) + "\n")


def _cache_is_fresh(meta, key):
    ts = meta.get(key)
    if not ts:
        return False
    age_seconds = (now_utc() - parse_iso(ts)).total_seconds()
    return 0 <= age_seconds < CACHE_MAX_AGE_SECONDS


def _fetch(url):
    resp = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=60)
    if resp.status_code in TERMINAL_STATUS_CODES:
        raise TerminalFetchError(
            f"CelesTrak returned HTTP {resp.status_code} for {url}. "
            "Treating this as terminal per project policy: not retrying. "
            "Use --offline, or wait for CelesTrak's next 2-hour refresh."
        )
    resp.raise_for_status()
    return resp.text


def _parse(gp_text, satcat_text):
    gp_records = json.loads(gp_text)
    satcat_rows = list(csv.DictReader(io.StringIO(satcat_text)))
    return gp_records, satcat_rows


def load(offline=False):
    """Return (gp_records, satcat_rows, source_meta) for the pipeline.

    offline=True: read the committed snapshot, zero network calls.
    Otherwise: serve from cache if under two hours old, else fetch fresh
    (server-side only) and refresh the cache.
    """
    if offline:
        if not GP_FILE.exists() or not SATCAT_FILE.exists():
            raise FileNotFoundError(
                "Offline mode requires data/celestrak/gp_active.json and "
                "satcat.csv. Run once without --offline to seed them."
            )
        meta = _load_meta()
        gp_records, satcat_rows = _parse(GP_FILE.read_text(), SATCAT_FILE.read_text())
        source = {
            "provider": "CelesTrak",
            "gp_endpoint": GP_ENDPOINT,
            "satcat_endpoint": SATCAT_ENDPOINT,
            "gp_retrieved_utc": meta.get("gp_retrieved_utc"),
            "satcat_retrieved_utc": meta.get("satcat_retrieved_utc"),
            "mode": "offline",
            "note": "Loaded from the committed offline snapshot. Zero network calls made.",
        }
        return gp_records, satcat_rows, source

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    meta = _load_meta()

    if _cache_is_fresh(meta, "gp_retrieved_utc") and GP_FILE.exists():
        print("[ingest] GP cache is fresh (< 2h old), skipping fetch")
    else:
        print(f"[ingest] cache stale or missing, fetching GP data from {GP_ENDPOINT}")
        GP_FILE.write_text(_fetch(GP_ENDPOINT))
        meta["gp_retrieved_utc"] = iso_utc(now_utc())
        _save_meta(meta)

    if _cache_is_fresh(meta, "satcat_retrieved_utc") and SATCAT_FILE.exists():
        print("[ingest] SATCAT cache is fresh (< 2h old), skipping fetch")
    else:
        print(f"[ingest] cache stale or missing, fetching SATCAT from {SATCAT_ENDPOINT}")
        SATCAT_FILE.write_text(_fetch(SATCAT_ENDPOINT))
        meta["satcat_retrieved_utc"] = iso_utc(now_utc())
        _save_meta(meta)

    gp_records, satcat_rows = _parse(GP_FILE.read_text(), SATCAT_FILE.read_text())
    source = {
        "provider": "CelesTrak",
        "gp_endpoint": GP_ENDPOINT,
        "satcat_endpoint": SATCAT_ENDPOINT,
        "gp_retrieved_utc": meta.get("gp_retrieved_utc"),
        "satcat_retrieved_utc": meta.get("satcat_retrieved_utc"),
        "mode": "live",
        "note": None,
    }
    return gp_records, satcat_rows, source
