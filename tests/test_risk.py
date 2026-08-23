"""Minimal regression check for the screening/risk-scoring core.

Run: python tests/test_risk.py
No framework, no fixtures: asserts only, so a break here means the numbers
the frontend and the India screen depend on have actually changed.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import numpy as np

from orbitvision import risk, screening


def test_chan_pc_extremes():
    # Dead-on hit with a hard body much larger than the uncertainty: pc -> 1.
    assert risk.chan_pc(miss_km=0.0, sigma_km=0.001, hbr_km=1.0) > 0.999
    # Far outside a tight uncertainty: pc -> 0.
    assert risk.chan_pc(miss_km=100.0, sigma_km=0.001, hbr_km=0.001) < 1e-9


def test_max_pc_is_never_below_nominal():
    # output-contract.md: max_collision_probability >= collision_probability, always.
    for miss_km, sigma_km, hbr_km in [(0.5, 2.0, 0.002), (2.0, 5.0, 0.001), (0.05, 0.5, 0.003)]:
        nominal = risk.chan_pc(miss_km, sigma_km, hbr_km)
        maxed = risk.max_chan_pc(miss_km, sigma_km, hbr_km)
        assert maxed >= nominal - 1e-12


def test_risk_band_thresholds_match_contract():
    assert risk.risk_band(max_pc=1e-3, miss_distance_km=10.0) == "CRITICAL"
    assert risk.risk_band(max_pc=0.0, miss_distance_km=0.4) == "CRITICAL"
    assert risk.risk_band(max_pc=5e-5, miss_distance_km=10.0) == "HIGH"
    assert risk.risk_band(max_pc=5e-6, miss_distance_km=10.0) == "MODERATE"
    assert risk.risk_band(max_pc=0.0, miss_distance_km=10.0) == "LOW"


def test_perigee_apogee_filter_rejects_disjoint_orbits():
    # Two orbits whose radius ranges are far apart can never conjunct.
    can = screening.perigee_apogee_can_conjunct(
        peri_i=np.array([400.0]), apo_i=np.array([420.0]),
        peri_j=np.array([2000.0]), apo_j=np.array([2050.0]),
        pad_km=100.0,
    )
    assert not can[0]
    # Overlapping ranges must survive.
    can = screening.perigee_apogee_can_conjunct(
        peri_i=np.array([400.0]), apo_i=np.array([420.0]),
        peri_j=np.array([410.0]), apo_j=np.array([450.0]),
        pad_km=100.0,
    )
    assert can[0]


def test_cluster_encounters_merges_same_pair_keeps_closest():
    # Three coarse samples of the same pair within the encounter gap collapse
    # to one record, keeping the closest distance.
    pair_i = np.array([1, 1, 1])
    pair_j = np.array([2, 2, 2])
    t_seconds = np.array([0.0, 60.0, 120.0])
    d_km = np.array([50.0, 10.0, 45.0])
    encounters = screening.cluster_encounters(pair_i, pair_j, t_seconds, d_km)
    assert len(encounters) == 1
    i, j, t, d = encounters[0]
    assert (i, j) == (1, 2)
    assert d == 10.0
    assert t == 60.0


if __name__ == "__main__":
    tests = [v for k, v in list(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"ok  {t.__name__}")
    print(f"{len(tests)} passed")
