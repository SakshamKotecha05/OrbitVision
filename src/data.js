export async function loadData(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return res.json();
}

// Every primary/secondary object block, deduped by norad_id. Records in
// india.conjunctions are byte-identical to their top-level counterparts
// (per the contract), so the top-level list alone covers every object.
export function uniqueObjects(data) {
  const byId = new Map();
  for (const c of data.conjunctions) {
    byId.set(c.primary.norad_id, c.primary);
    byId.set(c.secondary.norad_id, c.secondary);
  }
  return byId;
}

export const RISK_ORDER = ['CRITICAL', 'HIGH', 'MODERATE', 'LOW'];

export function fmtUtc(iso) {
  const d = new Date(iso);
  return (
    d.toLocaleString('en-GB', {
      timeZone: 'UTC',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }) + ' UTC'
  );
}

export function fmtDuration(seconds) {
  const abs = Math.abs(seconds);
  const sign = seconds < 0 ? '-' : '+';
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  if (h >= 24) {
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return `${sign}${d}d ${rh}h`;
  }
  if (h > 0) return `${sign}${h}h ${m}m`;
  return `${sign}${m}m`;
}

export function plainLanguageLine(c, refDate) {
  const t = (new Date(c.tca_utc).getTime() - refDate.getTime()) / 1000;
  const inFuture = t > 0;
  const dur = fmtDuration(t).replace(/^[+-]/, '');
  const when = inFuture ? `in ${dur}` : `${dur} ago`;
  return `${c.primary.name} and ${c.secondary.name} pass within ${c.miss_distance_km.toFixed(2)} km of each other ${when}.`;
}
