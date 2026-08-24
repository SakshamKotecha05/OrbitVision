# OrbitVision output contract

Version `1.0.0`.
This document pins the shape of the single JSON file the pipeline produces.
`data/sample-output.json` is a hand-authored file that matches this contract exactly, and it exists so the frontend can be built before the engine finishes.

The sample file contains fabricated conjunction records.
The real pipeline writes the same shape to `data/output.json` (or wherever `--out` points).

**This shape is frozen.**
If the engine needs to change it, that change is flagged before it lands, because a second worker builds against it.

## Top level

```jsonc
{
  "schema_version": "1.0.0",
  "generated_at_utc": "2026-08-23T06:00:00.000Z",
  "generator": "orbitvision-pipeline 0.1.0",
  "source":            { ... },   // where the orbit data came from
  "screening":         { ... },   // window, filter cascade parameters, survivor counts
  "uncertainty_model": { ... },   // how covariance and hard-body radius were modelled
  "risk_bands":        { ... },   // what the bands mean
  "conjunctions":      [ ... ],   // all conjunctions, ranked by risk, worst first
  "india":             { ... }    // the India screen, a first-class section
}
```

All timestamps are UTC ISO 8601 with a trailing `Z` and millisecond precision.
All distances are kilometres, all velocities kilometres per second, unless a key name says otherwise.
`null` is used for genuinely unknown catalogue fields.
It is never used for a computed quantity.

## `source`

| Key | Type | Meaning |
|---|---|---|
| `provider` | string | Always `"CelesTrak"`. |
| `gp_endpoint` | string | The GP query actually used. |
| `satcat_endpoint` | string | The SATCAT URL actually used. |
| `gp_retrieved_utc` | string | When the GP file in use was downloaded. |
| `satcat_retrieved_utc` | string | When the SATCAT file in use was downloaded. |
| `mode` | string | `"live"` or `"offline"`. `"offline"` means the run used the committed snapshot and made zero network calls. |
| `note` | string or null | Free text. The sample file uses it to say the records are fabricated. |

## `screening`

| Key | Type | Meaning |
|---|---|---|
| `window_start_utc`, `window_end_utc` | string | The propagation window. |
| `window_hours` | number | 72 in normal operation. |
| `regime` | string | Always `"LEO"`. GEO is out of scope, see `docs/methodology.md`. |
| `leo_apogee_limit_km` | number | Objects with a higher apogee are excluded. |
| `frame` | string | `"TEME"`. Screening distances are computed in TEME. |
| `frame_note` | string | Says explicitly that distances are frame-invariant and that every Earth-relative coordinate emitted is ECEF. |
| `perigee_apogee_pad_km` | number | The pad used by the pass 1 perigee/apogee filter. |
| `coarse_step_seconds` | number | Pass 2 sample interval, 60. |
| `coarse_gate_km` | number | Pass 2 gate, about 500. |
| `coarse_gate_rationale` | string | Why the gate is that loose. Shipped in the output on purpose so nobody tightens it. |
| `refine_step_seconds` | number | Pass 3 sample interval, 1. |
| `reporting_threshold_km` | number | Conjunctions closer than this are reported. |
| `objects_screened` | integer | Objects that survived to propagation. |
| `pairs_total` | integer | n(n-1)/2. |
| `pairs_after_perigee_apogee_filter` | integer | Survivors of pass 1. |
| `pairs_after_coarse_sweep` | integer | Survivors of pass 2. |
| `conjunctions_reported` | integer | Length of `conjunctions`. |
| `runtime_seconds` | number | Wall clock for the run. |
| `conjunctions_found` | integer | True refined conjunctions inside `reporting_threshold_km`, before the pair collapse below and before `general_list_cap`. |
| `distinct_pairs_found` | integer | Distinct object pairs remaining after the pair collapse, before `general_list_cap`. |
| `pair_collapse_note` | string | Explains the pair collapse: each object pair is reduced to its single worst encounter in the window, so a formation-flying or co-orbiting pair does not repeat every revolution and crowd out distinct risks. "Worst" is the same ordering used to rank the final list: worst risk band, then highest `max_collision_probability`, then lowest `miss_distance_km`. |
| `general_list_cap` | integer | The general list keeps only this many of the worst distinct pairs; every India-related conjunction is kept regardless of rank. |
| `excluded_pairs` | object | Documents the two pair-exclusion rules (same mega-constellation, same docked assembly) so nothing is dropped silently: `rules`, `constellations`, `objects_in_excluded_constellations`, `objects_in_docked_assemblies`, `note`. |
| `formation_flying_screen` | object | Encounters with a relative velocity at TCA below `min_relative_velocity_km_s` are excluded before scoring, since Chan's method needs relative motion to define the encounter plane: `min_relative_velocity_km_s`, `encounters_excluded`, `rationale`. |

