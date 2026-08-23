import { fmtUtc, fmtDuration, plainLanguageLine } from './data.js';

export function renderRiskList(listEl, countEl, conjunctions, selectedId, currentTime, onSelect) {
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
    btn.className = `risk-row band-${c.risk_band}${c.id === selectedId ? ' is-selected' : ''}`;
    btn.setAttribute('aria-pressed', String(c.id === selectedId));

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
    btn.appendChild(top);

    const line = document.createElement('p');
    line.className = 'risk-row-line';
    line.textContent = plainLanguageLine(c, currentTime) + ` Risk: ${titleCase(c.risk_band)}.`;
    btn.appendChild(line);

    const stats = document.createElement('div');
    stats.className = 'risk-row-stats';
    stats.innerHTML = `
      <span>Miss <b>${c.miss_distance_km.toFixed(2)} km</b></span>
      <span>Max Pc <b>${c.max_collision_probability.toExponential(1)}</b></span>
    `;
    btn.appendChild(stats);

    btn.addEventListener('click', () => onSelect(c.id));
    li.appendChild(btn);
    listEl.appendChild(li);
  }
}

function titleCase(s) {
  return s.charAt(0) + s.slice(1).toLowerCase();
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
    <span style="font-family:var(--font-mono);font-size:11px;color:var(--text-faint)">TCA ${fmtUtc(c.tca_utc)}</span>`;
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
