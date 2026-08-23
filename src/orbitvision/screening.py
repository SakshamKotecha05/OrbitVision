"""Three-pass conjunction screening cascade: cheap filters first, expensive last.

Screening every pair at every timestep is not possible: 15,000 LEO objects is
120 million pairs, and a 72-hour window at a 60-second step is 4,320 samples.
We use a filter cascade, each pass looser and cheaper than the one after it.

  1. Perigee/apogee filter (Hoots, Crawford & Roehrich 1984): if two orbits'
     radius ranges cannot overlap, the objects can never meet. Purely
     analytic, no propagation.
  2. Coarse temporal sweep at 60 s with a deliberately loose 500 km distance
     gate, narrowed in the same step by a linear closest-approach estimate so
     that only pairs that plausibly come close are carried forward.
  3. Refinement: resample each surviving encounter at 1 s, then solve the
     closest-approach vertex exactly, for true TCA and miss distance.
"""

import numpy as np

from .propagate import jd_fr_at, propagate

# --- Pass 1: perigee/apogee filter (Hoots, Crawford & Roehrich 1984) -------


def perigee_apogee_can_conjunct(peri_i, apo_i, peri_j, apo_j, pad_km):
    """True where two orbits' radius ranges overlap within pad_km.

    A pair can never meet if the lower of the two apoapses sits more than
    pad_km below the higher of the two periapses. Works elementwise on
    arrays. The pad absorbs orbital perturbation across the screening
    window and the fact that these are osculating altitudes at epoch.
    """
    min_apo = np.minimum(apo_i, apo_j)
    max_peri = np.maximum(peri_i, peri_j)
    return (min_apo - max_peri) >= -pad_km


