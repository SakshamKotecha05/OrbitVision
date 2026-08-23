"""OrbitVision pipeline: ingest -> propagate -> screen -> score -> write.

Run live:    python -m orbitvision --offline
Run offline: python -m orbitvision

See README.md and docs/output-contract.md.
"""

import argparse
import json
import time
from datetime import timedelta
from pathlib import Path

import numpy as np

from . import __version__, catalog, ingest, output, risk, screening
from .propagate import build_satrec, propagate, time_grid
from .timeutil import iso_utc, now_utc, parse_iso

LEO_APOGEE_LIMIT_KM = 2000.0
WINDOW_HOURS = 72.0
REPORTING_THRESHOLD_KM = 5.0
INDIA_OWNER_CODES = ["IND"]
# SATCAT OPS_STATUS_CODE: '+' operational, 'P' partially operational,
# 'B' backup/standby, 'S' spare, 'X' extended mission. All of these are live
# spacecraft an operator would manoeuvre; 'D' (decayed) and '?' are not.
INDIA_OPERATIONAL_STATUS_CODES = {"+", "P", "B", "S", "X"}

# Propagating the whole catalogue across the whole window at once is ~3 GB of
# state vectors. The sweep only ever looks at one timestep at a time, so the
# window is processed in blocks and the arrays are reused.
BLOCK_STEPS = 240

# Mega-constellation satellites are ~75% of the active LEO catalogue and sit
# in a handful of dense shells, so pairs of them account for the large
# majority of all close approaches. Those INTERNAL pairs are excluded from
# screening: the operator flies both objects, coordinates them with its own
# continuous automated system, and no external party can act on the event.
# Only same-constellation pairs are dropped. A mega-constellation satellite
# against debris, a rocket body, another operator's spacecraft or an Indian
# satellite is screened normally and reported normally. See
# docs/methodology.md.
MEGA_CONSTELLATIONS = {"STARLINK": 1, "ONEWEB": 2}

# Only the worst N conjunctions are written out. A 15,000-object LEO
# catalogue genuinely produces tens of thousands of sub-5 km approaches in 72
# hours -- that is the real rate, not a bug -- and emitting all of them makes
# a file no dashboard can load. Operational services publish a ranked subset
# for the same reason. The cap applies ONLY to the general list: every
# India-related conjunction is emitted regardless of rank, and the true
# pre-cap total is reported as conjunctions_found so nothing is dropped
# silently.
GENERAL_LIST_CAP = 300

# CelesTrak issues one identical element set to every component of a docked
# assembly: the ISS modules and their visiting vehicles all share a single
# GP record under separate catalogue numbers, as do the CSS modules, and a
# servicing vehicle docked to its client. Those are one physical structure,
# so a "conjunction" between two of them is an artefact at 0.0 km and 0.0
# km/s, not an encounter. Objects sharing an element set are grouped and
# never screened against each other.
ASSEMBLY_FINGERPRINT_FIELDS = (
    "EPOCH", "MEAN_MOTION", "ECCENTRICITY", "INCLINATION",
    "RA_OF_ASC_NODE", "ARG_OF_PERICENTER", "MEAN_ANOMALY",
)

SCHEMA_VERSION = "1.0.0"


def _constellation_groups(objects):
    groups = np.zeros(len(objects), dtype=np.int8)
    for i, obj in enumerate(objects):
        for marker, gid in MEGA_CONSTELLATIONS.items():
            if marker in obj.name:
                groups[i] = gid
                break
    return groups


def _assembly_groups(objects):
    """Group objects that share an element set; 0 means "not part of an assembly"."""
    seen = {}
    for obj in objects:
        key = tuple(str(obj.gp.get(f)) for f in ASSEMBLY_FINGERPRINT_FIELDS)
        seen.setdefault(key, []).append(obj.norad_id)

    groups = np.zeros(len(objects), dtype=np.int32)
    gid = 0
    shared = {}
    for key, members in seen.items():
        if len(members) > 1:
            gid += 1
            shared[key] = gid
    for i, obj in enumerate(objects):
        key = tuple(str(obj.gp.get(f)) for f in ASSEMBLY_FINGERPRINT_FIELDS)
        groups[i] = shared.get(key, 0)
    return groups


