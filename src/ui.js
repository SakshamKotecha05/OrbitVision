import { fmtIst, fmtDuration, fmtDayLabel, IST_OFFSET_MS } from './data.js';

// Pc as a percentage: three significant figures, capped at five leading
// zeros. Captain's exact call (report section 4, rounds 2-3), verified in
// the browser against all 541 records. Seven decimal places (not six) keeps
// two significant figures in the deep tail instead of one, while still
// satisfying "no more than five leading zeros" literally. chan_pc has no
// lower bound, so the guard stays even though nothing in this dataset
// reaches it - derived from PCT_MAX_DP so the two can't drift apart.
const PCT_MAX_DP = 7;
const PCT_GUARD = 0.5 * Math.pow(10, -PCT_MAX_DP);
function fmtPct(pc) {
  const v = pc * 100;
  if (v < PCT_GUARD) return `< ${Math.pow(10, -PCT_MAX_DP).toFixed(PCT_MAX_DP)}%`;
  const sig = Number(v.toPrecision(3));
  const dp = Math.min(PCT_MAX_DP, Math.max(0, -Math.floor(Math.log10(sig)) + 2));
  return `${sig.toFixed(dp)}%`;
}

// Sub-kilometre misses in metres, so the top of the list stops reading as a
// wall of identical "0.03"s (report section 2).
function fmtMiss(km) {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(2)} km`;
}

// Full duration with minutes retained past a day ("1d 19h 42m"). Separate
// from data.js:fmtDuration, which drops minutes above 24h for other callers.
function fmtDurFull(seconds) {
  const abs = Math.abs(seconds);
  const d = Math.floor(abs / 86400);
  const h = Math.floor((abs % 86400) / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const p = (n) => String(n).padStart(2, '0');
  if (d > 0) return `${d}d ${h}h ${p(m)}m`;
  if (h > 0) return `${h}h ${p(m)}m`;
  return `${m}m`;
}

function urgency(c, currentTime) {
  const h = (new Date(c.tca_utc).getTime() - currentTime.getTime()) / 3600000;
  if (h < 0) return 'past';
  if (h <= 6) return 'imminent';
  if (h <= 24) return 'soon';
  return '';
}

const ROW_ICON = {
  miss: '<svg class="cardR-row-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12.5c3.2 0 6.6-2.4 9-8"/><path d="M8 3.2h3.4v3.4"/></svg>',
  pc: '<svg class="cardR-row-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.4" stroke="currentColor" stroke-width="1.3"/><text x="8" y="10.8" text-anchor="middle" font-family="IBM Plex Sans, sans-serif" font-size="7.2" font-weight="600" fill="currentColor">Pc</text></svg>',
  tca: '<svg class="cardR-row-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 8h11"/><path d="M9.4 4.4 13 8l-3.6 3.6"/></svg>',
};

// Captain's reference layout (report section 4b, amended by round-3
// answers 1 and 4): band pill on its own line above the full-width pair
// name, then MISS / PC / TCA as equal-weight labelled rows. No hero.
export function renderRiskList(listEl, countEl, conjunctions, selectedId, currentTime, riskBands, onSelect) {
  countEl.textContent = conjunctions.length ? `${conjunctions.length} tracked` : '';

  listEl.innerHTML = '';
  if (conjunctions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'panel-empty';
    empty.textContent = 'No conjunctions inside the reporting threshold for this window.';
    listEl.appendChild(empty);
    return;
  }

  for (const c of conjunctions) {
    const li = document.createElement('li');
    li.dataset.id = c.id;
    const selected = c.id === selectedId;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `cardR band-${c.risk_band}${selected ? ' is-selected' : ''}`;
    btn.setAttribute('aria-pressed', String(selected));
    btn.setAttribute('aria-expanded', String(selected));

    const tcaSecs = (new Date(c.tca_utc).getTime() - currentTime.getTime()) / 1000;
    btn.innerHTML = `
      <span class="cardR-pill">${c.risk_band}</span>
      <span class="cardR-names">${c.india_related ? '<i class="cardR-india-dot" aria-hidden="true"></i>' : ''}${c.primary.name} <span class="cardR-x">&times;</span> ${c.secondary.name}</span>
      <div class="cardR-rows">
        <div class="cardR-row">${ROW_ICON.miss}<span class="cardR-row-label">MISS</span><span class="cardR-row-value">${fmtMiss(c.miss_distance_km)}</span></div>
        <div class="cardR-row">${ROW_ICON.pc}<span class="cardR-row-label">PC</span><span class="cardR-row-value">${fmtPct(c.max_collision_probability)}</span></div>
        <div class="cardR-row cardR-row-tca ${urgency(c, currentTime)}">${ROW_ICON.tca}<span class="cardR-row-label">TCA</span><span class="cardR-row-value">${fmtDurFull(tcaSecs)}</span></div>
      </div>
    `;
    btn.addEventListener('click', () => onSelect(c.id));
    li.appendChild(btn);

    if (selected) {
      const detail = document.createElement('div');
      detail.className = 'cardR-detail';
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'cardR-detail-close';
      close.textContent = '↑ Close';
      close.addEventListener('click', () => onSelect(c.id));
      detail.appendChild(close);
      const body = document.createElement('div');
      body.className = 'cardR-detail-body';
      renderDetail(body, c, riskBands);
      detail.appendChild(body);
      li.appendChild(detail);
    }

    listEl.appendChild(li);
  }
}

// IST midnights (as true UTC ms) falling inside (startMs, endMs].
function istMidnightsInRange(startMs, endMs) {
  const startIst = startMs + IST_OFFSET_MS;
  const firstMidnightIst = Math.ceil(startIst / 86400000) * 86400000;
  const midnights = [];
  for (let m = firstMidnightIst; m - IST_OFFSET_MS < endMs; m += 86400000) {
    midnights.push(m - IST_OFFSET_MS);
  }
  return midnights;
}

// Mission-timeline ruler: gridlines sit on IST midnights (not evenly spaced
// day slices from window start), and each day label is positioned at the
// start of the day it names, so labels and gridlines line up.
export function renderRuler(gridlinesEl, labelsEl, startMs, endMs) {
  const span = endMs - startMs;
  const midnights = istMidnightsInRange(startMs, endMs);

  gridlinesEl.innerHTML = '';
  for (const ms of midnights) {
    const line = document.createElement('i');
    line.className = 'gridline';
    line.style.left = `${((ms - startMs) / span) * 100}%`;
    gridlinesEl.appendChild(line);
  }

  labelsEl.innerHTML = '';
  for (const ms of [startMs, ...midnights]) {
    const span_ = document.createElement('span');
    span_.className = 'ruler-label';
    span_.textContent = fmtDayLabel(ms);
    span_.style.left = `${((ms - startMs) / span) * 100}%`;
    labelsEl.appendChild(span_);
  }
}

// Parses "... max_collision_probability >= 1e-4" out of the engine's
// risk_bands.rules text, so the legend's boundary ticks stay true to the
// live thresholds instead of duplicating magic numbers the frontend
// doesn't own. Risk band is driven by max Pc alone (see risk.py), not
// miss distance, so the legend reads as a probability axis.
function parsePcBoundary(ruleText) {
  const m = ruleText.match(/max_collision_probability >= ([\d.eE+-]+)/);
  return m ? Number(m[1]) : null;
}

// Axis bounds for the legend's log scale: the true range of a probability.
const PC_AXIS_FLOOR = 1e-9;
const PC_AXIS_CEIL = 1;

function pcLogPct(pc) {
  const clamped = Math.min(Math.max(pc, PC_AXIS_FLOOR), PC_AXIS_CEIL);
  return (Math.log10(clamped) - Math.log10(PC_AXIS_FLOOR)) / (Math.log10(PC_AXIS_CEIL) - Math.log10(PC_AXIS_FLOOR));
}

export function renderLegend(barEl, ticksEl, thresholdEl, riskBands) {
  const boundaries = ['MODERATE', 'HIGH', 'CRITICAL']
    .map((band) => parsePcBoundary(riskBands.rules[band]))
    .filter((v) => v !== null);

  const stops = [PC_AXIS_FLOOR, ...boundaries, PC_AXIS_CEIL];
  const colors = ['low', 'moderate', 'high', 'critical'];
  const gradientParts = [];
  for (let i = 0; i < colors.length; i++) {
    const from = pcLogPct(stops[i]) * 100;
    const to = pcLogPct(stops[i + 1]) * 100;
    gradientParts.push(`var(--${colors[i]}) ${from}%`, `var(--${colors[i]}) ${to}%`);
  }
  barEl.style.background = `linear-gradient(to right, ${gradientParts.join(', ')})`;

  ticksEl.innerHTML = boundaries
    .map((pc) => `<span class="tick" style="left:${pcLogPct(pc) * 100}%"></span>`)
    .join('');

  const critical = boundaries[boundaries.length - 1];
  thresholdEl.textContent = critical ? `≥ ${critical.toExponential(0)} critical` : '';
}

export function renderDetail(bodyEl, c, riskBands) {
  bodyEl.innerHTML = '';

  const headline = document.createElement('p');
  headline.className = 'detail-headline';
  headline.textContent = `${c.primary.name} (#${c.primary.norad_id}) and ${c.secondary.name} (#${c.secondary.norad_id})`;
  bodyEl.appendChild(headline);

  const bandRow = document.createElement('div');
  bandRow.className = 'detail-band-row';
  bandRow.innerHTML = `<span class="risk-band-tag band-${c.risk_band}">${c.risk_band}</span>
    <span class="detail-tca">TCA ${fmtIst(c.tca_utc)}</span>`;
  bodyEl.appendChild(bandRow);

  const objects = document.createElement('div');
  objects.className = 'detail-objects';
  for (const role of ['primary', 'secondary']) {
    const o = c[role];
    const box = document.createElement('div');
    box.className = 'detail-object' + (o.owner_country === 'IND' ? ' is-indian' : '');
    box.innerHTML = `
      <div class="detail-object-name">${o.name}</div>
      <div class="detail-object-meta">${o.object_type} · ${o.rcs_size} RCS · owner ${o.owner_country ?? 'UNKNOWN'} · data ${o.data_age_hours.toFixed(1)}h old</div>
    `;
    objects.appendChild(box);
  }
  bodyEl.appendChild(objects);

  const metrics = document.createElement('div');
  metrics.className = 'detail-metrics';
  const staleData = c.data_age_hours > 24;
  metrics.innerHTML = `
    ${metric('Miss distance', `${c.miss_distance_km.toFixed(3)} km`)}
    ${metric('Relative velocity', `${c.relative_velocity_km_s.toFixed(3)} km/s`)}
    ${metric('Collision probability', c.collision_probability.toExponential(2))}
    ${metric('Max collision probability', c.max_collision_probability.toExponential(2))}
    ${metric('Combined hard-body radius', `${c.combined_hard_body_radius_m.toFixed(2)} m`)}
    ${metric('Combined position sigma', `${c.combined_position_sigma_km.toFixed(2)} km`)}
    ${metric('Element-set age', `${c.data_age_hours.toFixed(1)} h`, staleData)}
    ${metric('Risk band', c.risk_band)}
  `;
  bodyEl.appendChild(metrics);

  const note = document.createElement('div');
  note.className = 'detail-note';
  note.textContent = `${riskBands.basis} ${riskBands.rules[c.risk_band]}`;
  bodyEl.appendChild(note);
}