def perigee_apogee_survivor_count(perigee_km, apogee_km, pad_km):
    """How many unordered pairs survive pass 1, without materialising them.

    Counting is O(n log n): a pair (i, j) is REJECTED exactly when one
    object's apogee + pad is below the other's perigee, and the two
    directions are mutually exclusive, so the rejects are counted by
    binary-searching each padded apogee into the sorted perigees.
    Materialising the surviving pairs themselves would cost gigabytes on a
    catalogue this size, and nothing downstream needs the list: pass 2
    applies the same predicate to the far smaller set of pairs that are
    actually spatially close.
    """
    peri = np.sort(np.asarray(perigee_km, dtype=float))
    apo = np.asarray(apogee_km, dtype=float)
    n = len(peri)
    # Pair (i, j) is rejected iff apo_i + pad < peri_j or apo_j + pad < peri_i.
    # A perigee is never above its own apogee, so the two directions cannot
    # both hold and no object rejects itself: summing the count of perigees
    # strictly above each padded apogee counts every rejected unordered pair
    # exactly once.
    rejected = int((n - np.searchsorted(peri, apo + pad_km, side="right")).sum())
    return max(0, n * (n - 1) // 2 - rejected)


# --- Pass 2: coarse temporal sweep ------------------------------------------

# In LEO two objects on crossing orbits close at up to ~15 km/s. At a 60 s
# sample step that is up to ~900 km of relative motion between consecutive
# samples, so a pair can approach, pass within a few hundred metres and
# separate again entirely between two samples that BOTH show them hundreds
# of km apart. A 50 km gate -- the intuitive "close enough" number -- would
# never fire and the conjunction would be silently missed. This is a
# documented failure mode of real screening tools, not a theoretical one.
# The rule is gate >= max_relative_velocity * step / 2. Do not tighten this
# gate without re-deriving that bound: the gate is only a filter and is
# meant to be loose, and all the precision lives in pass 3.
MAX_RELATIVE_VELOCITY_KM_S = 15.0
COARSE_STEP_SECONDS = 60.0
COARSE_GATE_KM = 500.0
COARSE_GATE_RATIONALE = (
    "gate >= max_relative_velocity * step / 2, with max_relative_velocity "
    "taken as 15 km/s in LEO. A 50 km gate at a 60 s step aliases past real "
    "conjunctions entirely."
)

# Two objects in LEO each see at most ~9.8e-3 km/s^2 of gravitational
# acceleration, so their relative acceleration is at most ~2e-2 km/s^2. The
# coarse sample nearest a true closest approach is at most step/2 = 30 s away
# from it, so a straight-line extrapolation from that sample misses the true
# closest-approach distance by at most 0.5 * 2e-2 * 30^2 ~= 9 km.
MAX_RELATIVE_ACCEL_KM_S2 = 2.0e-2
CURVATURE_BOUND_KM = 0.5 * MAX_RELATIVE_ACCEL_KM_S2 * (COARSE_STEP_SECONDS / 2.0) ** 2

# Samples of the same pair on either side of one approach must collapse into
# a single encounter, but the same pair can genuinely conjunct several times
# in a 72-hour window. Anything closer together in time than this is treated
# as one encounter; LEO periods are ~90 minutes, so 10 minutes cannot merge
# two distinct passes.
ENCOUNTER_GAP_SECONDS = 600.0


def candidate_guard_km(reporting_threshold_km):
    """Straight-line closest-approach cutoff used to thin pass 2.

    A pair whose linearly-extrapolated closest approach exceeds the
    reporting threshold by more than the curvature bound above cannot have
    a true closest approach inside the threshold, so it can be dropped at
    the sample rather than carried into pass 3. Without this the sweep
    emits hundreds of millions of pair-samples on a real catalogue.
    """
    return reporting_threshold_km + CURVATURE_BOUND_KM


def _linear_closest_approach(dr, dv, step_seconds):
    """Straight-line time-to-closest-approach and distance for pair samples.

    dr, dv are (n, 3) relative position and velocity. Returns (t_star,
    d_min): the offset in seconds from this sample to the straight-line
    closest approach, and the distance there, with t_star clamped into the
    sample interval so a pair whose approach lies outside this sample's
    neighbourhood is measured where it actually is.
    """
    vv = np.einsum("ij,ij->i", dv, dv)
    t_star = -np.einsum("ij,ij->i", dr, dv) / np.maximum(vv, 1e-12)
    t_clamped = np.clip(t_star, -step_seconds, step_seconds)
    d_min = np.linalg.norm(dr + dv * t_clamped[:, None], axis=1)
    return t_star, d_min


def sweep_block_gated(positions, velocities, valid, seconds, guard_km,
                      pair_allowed=None, gate_km=COARSE_GATE_KM,
                      step_seconds=COARSE_STEP_SECONDS):
    """Pass 2 over one block of timesteps, using a KD-tree neighbour query.

    positions/velocities are (n_obj, n_times, 3) TEME km and km/s, valid is
    (n_obj, n_times) bool, seconds is the (n_times,) absolute offset of each
    timestep from the window start. pair_allowed(i_indices, j_indices) is an
    optional mask hook used to drop pairs the caller does not want screened
    against each other.

    Returns (i, j, t_seconds, d_linear_km) arrays, i < j, one row per
    pair-sample whose straight-line closest approach is inside guard_km.
    Filtering inside the per-timestep loop is what keeps this tractable: the
    raw 500 km neighbour lists run to hundreds of millions of rows over a
    full window, while what survives the guard is a few hundred thousand.
    """
    from scipy.spatial import cKDTree

    out_i, out_j, out_t, out_d = [], [], [], []
    for k in range(positions.shape[1]):
        idx = np.nonzero(valid[:, k])[0]
        if len(idx) < 2:
            continue
        pts = positions[idx, k, :]
        pairs = cKDTree(pts).query_pairs(r=gate_km, output_type="ndarray")
        if len(pairs) == 0:
            continue

        a, b = pairs[:, 0], pairs[:, 1]
        gi, gj = idx[a], idx[b]
        if pair_allowed is not None:
            keep = pair_allowed(gi, gj)
            a, b, gi, gj = a[keep], b[keep], gi[keep], gj[keep]
            if len(a) == 0:
                continue

        dr = pts[a] - pts[b]
        dv = velocities[idx[a], k, :] - velocities[idx[b], k, :]
        t_star, d_min = _linear_closest_approach(dr, dv, step_seconds)
        hit = (np.abs(t_star) <= step_seconds) & (d_min < guard_km)
        if not np.any(hit):
            continue

        out_i.append(gi[hit])
        out_j.append(gj[hit])
        out_t.append(np.full(int(hit.sum()), seconds[k], dtype=float))
        out_d.append(d_min[hit])

    return _concat4(out_i, out_j, out_t, out_d)


def sweep_block_exhaustive(positions, velocities, valid, seconds, target_indices,
                           guard_km, step_seconds=COARSE_STEP_SECONDS):
    """Pass 2 for the India screen: every target against every object, no gate.

    Deliberately does NOT use the KD-tree neighbour gate. Each target object
    is differenced against the entire catalogue at every timestep, so no
    pair is ever excluded by a spatial cutoff, a pre-filter, or a subset
    choice. That is affordable only because the target set is small (a few
    dozen objects); it is what makes the India screen exhaustive rather than
    filtered, and it independently cross-checks the gated sweep above.
    """
    target_indices = np.asarray(target_indices, dtype=int)
    out_i, out_j, out_t, out_d = [], [], [], []
    if len(target_indices) == 0:
        return _concat4(out_i, out_j, out_t, out_d)

    for k in range(positions.shape[1]):
        others = np.nonzero(valid[:, k])[0]
        tgt = target_indices[valid[target_indices, k]]
        if len(tgt) == 0 or len(others) < 2:
            continue

        # (n_targets, n_others, 3) differences: a few dozen by ~15,000 is a
        # few million floats, which is fine, and it is the whole catalogue.
        dr = positions[tgt, k, :][:, None, :] - positions[others, k, :][None, :, :]
        dv = velocities[tgt, k, :][:, None, :] - velocities[others, k, :][None, :, :]
        ti = np.repeat(tgt, len(others))
        tj = np.tile(others, len(tgt))
        dr = dr.reshape(-1, 3)
        dv = dv.reshape(-1, 3)

        real = ti != tj
        ti, tj, dr, dv = ti[real], tj[real], dr[real], dv[real]
        t_star, d_min = _linear_closest_approach(dr, dv, step_seconds)
        hit = (np.abs(t_star) <= step_seconds) & (d_min < guard_km)
        if not np.any(hit):
            continue

        lo = np.minimum(ti[hit], tj[hit])
        hi = np.maximum(ti[hit], tj[hit])
        out_i.append(lo)
        out_j.append(hi)
        out_t.append(np.full(len(lo), seconds[k], dtype=float))
        out_d.append(d_min[hit])

    return _concat4(out_i, out_j, out_t, out_d)


def _concat4(a, b, c, d):
    if not a:
        return (np.empty(0, dtype=int), np.empty(0, dtype=int),
                np.empty(0, dtype=float), np.empty(0, dtype=float))
    return (np.concatenate(a).astype(int), np.concatenate(b).astype(int),
            np.concatenate(c).astype(float), np.concatenate(d).astype(float))


def cluster_encounters(pair_i, pair_j, t_seconds, d_km,
                       gap_seconds=ENCOUNTER_GAP_SECONDS):
    """Collapse pair-samples into one record per pair per encounter.

    A single close approach shows up at several consecutive coarse samples,
    and a pair can also conjunct repeatedly across the window. Samples of
    the same pair within gap_seconds of each other are one encounter,
    represented by its closest sample. Returns a list of
    (i, j, t_seconds, d_km), sorted by distance, closest first.
    """
    if len(pair_i) == 0:
        return []

    order = np.lexsort((t_seconds, pair_j, pair_i))
    pi, pj, pt, pd = pair_i[order], pair_j[order], t_seconds[order], d_km[order]

    new_pair = (pi[1:] != pi[:-1]) | (pj[1:] != pj[:-1])
    time_gap = (pt[1:] - pt[:-1]) > gap_seconds
    starts = np.concatenate(([0], np.flatnonzero(new_pair | time_gap) + 1))
    ends = np.concatenate((starts[1:], [len(pi)]))

    out = []
    for s, e in zip(starts.tolist(), ends.tolist()):
        best = s + int(np.argmin(pd[s:e]))
        out.append((int(pi[best]), int(pj[best]), float(pt[best]), float(pd[best])))
    out.sort(key=lambda rec: rec[3])
    return out


# --- Pass 3: refinement ------------------------------------------------------

REFINE_STEP_SECONDS = 1.0
# Half-window either side of the coarse sample. The true closest approach is
# within step/2 of that sample, so a full coarse step of margin brackets it
# with room to spare.
REFINE_WINDOW_SECONDS = COARSE_STEP_SECONDS


def refine_pair(sat_i, sat_j, coarse_time_dt,
                window_seconds=REFINE_WINDOW_SECONDS,
                step_seconds=REFINE_STEP_SECONDS):
    """Resample a pair at 1 s around the coarse minimum, then solve the vertex.

    A 1 s grid alone is not accurate enough to report a miss distance. Near
    the closest approach the separation behaves as
    d(t)^2 = d_min^2 + v_rel^2 (t - t_tca)^2, so at 14 km/s a worst-case
    0.5 s grid offset inflates a true 200 m miss to ~7 km -- an error far
    larger than the quantity being measured, and one that would propagate
    straight into the collision probability. So after the 1 s grid brackets
    the minimum, we solve the closest-approach vertex analytically from the
    state at that sample and re-propagate both objects at that exact instant,
    which leaves only the curvature error over a sub-second offset (metres).

    Returns a dict with the TCA offset in seconds from coarse_time_dt, miss
    distance, relative velocity, and each object's TEME state at TCA, or
    None if SGP4 failed across the whole refine window.
    """
    from datetime import timedelta

    offsets = np.arange(-window_seconds, window_seconds + step_seconds, step_seconds)
    jd0, fr0 = jd_fr_at(coarse_time_dt)
    fr = fr0 + offsets / 86400.0
    jd = np.full_like(fr, jd0)

    err, r, v = propagate([sat_i, sat_j], jd, fr)
    ok = (err[0] == 0) & (err[1] == 0)
    if not np.any(ok):
        return None

    dist = np.where(ok, np.linalg.norm(r[0] - r[1], axis=1), np.inf)
    k = int(np.argmin(dist))

    dr = r[0, k] - r[1, k]
    dv = v[0, k] - v[1, k]
    vv = float(dv @ dv)
    t_vertex = float(-(dr @ dv) / vv) if vv > 0 else 0.0
    t_vertex = max(-step_seconds, min(step_seconds, t_vertex))

    tca_offset = float(offsets[k]) + t_vertex
    jd_v, fr_v = jd_fr_at(coarse_time_dt + timedelta(seconds=tca_offset))
    err_v, r_v, v_v = propagate([sat_i, sat_j], np.array([jd_v]), np.array([fr_v]))
    if err_v[0, 0] != 0 or err_v[1, 0] != 0:
        return None

    pos_i, pos_j = r_v[0, 0], r_v[1, 0]
    vel_i, vel_j = v_v[0, 0], v_v[1, 0]
    return {
        "tca_offset_seconds": tca_offset,
        "miss_distance_km": float(np.linalg.norm(pos_i - pos_j)),
        "relative_velocity_km_s": float(np.linalg.norm(vel_i - vel_j)),
        "pos_i_km": pos_i.tolist(),
        "vel_i_km_s": vel_i.tolist(),
        "pos_j_km": pos_j.tolist(),
        "vel_j_km_s": vel_j.tolist(),
    }
