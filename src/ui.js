import { fmtUtc, fmtDuration, plainLanguageLine } from './data.js';

// Log-scaled position (0..1) of a distance inside [floorKm, ceilKm], so a
// 0.02 km pass and a 4 km pass both land somewhere legible instead of every
// non-critical mark bunching up against one end of a linear scale.
const RULER_FLOOR_KM = 0.01;

function logPct(km, ceilKm) {
  const clamped = Math.max(km, RULER_FLOOR_KM);
  const pct = (Math.log10(clamped) - Math.log10(RULER_FLOOR_KM)) / (Math.log10(ceilKm) - Math.log10(RULER_FLOOR_KM));
  return Math.min(1, Math.max(0, pct));
}

function missRulerHTML(missKm, thresholdKm, band) {
  const pct = logPct(missKm, thresholdKm);
  const top = (1 - pct) * (100 - 8) + 4; // keep the mark clear of the track ends
  return `
    <div class="miss-ruler" title="Miss distance ${missKm.toFixed(2)} km against the ${thresholdKm} km reporting threshold">
      <div class="miss-ruler-track"></div>
      <div class="miss-ruler-threshold"></div>
      <div class="miss-ruler-mark band-${band}" style="top:${top}%"></div>
    </div>
  `;
}

export function renderRiskList(listEl, countEl, conjunctions, selectedId, currentTime, thresholdKm, onSelect) {
  countEl.textContent = conjunctions.length ? `${conjunctions.length} tracked` : '';

  if (conjunctions.length === 0) {
    listEl.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'panel-empty';
    empty.textContent = 'No conjunctions inside the reporting threshold for this window.';
    listEl.appendChild(empty);
    return;
  }

  listEl.innerHTML = '';
  for (const c of conjunctions) {
    const li = document.createElement('li');
    li.className = 'risk-row-item';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `risk-row${c.id === selectedId ? ' is-selected' : ''}`;
    btn.setAttribute('aria-pressed', String(c.id === selectedId));

    btn.innerHTML = missRulerHTML(c.miss_distance_km, thresholdKm, c.risk_band);

    const content = document.createElement('div');
    content.className = 'risk-row-content';

    const top = document.createElement('div');
    top.className = 'risk-row-top';
    const band = document.createElement('span');
    band.className = `risk-band-tag band-${c.risk_band}`;
    band.textContent = c.risk_band;
    top.appendChild(band);
    if (c.india_related) {
      const tag = document.createElement('span');
      tag.className = 'risk-row-india-tag';
      tag.textContent = 'INDIA';
      top.appendChild(tag);
    }
    content.appendChild(top);

    const line = document.createElement('p');
    line.className = 'risk-row-line';
    line.textContent = plainLanguageLine(c, currentTime) + ` Risk: ${titleCase(c.risk_band)}.`;
    content.appendChild(line);

    const stats = document.createElement('div');
    stats.className = 'risk-row-stats';
    stats.innerHTML = `
      <span>Miss <b>${c.miss_distance_km.toFixed(2)} km</b></span>
      <span>Max Pc <b>${c.max_collision_probability.toExponential(1)}</b></span>
    `;
    content.appendChild(stats);

    btn.appendChild(content);

    btn.addEventListener('click', () => onSelect(c.id));
    li.appendChild(btn);
    listEl.appendChild(li);
  }
}

function titleCase(s) {
  return s.charAt(0) + s.slice(1).toLowerCase();
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
    .map((pc) => `<span class="legend-ruler-tick" style="left:${pcLogPct(pc) * 100}%"></span>`)
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
    <span class="detail-tca">TCA ${fmtUtc(c.tca_utc)}</span>`;
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
const TICK_OPACITY = { CRITICAL: 0.95, HIGH: 0.85, MODERATE: 0.55, LOW: 0.4 };

export function renderTicks(ticksEl, conjunctions, startMs, endMs, onJump) {
  ticksEl.innerHTML = '';
  const span = endMs - startMs;
  for (const c of conjunctions) {
    const t = new Date(c.tca_utc).getTime();
    if (t < startMs || t > endMs) continue;
    const pct = ((t - startMs) / span) * 100;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'scrub-tick';
    btn.style.left = `${pct}%`;
    btn.style.height = `${TICK_HEIGHT_PX[c.risk_band] ?? 3}px`;
    btn.style.setProperty('--tick-opacity', String(TICK_OPACITY[c.risk_band] ?? 0.4));
    btn.style.background = `var(--${c.risk_band.toLowerCase()})`;
    btn.setAttribute(
      'aria-label',
      `Jump to ${c.primary.name} / ${c.secondary.name} closest approach, ${c.risk_band} risk`,
    );
    btn.title = `${c.primary.name} x ${c.secondary.name} - ${fmtUtc(c.tca_utc)}`;
    btn.addEventListener('click', () => onJump(c));
    ticksEl.appendChild(btn);
  }
}

export function fmtRelative(currentMs, refMs) {
  return fmtDuration((refMs - currentMs) / 1000);
}
