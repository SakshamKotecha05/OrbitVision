"""Collision probability: Chan's (1997) method, on Foster's (1992) formulation.

TLE and GP element sets carry no covariance -- there is no uncertainty
field to read. Position uncertainty here is SYNTHESISED from element-set
age using published SGP4 error growth (roughly 1 km at epoch, degrading a
further 1-3 km/day). This is a legitimate, standard workaround, but it is a
modelled assumption, not a measured one; docs/methodology.md says so and
uncertainty_model in the output says so again.

Because we have no directional covariance information (only a single
synthesised sigma per object), the combined covariance is isotropic by
construction, and Chan's circularisation step -- normally an
approximation -- costs us nothing extra here. An isotropic 3D Gaussian
projected onto the 2D encounter plane stays isotropic with the same sigma,
and the relative-position vector at the true closest approach is already
(to good approximation) perpendicular to relative velocity, i.e. already
in that plane. So the 3D miss distance and sigma found by screening can be
used directly, with no separate encounter-plane projection step.

With an isotropic combined covariance, Pc reduces to a known closed form:
let sigma be the combined 1-sigma position uncertainty, m the miss
distance, and R the combined hard-body radius. Then

    Pc = P( noncentral-chi2(df=2, lambda=(m/sigma)^2) <= (R/sigma)^2 )

A noncentral chi-square with 2 degrees of freedom is a Poisson(lambda/2)
mixture of central chi-squares with 2, 4, 6, ... degrees of freedom, each
of which has the closed form 1 - exp(-x/2) * sum_{i=0}^{k} (x/2)^i / i!.
This gives the truncated series below -- this is Chan's method.
"""

import math

SIGMA_AT_EPOCH_KM = 1.0
SIGMA_GROWTH_KM_PER_DAY = 2.0
SIGMA_GROWTH_RANGE_KM_PER_DAY = (1.0, 3.0)

# Hard-body radius by SATCAT RCS_SIZE class. RCS is radar cross-section, a
# proxy for physical size, not physical size itself.
HARD_BODY_RADIUS_M = {
    "SMALL": 0.25,
    "MEDIUM": 1.0,
    "LARGE": 3.0,
    "UNKNOWN": 1.0,
}

RISK_BAND_ORDER = ["CRITICAL", "HIGH", "MODERATE", "LOW"]
RISK_BAND_RULES = {
    "CRITICAL": "max_collision_probability >= 1e-4 or miss_distance_km < 0.5",
    "HIGH": "max_collision_probability >= 1e-5 or miss_distance_km < 1.0",
    "MODERATE": "max_collision_probability >= 1e-6 or miss_distance_km < 5.0",
    "LOW": "everything else inside the reporting threshold",
}


def synthesized_sigma_km(data_age_hours):
    age_days = max(data_age_hours, 0.0) / 24.0
    return SIGMA_AT_EPOCH_KM + SIGMA_GROWTH_KM_PER_DAY * age_days


def combined_hard_body_radius_m(rcs_a, rcs_b):
    return HARD_BODY_RADIUS_M[rcs_a] + HARD_BODY_RADIUS_M[rcs_b]


def _term_count(v):
    """Terms needed for the Poisson(v) tail to be negligible."""
    return min(500, max(30, int(v + 8 * math.sqrt(v + 1)) + 20))


def chan_pc(miss_km, sigma_km, hbr_km):
    """Chan (1997) Pc for an isotropic combined covariance.

    Validated against scipy.stats.ncx2 (the exact noncentral chi-square
    this series is derived from): relative error ~1e-10 across realistic
    conjunction inputs. In the extreme regime where hbr_km << sigma_km and
    miss_km is many sigma away, (1 - inner_sum) loses precision to
    cancellation once inner_sum rounds to 1.0, flooring the result around
    1e-16 rather than the true (far smaller) value. This never flips a
    risk band: all four band thresholds sit at 1e-4..1e-6, well above the
    float64 floor, and only max_chan_pc drives banding regardless.
    """
    if sigma_km <= 0:
        return 1.0 if miss_km <= hbr_km else 0.0

    v = (miss_km / sigma_km) ** 2 / 2.0  # lambda / 2
    u = (hbr_km / sigma_km) ** 2 / 2.0   # x / 2
    terms = _term_count(v)

    pc = 0.0
    poisson_pmf = math.exp(-v)   # Poisson(k=0; v)
    inner_term = math.exp(-u)    # i=0 term of the inner incomplete-gamma sum
    inner_sum = inner_term

    for k in range(terms):
        pc += poisson_pmf * (1.0 - inner_sum)
        poisson_pmf *= v / (k + 1)
        inner_term *= u / (k + 1)
        inner_sum += inner_term

    return max(0.0, min(1.0, pc))


