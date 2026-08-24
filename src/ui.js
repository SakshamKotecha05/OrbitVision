import { fmtUtc, fmtDuration, fmtDayLabel } from './data.js';

// Caption's TCA read: "in 1d 4h" / "4h ago", relative to the scrubbed time.
function tcaCaption(c, currentTime) {
  const secs = (new Date(c.tca_utc).getTime() - currentTime.getTime()) / 1000;
  const dur = fmtDuration(secs).replace(/^[+-]/, '');
  return secs >= 0 ? `TCA in ${dur}` : `TCA ${dur} ago`;
}

export function renderRiskList(listEl, countEl, conjunctions, selectedId, currentTime, onSelect) {
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

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `cardR band-${c.risk_band}${c.id === selectedId ? ' is-selected' : ''}`;
    btn.setAttribute('aria-pressed', String(c.id === selectedId));

    const top = document.createElement('div');
    top.className = 'cardR-top';
    top.innerHTML = `
      <span class="cardR-names">${c.primary.name} × ${c.secondary.name}</span>
      <span class="cardR-top-right">${c.india_related ? '<span class="cardR-india-tag">INDIA</span>' : ''}<span class="cardR-band">${c.risk_band}</span></span>
    `;
    btn.appendChild(top);

    const hero = document.createElement('div');
    hero.className = 'cardR-hero';
    hero.innerHTML = `${c.miss_distance_km.toFixed(2)}<span>km miss</span>`;
    btn.appendChild(hero);

    const caption = document.createElement('div');
    caption.className = 'cardR-caption';
    caption.innerHTML = `<i></i>Max Pc <b>${c.max_collision_probability.toExponential(1)}</b> &middot; ${tcaCaption(c, currentTime)}`;
    btn.appendChild(caption);

    btn.addEventListener('click', () => onSelect(c.id));
    li.appendChild(btn);
    listEl.appendChild(li);
  }
}

// Mission-timeline ruler scaffolding: N-1 day gridlines and N+1 day labels
// across the loaded window, computed once at load since the window is static.
export function renderRuler(gridlinesEl, labelsEl, startMs, endMs) {
  const days = Math.max(1, Math.round((endMs - startMs) / 86400000));

  gridlinesEl.innerHTML = '';
  for (let i = 1; i < days; i++) {
    const line = document.createElement('i');
    line.className = 'gridline';
    line.style.left = `${(i / days) * 100}%`;
    gridlinesEl.appendChild(line);
  }

  labelsEl.innerHTML = '';
  for (let i = 0; i <= days; i++) {
    const span = document.createElement('span');
    span.textContent = fmtDayLabel(startMs + i * 86400000);
    labelsEl.appendChild(span);
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
    btn.title = `${c.primary.name} x ${c.secondary.name} - ${fmtUtc(c.tca_utc)}`;
    btn.addEventListener('click', () => onJump(c));
    ticksEl.appendChild(btn);
  }
}

export function fmtRelative(currentMs, refMs) {
  return fmtDuration((refMs - currentMs) / 1000);
}