function metric(label, value, warn) {
  return `<div class="detail-metric">
    <div class="detail-metric-label">${label}</div>
    <div class="detail-metric-value${warn ? ' is-warning' : ''}">${value}</div>
  </div>`;
}

// A tick's height carries risk band, since a flat wall of same-height marks
// is what made the bar unreadable at 543 conjunctions: critical passes now
// read as tall spikes above a low hum of routine ones, like a strip-chart.
const TICK_HEIGHT_PX = { CRITICAL: 12, HIGH: 9, MODERATE: 5, LOW: 3 };

// ponytail: the density track's `.d` bars stay individually positioned by
// exact TCA (not bucketed into even time slices) so a risk-row click can
// still flash "the matching scrub-tick" by conjunction id (report item 7).
function densityClass(band) {
  if (band === 'CRITICAL') return 'd crit';
  if (band === 'HIGH') return 'd hi';
  return 'd';
}

export function renderTicks(ticksEl, conjunctions, startMs, endMs, onJump) {
  ticksEl.innerHTML = '';
  const span = endMs - startMs;
  for (const c of conjunctions) {
    const t = new Date(c.tca_utc).getTime();
    if (t < startMs || t > endMs) continue;
    const pct = ((t - startMs) / span) * 100;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = densityClass(c.risk_band);
    btn.dataset.id = c.id;
    btn.style.left = `${pct}%`;
    btn.style.height = `${TICK_HEIGHT_PX[c.risk_band] ?? 3}px`;
    btn.setAttribute(
      'aria-label',
      `Jump to ${c.primary.name} / ${c.secondary.name} closest approach, ${c.risk_band} risk`,
    );
    btn.title = `${c.primary.name} x ${c.secondary.name} - ${fmtIst(c.tca_utc)}`;
    btn.addEventListener('click', () => onJump(c));
    ticksEl.appendChild(btn);
  }
}

export function fmtRelative(currentMs, refMs) {
  return fmtDuration((refMs - currentMs) / 1000);
}