def max_chan_pc(miss_km, sigma_nominal_km, hbr_km):
    """Nominal Pc maximised over an isotropic scaling of the combined
    covariance (the NASA CARA maximum-Pc treatment).

    Pc is not monotonic in uncertainty: past a point, more covariance
    smears probability mass outside the hard-body radius and Pc falls
    again. A stale, uncertain element set can therefore score a lower
    nominal Pc than a fresh one at the same miss distance -- the opposite
    of what "worse data" should imply. We search over the scale factor
    with golden-section search, since Pc(sigma) is unimodal in sigma for
    fixed miss distance and hard-body radius (it is 0 in both limits
    sigma -> 0 and sigma -> infinity for miss_km > hbr_km, and rises
    between them), rather than trust that the nominal covariance is the
    worst case.
    """
    def f(log_scale):
        return chan_pc(miss_km, sigma_nominal_km * math.exp(log_scale), hbr_km)

    lo, hi = math.log(1e-3), math.log(1e3)
    gr = (math.sqrt(5) - 1) / 2
    c = hi - gr * (hi - lo)
    d = lo + gr * (hi - lo)
    fc, fd = f(c), f(d)
    for _ in range(60):
        if fc > fd:
            hi, d, fd = d, c, fc
            c = hi - gr * (hi - lo)
            fc = f(c)
        else:
            lo, c, fc = c, d, fd
            d = lo + gr * (hi - lo)
            fd = f(d)

    nominal = chan_pc(miss_km, sigma_nominal_km, hbr_km)
    return max(f(lo), f(hi), fc, fd, nominal)


def risk_band(max_pc, miss_distance_km):
    """Band from maximum Pc and miss distance together, never nominal Pc
    alone -- probability dilution can make stale data look deceptively
    safe under nominal Pc.
    """
    if max_pc >= 1e-4 or miss_distance_km < 0.5:
        return "CRITICAL"
    if max_pc >= 1e-5 or miss_distance_km < 1.0:
        return "HIGH"
    if max_pc >= 1e-6 or miss_distance_km < 5.0:
        return "MODERATE"
    return "LOW"


def uncertainty_model_block():
    return {
        "is_measured_covariance": False,
        "kind": "synthesised_from_element_set_age",
        "summary": (
            "GP/TLE element sets carry no covariance. Position uncertainty "
            "here is MODELLED from element-set age using published SGP4 "
            "error growth, not measured."
        ),
        "sigma_at_epoch_km": SIGMA_AT_EPOCH_KM,
        "sigma_growth_km_per_day": SIGMA_GROWTH_KM_PER_DAY,
        "sigma_growth_range_km_per_day": list(SIGMA_GROWTH_RANGE_KM_PER_DAY),
        "pc_method": "Chan (1997) analytic series, on the Foster (1992) formulation",
        "max_pc_method": (
            "Nominal Pc maximised over an isotropic scaling of the combined "
            "covariance (NASA CARA maximum-Pc treatment), reported because "
            "Pc is not monotonic in uncertainty."
        ),
        "hard_body_radius_m_by_rcs_size": dict(HARD_BODY_RADIUS_M),
        "hard_body_radius_note": (
            "RCS_SIZE is a radar cross-section class, a proxy for physical "
            "size and not physical size itself."
        ),
    }


def risk_bands_block():
    return {
        "order": list(RISK_BAND_ORDER),
        "basis": (
            "Banding uses maximum Pc and miss distance together, never "
            "nominal Pc alone, because probability dilution makes stale "
            "data score a deceptively low nominal Pc."
        ),
        "rules": dict(RISK_BAND_RULES),
    }
