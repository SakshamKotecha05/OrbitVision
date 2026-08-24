"""Batch SGP4 propagation via sgp4.api.SatrecArray.

A Python loop over Satrec.sgp4() calls, one object at a time, does not
finish pass 2's coarse sweep (thousands of objects times thousands of
timesteps) in reasonable time. SatrecArray batches the propagation in the
C extension: pass jd/fr time arrays once, get back position and velocity
for every object at every time in one call.

Output is in the TEME frame (true equator, mean equinox), which is
inertial. Distance between two objects computed here is frame-invariant,
so screening does not need a frame conversion. See frames.py for the
TEME -> ECEF conversion used wherever a ground-relative coordinate is
emitted.
"""

import numpy as np
from sgp4 import omm
from sgp4.api import Satrec, SatrecArray
from sgp4.functions import jday


def build_satrec(catalog_object):
    sat = Satrec()
    omm.initialize(sat, catalog_object.gp)
    return sat


def jd_fr_at(dt):
    """Julian date (jd, fr) for a single UTC datetime."""
    return jday(dt.year, dt.month, dt.day, dt.hour, dt.minute,
                dt.second + dt.microsecond * 1e-6)


def time_grid(start_dt, span_seconds, step_seconds):
    """jd, fr, seconds_from_start for a uniform grid starting at start_dt."""
    n = int(span_seconds / step_seconds) + 1
    seconds = np.arange(n, dtype=float) * step_seconds
    jd0, fr0 = jd_fr_at(start_dt)
    fr = fr0 + seconds / 86400.0
    jd = np.full(n, jd0)
    return jd, fr, seconds


def propagate(satrecs, jd, fr):
    """Propagate a list of Satrec across a jd/fr time grid.

    Returns (error, r_km, v_km_s): error and r/v have shape (n_sats,
    n_times) and (n_sats, n_times, 3) respectively. error is nonzero
    wherever SGP4 failed at that object/time (e.g. decayed orbit).
    """
    arr = SatrecArray(satrecs)
    e, r, v = arr.sgp4(np.asarray(jd, dtype=float), np.asarray(fr, dtype=float))
    return e, r, v
