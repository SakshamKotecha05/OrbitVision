"""Join CelesTrak GP element sets with SATCAT catalogue metadata.

Produces one CatalogObject per NORAD ID that has a current GP element set,
restricted to LEO (see build_catalog). SATCAT fields (owner, object type,
RCS size, launch date) are attached where available; a GP record with no
SATCAT row still gets a catalog object, with those fields UNKNOWN/null,
since GP is the propagation-critical source and SATCAT is metadata.
"""

import math
from dataclasses import dataclass
from datetime import timezone

from .timeutil import iso_utc

GM_EARTH_KM3_S2 = 398600.4418  # WGS84 standard gravitational parameter of Earth
EARTH_RADIUS_KM = 6378.137  # WGS84 equatorial radius; matches output-contract.md

OBJECT_TYPE_MAP = {
    "PAY": "PAYLOAD",
    "R/B": "ROCKET BODY",
    "DEB": "DEBRIS",
}

# RCS_SIZE buckets per docs/output-contract.md and the SIH spec review:
# radar cross-section in m^2, a proxy for physical size, not physical size.
RCS_SMALL_MAX_M2 = 0.1
RCS_MEDIUM_MAX_M2 = 1.0


def object_type_from_satcat(code):
    return OBJECT_TYPE_MAP.get(code, "UNKNOWN")


def rcs_size_from_m2(value):
    if value is None or value == "":
        return "UNKNOWN"
    v = float(value)
    if v < RCS_SMALL_MAX_M2:
        return "SMALL"
    if v <= RCS_MEDIUM_MAX_M2:
        return "MEDIUM"
    return "LARGE"


@dataclass
class CatalogObject:
    norad_id: int
    name: str
    owner_country: object  # str or None
    object_type: str
    rcs_size: str
    launch_date: object  # str or None
    gp: dict  # raw GP fields, as needed by sgp4.omm.initialize
    epoch_utc: str
    semi_major_axis_km: float
    eccentricity: float
    inclination_deg: float
    ra_of_asc_node_deg: float
    arg_of_pericenter_deg: float
    mean_anomaly_deg: float
    mean_motion_rev_per_day: float
    bstar: float
    period_minutes: float
    perigee_altitude_km: float
    apogee_altitude_km: float


def _derive_orbit(mean_motion_rev_per_day, eccentricity):
    n_rad_s = mean_motion_rev_per_day * 2.0 * math.pi / 86400.0
    a_km = (GM_EARTH_KM3_S2 / (n_rad_s ** 2)) ** (1.0 / 3.0)
    perigee_altitude_km = a_km * (1.0 - eccentricity) - EARTH_RADIUS_KM
    apogee_altitude_km = a_km * (1.0 + eccentricity) - EARTH_RADIUS_KM
    period_minutes = 1440.0 / mean_motion_rev_per_day
    return a_km, perigee_altitude_km, apogee_altitude_km, period_minutes


def build_catalog(gp_records, satcat_rows, leo_apogee_limit_km):
    """Return CatalogObjects for GP records restricted to LEO by apogee altitude."""
    satcat_by_id = {}
    for row in satcat_rows:
        nid = row.get("NORAD_CAT_ID")
        if nid:
            satcat_by_id[int(nid)] = row

    objects = []
    for rec in gp_records:
        try:
            norad_id = int(rec["NORAD_CAT_ID"])
            mean_motion = float(rec["MEAN_MOTION"])
            eccentricity = float(rec["ECCENTRICITY"])
        except (KeyError, ValueError, TypeError):
            continue  # malformed record from an external feed; skip, don't fail the run

        a_km, peri_alt, apo_alt, period_min = _derive_orbit(mean_motion, eccentricity)
        if apo_alt > leo_apogee_limit_km:
            continue

        satcat = satcat_by_id.get(norad_id)
        owner = (satcat.get("OWNER") or None) if satcat else None
        object_type = object_type_from_satcat(satcat["OBJECT_TYPE"]) if satcat else "UNKNOWN"
        rcs_size = rcs_size_from_m2(satcat.get("RCS")) if satcat else "UNKNOWN"
        launch_date = (satcat.get("LAUNCH_DATE") or None) if satcat else None

        epoch_dt = _parse_gp_epoch(rec["EPOCH"])

        objects.append(CatalogObject(
            norad_id=norad_id,
            name=rec.get("OBJECT_NAME") or "UNKNOWN",
            owner_country=owner,
            object_type=object_type,
            rcs_size=rcs_size,
            launch_date=launch_date,
            gp=rec,
            epoch_utc=iso_utc(epoch_dt),
            semi_major_axis_km=a_km,
            eccentricity=eccentricity,
            inclination_deg=float(rec["INCLINATION"]),
            ra_of_asc_node_deg=float(rec["RA_OF_ASC_NODE"]),
            arg_of_pericenter_deg=float(rec["ARG_OF_PERICENTER"]),
            mean_anomaly_deg=float(rec["MEAN_ANOMALY"]),
            mean_motion_rev_per_day=mean_motion,
            bstar=float(rec["BSTAR"]),
            period_minutes=period_min,
            perigee_altitude_km=peri_alt,
            apogee_altitude_km=apo_alt,
        ))
    return objects


def _parse_gp_epoch(epoch_str):
    from datetime import datetime
    dt = datetime.fromisoformat(epoch_str)
    return dt.replace(tzinfo=timezone.utc)
