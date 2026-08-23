import { json2satrec, propagate, eciToEcf, gstime } from 'satellite.js';

// Contract's `orbit` block is mean Keplerian elements, one-to-one with OMM fields.
// json2satrec builds a satrec directly from those, no TLE string round-trip needed.
function ommFromOrbit(orbit, noradId) {
  return {
    OBJECT_NAME: String(noradId),
    OBJECT_ID: String(noradId),
    EPOCH: orbit.epoch_utc,
    MEAN_MOTION: orbit.mean_motion_rev_per_day,
    ECCENTRICITY: orbit.eccentricity,
    INCLINATION: orbit.inclination_deg,
    RA_OF_ASC_NODE: orbit.ra_of_asc_node_deg,
    ARG_OF_PERICENTER: orbit.arg_of_pericenter_deg,
    MEAN_ANOMALY: orbit.mean_anomaly_deg,
    EPHEMERIS_TYPE: 0,
    CLASSIFICATION_TYPE: 'U',
    NORAD_CAT_ID: noradId,
    ELEMENT_SET_NO: 999,
    REV_AT_EPOCH: 0,
    BSTAR: orbit.bstar,
    MEAN_MOTION_DOT: 0,
    MEAN_MOTION_DDOT: 0,
  };
}

export function buildSatrec(orbit, noradId) {
  return json2satrec(ommFromOrbit(orbit, noradId));
}

// Returns ECEF km position at `date`, or null if SGP4 fails (decayed / bad elements).
export function positionEcefKm(satrec, date) {
  const result = propagate(satrec, date);
  if (!result || !result.position) return null;
  const gmst = gstime(date);
  const ecef = eciToEcf(result.position, gmst);
  return [ecef.x, ecef.y, ecef.z];
}
