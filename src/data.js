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

// SIH is a domestic programme, so every absolute time on screen reads IST
// (UTC+05:30, no DST) rather than the engine's UTC payload.
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export function fmtIst(iso) {
  const d = new Date(new Date(iso).getTime() + IST_OFFSET_MS);
  return (
    d.toLocaleString('en-GB', {
      timeZone: 'UTC',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }) + ' IST'
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

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// Mission-timeline strip formatting: day label ("23 AUG"), bare clock time
// ("17:41:16"), and a compact date+time for the window readout ("23 AUG 00:00").
export function fmtDayLabel(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]}`;
}

export function fmtClockTime(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  return [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

export function fmtCompactIst(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  const hm = [d.getUTCHours(), d.getUTCMinutes()].map((n) => String(n).padStart(2, '0')).join(':');
  return `${fmtDayLabel(ms)} ${hm}`;
}