def run(offline=False, out_path=None, window_hours=WINDOW_HOURS,
        reporting_threshold_km=REPORTING_THRESHOLD_KM, max_objects=None):
    t_start = time.monotonic()
    window_start = now_utc()

    gp_records, satcat_rows, source = ingest.load(offline=offline)
    objects = catalog.build_catalog(gp_records, satcat_rows, LEO_APOGEE_LIMIT_KM)
    if max_objects:
        objects = objects[:max_objects]
    by_norad = {obj.norad_id: obj for obj in objects}
    print(f"[pipeline] {len(objects)} LEO objects with current GP elements")

    india_norad_ids = _india_operational_norad_ids(satcat_rows, by_norad)
    india_ids = set(india_norad_ids)
    india_indices = np.array([i for i, o in enumerate(objects) if o.norad_id in india_ids],
                             dtype=int)
    print(f"[pipeline] {len(india_norad_ids)} Indian operational LEO objects")

    groups = _constellation_groups(objects)
    assemblies = _assembly_groups(objects)
    n_assembly_objects = int((assemblies > 0).sum())
    print(f"[pipeline] {n_assembly_objects} objects share an element set with another "
          f"(docked assemblies); those internal pairs are not screened")
    perigee_km = np.array([o.perigee_altitude_km for o in objects])
    apogee_km = np.array([o.apogee_altitude_km for o in objects])
    pad_km = screening.COARSE_GATE_KM

    pairs_after_p1 = screening.perigee_apogee_survivor_count(perigee_km, apogee_km, pad_km)
    print(f"[pipeline] pass 1 (perigee/apogee, Hoots 1984): {pairs_after_p1} of "
          f"{len(objects) * (len(objects) - 1) // 2} pairs survive")

    def pair_allowed(gi, gj):
        # Pass 1 re-applied per candidate pair, plus the intra-constellation rule.
        ok = screening.perigee_apogee_can_conjunct(
            perigee_km[gi], apogee_km[gi], perigee_km[gj], apogee_km[gj], pad_km)
        same_mega = (groups[gi] == groups[gj]) & (groups[gi] > 0)
        same_body = (assemblies[gi] == assemblies[gj]) & (assemblies[gi] > 0)
        return ok & ~same_mega & ~same_body

    satrecs = [build_satrec(o) for o in objects]
    guard_km = screening.candidate_guard_km(reporting_threshold_km)
    step = screening.COARSE_STEP_SECONDS
    total_steps = int(window_hours * 3600.0 / step) + 1

    gen_parts, ind_parts = [], []
    t0 = time.monotonic()
    for block_start in range(0, total_steps, BLOCK_STEPS):
        n_steps = min(BLOCK_STEPS, total_steps - block_start)
        block_t0 = window_start + timedelta(seconds=block_start * step)
        jd, fr, secs = time_grid(block_t0, (n_steps - 1) * step, step)
        err, r_teme, v_teme = propagate(satrecs, jd, fr)
        valid = err == 0
        abs_secs = secs + block_start * step

        gen_parts.append(screening.sweep_block_gated(
            r_teme, v_teme, valid, abs_secs, guard_km, pair_allowed=pair_allowed))
        ind_parts.append(screening.sweep_block_exhaustive(
            r_teme, v_teme, valid, abs_secs, india_indices, guard_km))
        print(f"[pipeline] pass 2: {block_start + n_steps}/{total_steps} steps "
              f"({time.monotonic() - t0:.0f}s)", flush=True)

    gen = [np.concatenate([p[k] for p in gen_parts]) for k in range(4)]
    ind = [np.concatenate([p[k] for p in ind_parts]) for k in range(4)]
    print(f"[pipeline] pass 2 gated sweep: {len(gen[0])} pair-samples inside "
          f"{guard_km:.0f} km; India exhaustive sweep: {len(ind[0])}")

    merged = [np.concatenate([gen[k], ind[k]]) for k in range(4)]
    encounters = screening.cluster_encounters(*merged)
    print(f"[pipeline] pass 2: {len(encounters)} distinct encounters to refine")

    # Pass 3a: refine every encounter to a true TCA and score it. Kept
    # deliberately light -- no orbit tracks, no output blocks -- because
    # there are tens of thousands of these and only the ranked survivors
    # need the expensive per-object detail built for them.
    scored = []
    screen_counts = {"formation_flying": 0}
    t0 = time.monotonic()
    for n, (i, j, t_sec, _d_pred) in enumerate(encounters):
        if assemblies[i] > 0 and assemblies[i] == assemblies[j]:
            continue
        hit = _refine_and_score(objects[i], objects[j], satrecs[i], satrecs[j],
                                window_start + timedelta(seconds=t_sec),
                                reporting_threshold_km, screen_counts=screen_counts)
        if hit is not None:
            scored.append(hit)
        if (n + 1) % 25000 == 0:
            print(f"[pipeline] pass 3: {n + 1}/{len(encounters)} refined "
                  f"({time.monotonic() - t0:.0f}s)", flush=True)

    scored.sort(key=_sort_key)
    conjunctions_found = len(scored)
    print(f"[pipeline] pass 3: {conjunctions_found} conjunctions within "
          f"{reporting_threshold_km} km in {time.monotonic() - t0:.0f}s")

    # Collapse each object pair to its single worst encounter across the
    # whole window, worst meaning the same criterion used to rank the final
    # list: worst risk band, then highest max_collision_probability, then
    # lowest miss_distance_km. Formation-flying and co-orbiting pairs (see
    # COSMOS 2581/2582, TIANHUI 2-02A/B) stay close on every revolution and
    # would otherwise repeat dozens of times, pushing genuinely distinct
    # risks out from under the general list cap. scored is already sorted
    # worst-first, so keeping the first occurrence per pair keeps the worst.
    seen_pairs = set()
    collapsed = []
    for s in scored:
        pair_key = (s["_primary_obj"].norad_id, s["_secondary_obj"].norad_id)
        if pair_key in seen_pairs:
            continue
        seen_pairs.add(pair_key)
        collapsed.append(s)
    distinct_pairs_found = len(collapsed)
    print(f"[pipeline] pair collapse: {conjunctions_found} conjunctions over "
          f"{distinct_pairs_found} distinct pairs")

    # Rank, then keep the top of the general list plus every India-related
    # conjunction, whatever its rank.
    selected = collapsed[:GENERAL_LIST_CAP]
    selected_ids = {id(s) for s in selected}
    selected += [s for s in collapsed[GENERAL_LIST_CAP:]
                 if s["india_related"] and id(s) not in selected_ids]
    selected.sort(key=_sort_key)

    conjunctions = [_build_conjunction(s) for s in selected]
    print(f"[pipeline] emitting {len(conjunctions)} conjunctions "
          f"(general cap {GENERAL_LIST_CAP}, all India-related kept)")

    india_conjunctions = [c for c in conjunctions if c["india_related"]]
    india_objects_block = _build_india_objects(
        india_norad_ids, by_norad, conjunctions, window_start)

    runtime_seconds = time.monotonic() - t_start
    doc = {
        "schema_version": SCHEMA_VERSION,
        "generated_at_utc": iso_utc(now_utc()),
        "generator": f"orbitvision-pipeline {__version__}",
        "source": source,
        "screening": {
            "window_start_utc": iso_utc(window_start),
            "window_end_utc": iso_utc(window_start + timedelta(hours=window_hours)),
            "window_hours": window_hours,
            "regime": "LEO",
            "leo_apogee_limit_km": LEO_APOGEE_LIMIT_KM,
            "frame": "TEME",
            "frame_note": (
                "Screening distances are computed in TEME and are frame-invariant. "
                "Every Earth-relative coordinate emitted in this file is converted "
                "to ECEF and labelled as such."
            ),
            "perigee_apogee_pad_km": pad_km,
            "coarse_step_seconds": step,
            "coarse_gate_km": screening.COARSE_GATE_KM,
            "coarse_gate_rationale": screening.COARSE_GATE_RATIONALE,
            "refine_step_seconds": screening.REFINE_STEP_SECONDS,
            "reporting_threshold_km": reporting_threshold_km,
            "objects_screened": len(objects),
            "pairs_total": len(objects) * (len(objects) - 1) // 2,
            "pairs_after_perigee_apogee_filter": pairs_after_p1,
            "pairs_after_coarse_sweep": len(encounters),
            "conjunctions_found": conjunctions_found,
            "distinct_pairs_found": distinct_pairs_found,
            "pair_collapse_note": (
                "Each object pair is collapsed to its single worst encounter "
                "across the whole window before ranking and capping, worst "
                "meaning the same criterion used to rank the final list: "
                "worst risk band, then highest max_collision_probability, "
                "then lowest miss_distance_km. Formation-flying and "
                "co-orbiting pairs stay close on every revolution and would "
                "otherwise repeat dozens of times and crowd out genuinely "
                "distinct risks under the cap. conjunctions_found is the "
                "count before this collapse; distinct_pairs_found is after "
                "it and before the general_list_cap."
            ),
            "general_list_cap": GENERAL_LIST_CAP,
            "formation_flying_screen": risk.formation_flying_screen_block(
                screen_counts["formation_flying"]),
            "conjunctions_reported": len(conjunctions),
            "runtime_seconds": round(runtime_seconds, 3),
            "excluded_pairs": {
                "rules": ["same_mega_constellation", "same_docked_assembly"],
                "constellations": sorted(MEGA_CONSTELLATIONS),
                "objects_in_excluded_constellations": int((groups > 0).sum()),
                "objects_in_docked_assemblies": n_assembly_objects,
                "note": (
                    "Two kinds of pair are never screened. Pairs where BOTH objects "
                    "belong to the same mega-constellation: the operator flies both "
                    "and runs its own continuous automated collision avoidance, and "
                    "no third party can act on the event. Pairs that share an "
                    "element set: CelesTrak catalogues each component of a docked "
                    "assembly separately but issues one set of elements for the "
                    "stack, so those are one physical structure, not an encounter. "
                    "Both kinds of object are screened normally against everything "
                    "else, and the India screen is exhaustive against the complete "
                    "catalogue."
                ),
            },
        },
        "uncertainty_model": risk.uncertainty_model_block(),
        "risk_bands": risk.risk_bands_block(),
        "conjunctions": conjunctions,
        "india": {
            "screen_kind": "exhaustive",
            "screen_note": (
                "Every Indian operational LEO satellite is differenced against every "
                "other catalogued LEO object at every 60 s step of the window, with "
                "no spatial gate, no pair pre-filter and no subsetting. GEO is out "
                "of scope: this engine screens LEO only."
            ),
            "owner_country_codes": INDIA_OWNER_CODES,
            "objects_screened": len(india_norad_ids),
            "objects": india_objects_block,
            "conjunctions": india_conjunctions,
        },
    }

    out_path = Path(out_path) if out_path else Path("data/output.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(doc, indent=2) + "\n")
    print(f"[pipeline] wrote {out_path} ({out_path.stat().st_size} bytes) "
          f"in {runtime_seconds:.1f}s")
    return doc


def _refine_and_score(obj_a, obj_b, sat_a, sat_b, coarse_time, reporting_threshold_km,
                      screen_counts=None):
    """Refine to true TCA and score. Deliberately light: no orbit tracks, no
    output blocks, since only the ranked survivors need that expensive
    per-object detail (see _build_conjunction)."""
    primary, secondary = output.decide_primary_secondary(obj_a, obj_b)
    sat_p, sat_s = (sat_a, sat_b) if primary is obj_a else (sat_b, sat_a)

    refined = screening.refine_pair(sat_p, sat_s, coarse_time)
    if refined is None or refined["miss_distance_km"] >= reporting_threshold_km:
        return None
    if risk.is_formation_flying(refined["relative_velocity_km_s"]):
        if screen_counts is not None:
            screen_counts["formation_flying"] += 1
        return None

    tca_dt = coarse_time + timedelta(seconds=refined["tca_offset_seconds"])
    primary_age_h = (tca_dt - parse_iso(primary.epoch_utc)).total_seconds() / 3600.0
    secondary_age_h = (tca_dt - parse_iso(secondary.epoch_utc)).total_seconds() / 3600.0

    combined_sigma_km = (risk.synthesized_sigma_km(primary_age_h) ** 2
                         + risk.synthesized_sigma_km(secondary_age_h) ** 2) ** 0.5
    hbr_m = risk.combined_hard_body_radius_m(primary.rcs_size, secondary.rcs_size)
    miss_km = refined["miss_distance_km"]
    pc = risk.chan_pc(miss_km, combined_sigma_km, hbr_m / 1000.0)
    max_pc = risk.max_chan_pc(miss_km, combined_sigma_km, hbr_m / 1000.0)

    return {
        "id": output.conjunction_id(primary.norad_id, secondary.norad_id, tca_dt),
        "tca_utc": iso_utc(tca_dt),
        "miss_distance_km": round(miss_km, 3),
        "relative_velocity_km_s": round(refined["relative_velocity_km_s"], 3),
        "collision_probability": pc,
        "max_collision_probability": max_pc,
        "combined_hard_body_radius_m": round(hbr_m, 3),
        "combined_position_sigma_km": round(combined_sigma_km, 3),
        "data_age_hours": round(max(primary_age_h, secondary_age_h), 3),
        "risk_band": risk.risk_band(max_pc),
        "india_related": primary.owner_country == "IND" or secondary.owner_country == "IND",
        "_primary_obj": primary,
        "_secondary_obj": secondary,
        "_sat_p": sat_p,
        "_sat_s": sat_s,
        "_tca_dt": tca_dt,
        "_pos_p_km": refined["pos_i_km"],
        "_vel_p_km_s": refined["vel_i_km_s"],
        "_pos_s_km": refined["pos_j_km"],
        "_vel_s_km_s": refined["vel_j_km_s"],
    }


def _build_conjunction(s):
    """Build the full per-object blocks (orbit track included) for one
    scored survivor. Called only for the selected/capped subset."""
    primary, secondary = s["_primary_obj"], s["_secondary_obj"]
    tca_dt = s["_tca_dt"]
    primary_block, _ = output.object_block(
        primary, parse_iso(primary.epoch_utc), tca_dt,
        s["_pos_p_km"], s["_vel_p_km_s"],
        output.sample_track(s["_sat_p"], tca_dt, primary.period_minutes))
    secondary_block, _ = output.object_block(
        secondary, parse_iso(secondary.epoch_utc), tca_dt,
        s["_pos_s_km"], s["_vel_s_km_s"],
        output.sample_track(s["_sat_s"], tca_dt, secondary.period_minutes))
    conj = {k: v for k, v in s.items() if not k.startswith("_")}
    conj["primary"] = primary_block
    conj["secondary"] = secondary_block
    return conj


def _india_operational_norad_ids(satcat_rows, by_norad):
    ids = []
    for row in satcat_rows:
        if row.get("OWNER") != "IND":
            continue
        if row.get("OPS_STATUS_CODE") not in INDIA_OPERATIONAL_STATUS_CODES:
            continue
        nid = row.get("NORAD_CAT_ID")
        if nid and int(nid) in by_norad:
            ids.append(int(nid))
    return ids


def _build_india_objects(india_norad_ids, by_norad, conjunctions, window_start):
    band_rank = {b: i for i, b in enumerate(risk.RISK_BAND_ORDER)}
    per_object = {nid: [] for nid in india_norad_ids}
    for c in conjunctions:
        for role in ("primary", "secondary"):
            nid = c[role]["norad_id"]
            if nid in per_object:
                per_object[nid].append(c["risk_band"])

    rows = []
    for nid in india_norad_ids:
        obj = by_norad[nid]
        bands = per_object[nid]
        worst = min(bands, key=lambda b: band_rank[b]) if bands else None
        age_h = (window_start - parse_iso(obj.epoch_utc)).total_seconds() / 3600.0
        rows.append(output.india_object_summary(obj, age_h, len(bands), worst))
    return rows


def _sort_key(c):
    band_rank = {b: i for i, b in enumerate(risk.RISK_BAND_ORDER)}
    return (band_rank[c["risk_band"]], -c["max_collision_probability"], c["miss_distance_km"])


def main():
    parser = argparse.ArgumentParser(description="OrbitVision conjunction risk pipeline")
    parser.add_argument("--offline", action="store_true",
                        help="Run from the committed snapshot, making zero network calls")
    parser.add_argument("--out", default="data/output.json", help="Output JSON path")
    parser.add_argument("--window-hours", type=float, default=WINDOW_HOURS)
    parser.add_argument("--threshold-km", type=float, default=REPORTING_THRESHOLD_KM,
                        help="Report conjunctions closer than this")
    parser.add_argument("--max-objects", type=int, default=None,
                        help="Screen only the first N catalogue objects (development aid)")
    args = parser.parse_args()
    run(offline=args.offline, out_path=args.out, window_hours=args.window_hours,
        reporting_threshold_km=args.threshold_km, max_objects=args.max_objects)


if __name__ == "__main__":
    main()
