"""TEME to ECEF conversion.

SGP4 produces state vectors in TEME (true equator, mean equinox), which is inertial.
Distances between two objects are frame-invariant, so screening does not care.
Anything drawn relative to the ground does care: rendering TEME on an Earth-fixed
globe puts every orbit in the wrong place, and the error grows through the day.

The TEME to PEF rotation is a single rotation about Z by Greenwich Mean Sidereal
Time.  PEF to ITRF (true ECEF) additionally applies polar motion, which is under
20 m at the Earth's surface and is neglected here; at the kilometre scale this
pipeline reports, it does not matter.  Documented in docs/methodology.md.
"""

import numpy as np


def gmst_rad(jd_ut1):
    """Greenwich Mean Sidereal Time in radians (IAU 1982), for scalar or array jd."""
    t = (np.asarray(jd_ut1, dtype=float) - 2451545.0) / 36525.0
    # Seconds of sidereal time, Vallado eq. 3-47.
    sec = (67310.54841
           + (876600.0 * 3600.0 + 8640184.812866) * t
           + 0.093104 * t * t
           - 6.2e-6 * t * t * t)
    return np.deg2rad((sec / 240.0) % 360.0)


def teme_to_ecef(r_teme_km, jd_ut1):
    """Rotate TEME position vectors to ECEF.

    r_teme_km: (..., 3) array.  jd_ut1: scalar or array broadcastable to (...,).
    """
    r = np.asarray(r_teme_km, dtype=float)
    th = gmst_rad(jd_ut1)
    c, s = np.cos(th), np.sin(th)
    x, y, z = r[..., 0], r[..., 1], r[..., 2]
    return np.stack(np.broadcast_arrays(x * c + y * s, -x * s + y * c, z), axis=-1)
