"""Assemble output matching docs/output-contract.md exactly.

Kept separate from pipeline.py (orchestration) and risk.py/screening.py
(computation) so the contract shape lives in one place.
"""

from datetime import timedelta

import numpy as np

from .frames import teme_to_ecef
from .propagate import jd_fr_at, propagate
from .timeutil import compact_utc, iso_utc

TRACK_POINT_COUNT = 60


def decide_primary_secondary(obj_a, obj_b):
    """Indian object first when exactly one is involved, else the lower NORAD id."""
    a_india = obj_a.owner_country == "IND"
    b_india = obj_b.owner_country == "IND"
    if a_india and not b_india:
        return obj_a, obj_b
    if b_india and not a_india:
        return obj_b, obj_a
    return (obj_a, obj_b) if obj_a.norad_id <= obj_b.norad_id else (obj_b, obj_a)


def sample_track(sat, tca_dt, period_minutes, point_count=TRACK_POINT_COUNT):
    """Pre-sample one full orbital period centred on TCA, in TEME and ECEF."""
    span_seconds = period_minutes * 60.0
    start_dt = tca_dt - timedelta(seconds=span_seconds / 2.0)
    step_seconds = span_seconds / (point_count - 1)
    seconds = np.arange(point_count, dtype=float) * step_seconds

    jd0, fr0 = jd_fr_at(start_dt)
    fr = fr0 + seconds / 86400.0
    jd = np.full(point_count, jd0)

    _err, r, _v = propagate([sat], jd, fr)
    positions_teme = r[0]
    positions_ecef = teme_to_ecef(positions_teme, jd + fr)

    return {
        "frame_note": "positions_teme_km is inertial (TEME); positions_ecef_km is Earth-fixed",
        "start_utc": iso_utc(start_dt),
        "step_seconds": round(step_seconds, 3),
        "point_count": point_count,
        "positions_teme_km": [[round(c, 3) for c in p] for p in positions_teme.tolist()],
        "positions_ecef_km": [[round(c, 3) for c in p] for p in positions_ecef.tolist()],
    }


def object_block(obj, epoch_dt, tca_dt, pos_km, vel_km_s, track):
    data_age_hours = (tca_dt - epoch_dt).total_seconds() / 3600.0
    return {
        "norad_id": obj.norad_id,
        "name": obj.name,
        "owner_country": obj.owner_country,
        "object_type": obj.object_type,
        "rcs_size": obj.rcs_size,
        "launch_date": obj.launch_date,
        "epoch_utc": obj.epoch_utc,
        "data_age_hours": round(data_age_hours, 3),
        "orbit": {
            "epoch_utc": obj.epoch_utc,
            "semi_major_axis_km": round(obj.semi_major_axis_km, 3),
            "eccentricity": round(obj.eccentricity, 7),
            "inclination_deg": round(obj.inclination_deg, 4),
            "ra_of_asc_node_deg": round(obj.ra_of_asc_node_deg, 4),
            "arg_of_pericenter_deg": round(obj.arg_of_pericenter_deg, 4),
            "mean_anomaly_deg": round(obj.mean_anomaly_deg, 4),
            "mean_motion_rev_per_day": obj.mean_motion_rev_per_day,
            "bstar": obj.bstar,
            "period_minutes": round(obj.period_minutes, 3),
            "perigee_altitude_km": round(obj.perigee_altitude_km, 3),
            "apogee_altitude_km": round(obj.apogee_altitude_km, 3),
        },
        "state_at_tca": {
            "frame": "TEME",
            "position_km": [round(c, 3) for c in pos_km],
            "velocity_km_s": [round(c, 3) for c in vel_km_s],
        },
        "track": track,
    }, data_age_hours


def conjunction_id(primary_norad, secondary_norad, tca_dt):
    return f"{primary_norad}-{secondary_norad}-{compact_utc(tca_dt)}"


def india_object_summary(obj, data_age_hours, conjunction_count, worst_risk_band):
    return {
        "norad_id": obj.norad_id,
        "name": obj.name,
        "object_type": obj.object_type,
        "rcs_size": obj.rcs_size,
        "launch_date": obj.launch_date,
        "data_age_hours": round(data_age_hours, 3),
        "conjunction_count": conjunction_count,
        "worst_risk_band": worst_risk_band,
    }