`conjunctions_found`, `distinct_pairs_found`, `pair_collapse_note`, `general_list_cap`, `excluded_pairs` and `formation_flying_screen` are additive: they were not present in the original pinned shape and `data/sample-output.json` predates them (its 4 records need no capping, collapse or formation-flying screening), but the frontend does not depend on their absence, and no existing key changed meaning.

These counters exist so the filter cascade can be shown working, which is most of the technical story.

## `uncertainty_model`

This section is the honesty section.
It is emitted in every output file and it must not be dropped from the UI.

| Key | Type | Meaning |
|---|---|---|
| `is_measured_covariance` | boolean | Always `false`. |
| `kind` | string | `"synthesised_from_element_set_age"`. |
| `summary` | string | Plain-language statement that the uncertainty is modelled, not measured. Suitable for direct display. |
| `sigma_at_epoch_km` | number | 1 km position sigma at element-set epoch. |
| `sigma_growth_km_per_day` | number | Growth rate used, 2 km/day. |
| `sigma_growth_range_km_per_day` | array | `[1.0, 3.0]`, the published spread the point value sits in. |
| `pc_method` | string | Chan (1997), on the Foster (1992) formulation. |
| `max_pc_method` | string | How maximum Pc is obtained. |
| `hard_body_radius_m_by_rcs_size` | object | Radius per SATCAT `RCS_SIZE` class. |
| `hard_body_radius_note` | string | Says RCS is a proxy for physical size, not physical size. |

## `risk_bands`

`order` lists the bands worst first: `CRITICAL`, `HIGH`, `MODERATE`, `LOW`.
`basis` states that banding uses maximum Pc alone: never nominal Pc, and never miss distance.
`rules` gives the literal thresholds, as strings, so the UI can show them.

## A conjunction record

Every entry of `conjunctions`, and every entry of `india.conjunctions`, has this exact shape.
Records are self-contained, so the frontend can render one without joining against anything else.
A record that appears in both lists is byte-identical in both.

| Key | Type | Meaning |
|---|---|---|
| `id` | string | `"{primary_norad}-{secondary_norad}-{tca compact UTC}"`. Stable within a run and usable as a React key. |
| `tca_utc` | string | Time of closest approach. |
| `miss_distance_km` | number | Distance at TCA. |
| `relative_velocity_km_s` | number | Relative speed at TCA. |
| `collision_probability` | number | Nominal Pc, Chan (1997). |
| `max_collision_probability` | number | Maximum Pc over covariance scaling. Always >= nominal Pc. |
| `combined_hard_body_radius_m` | number | Sum of the two objects' modelled radii. |
| `combined_position_sigma_km` | number | Modelled combined 1-sigma position uncertainty in the encounter plane. |
| `data_age_hours` | number | Age of the older of the two element sets, in hours, at TCA. |
| `risk_band` | string | One of the four bands. |
| `india_related` | boolean | True if either object is Indian-owned. |
| `primary` | object | Object block, see below. The Indian object when one is involved, otherwise the lower NORAD id. |
| `secondary` | object | Object block. |

`conjunctions` is sorted worst first: by band, then by descending maximum Pc, then by ascending miss distance.

## An object block

```jsonc
{
  "norad_id": 43111,
  "name": "CARTOSAT-2F",
  "owner_country": "IND",          // SATCAT OWNER code, or null
  "object_type": "PAYLOAD",        // PAYLOAD | ROCKET BODY | DEBRIS | UNKNOWN
  "rcs_size": "MEDIUM",            // SMALL | MEDIUM | LARGE | UNKNOWN
  "launch_date": "2018-01-12",     // or null
  "epoch_utc": "2026-08-22T18:41:03.000Z",
  "data_age_hours": 11.3,          // element-set age at TCA
  "orbit": { ... },
  "state_at_tca": { ... },
  "track": { ... }
}
```

### `orbit`

Mean Keplerian elements straight from the GP record, plus three derived convenience values.
A frontend with its own SGP4 implementation can propagate from these.

`epoch_utc`, `semi_major_axis_km`, `eccentricity`, `inclination_deg`, `ra_of_asc_node_deg`, `arg_of_pericenter_deg`, `mean_anomaly_deg`, `mean_motion_rev_per_day`, `bstar`, `period_minutes`, `perigee_altitude_km`, `apogee_altitude_km`.

Angles are degrees.
Altitudes are above a spherical Earth of radius 6378.137 km.

### `state_at_tca`

```jsonc
{ "frame": "TEME", "position_km": [x, y, z], "velocity_km_s": [vx, vy, vz] }
```

Inertial, at the moment of closest approach.

### `track`

A pre-sampled path, so the frontend can draw an orbit without running a propagator.

| Key | Type | Meaning |
|---|---|---|
| `frame_note` | string | Reminder that one array is inertial and the other Earth-fixed. |
| `start_utc` | string | Timestamp of `positions_*[0]`. |
| `step_seconds` | number | Spacing between consecutive points. |
| `point_count` | integer | Length of each positions array. |
| `positions_teme_km` | array of `[x,y,z]` | Inertial. Use this to draw the orbit ellipse in an inertial scene. |
| `positions_ecef_km` | array of `[x,y,z]` | Earth-fixed. Use this to place the object relative to the ground. |

The two arrays are the same points in two frames, index for index.
In real output the track covers one full orbital period centred on TCA.
The sample file carries 8 points per track to keep it readable.

Drawing `positions_teme_km` on an Earth-fixed globe puts every orbit in the wrong place, and the error grows through the day as the Earth turns.
That is why both arrays are shipped rather than one.

## `india`

| Key | Type | Meaning |
|---|---|---|
| `screen_kind` | string | `"exhaustive"`. |
| `screen_note` | string | States that the India screen is exhaustive and continuous, not sampled, and that GEO is out of scope. |
| `owner_country_codes` | array | `["IND"]`. |
| `objects_screened` | integer | Number of Indian LEO objects screened. |
| `objects` | array | One summary row per Indian object, see below. Includes objects with zero conjunctions. |
| `india.conjunctions` | array | Conjunction records involving an Indian object, same shape and same sort order as the top-level list. |

An `india.objects` row:

```jsonc
{
  "norad_id": 43111,
  "name": "CARTOSAT-2F",
  "object_type": "PAYLOAD",
  "rcs_size": "MEDIUM",
  "launch_date": "2018-01-12",
  "data_age_hours": 11.3,
  "conjunction_count": 1,
  "worst_risk_band": "CRITICAL"     // null when conjunction_count is 0
}
```

## Notes for the frontend

- Rank order is array order. Do not re-sort on `collision_probability` alone; see `risk_bands.basis`.
- Show `data_age_hours` wherever a probability is shown. A low Pc from stale data is not reassurance.
- `uncertainty_model.summary` is written to be displayed verbatim somewhere visible.
- Object counts can be large. `positions_ecef_km` is the array to feed a globe.
- Empty is legal. `conjunctions`, `india.objects` and `india.conjunctions` can all be `[]` on a quiet window.
