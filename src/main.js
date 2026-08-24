import './style.css';
import { loadData, uniqueObjects, fmtUtc } from './data.js';
import { buildSatrec } from './propagate.js';
import {
  createGlobe,
  buildObjectCloud,
  highlightConjunction,
  flyToConjunction,
  flyToIndia,
} from './globe.js';
import { renderRiskList, renderDetail, renderTicks, renderLegend } from './ui.js';

// Prefer the real pipeline output when it exists; fall back to the
// fabricated sample so the demo still runs before the engine has produced
// data/output.json. ?data= always wins when given explicitly.
async function resolveDataUrl() {
  const explicit = new URLSearchParams(location.search).get('data');
  if (explicit) return explicit;
  try {
    const res = await fetch('data/output.json', { method: 'HEAD' });
    if (res.ok) return 'data/output.json';
  } catch {
    // network error probing for the real file: fall through to the sample
  }
  return 'data/sample-output.json';
}

const el = {
  modeGlobal: document.getElementById('mode-global'),
  modeIndia: document.getElementById('mode-india'),
  metaWindow: document.getElementById('meta-window'),
  metaScreened: document.getElementById('meta-screened'),
  uncertaintyToggle: document.getElementById('uncertainty-toggle'),
  uncertaintyNote: document.getElementById('uncertainty-note'),
  panelHeading: document.getElementById('panel-heading'),
  panelCount: document.getElementById('panel-count'),
  riskRows: document.getElementById('risk-rows'),
  panelList: document.getElementById('panel-list'),
  panelDetail: document.getElementById('panel-detail'),
  detailBack: document.getElementById('detail-back'),
  detailBody: document.getElementById('detail-body'),
  indiaBanner: document.getElementById('india-banner'),
  indiaBannerCopy: document.getElementById('india-banner-copy'),
  legendRulerBar: document.getElementById('legend-ruler-bar'),
  legendRulerTicks: document.getElementById('legend-ruler-ticks'),
  legendThreshold: document.getElementById('legend-threshold'),
  playToggle: document.getElementById('play-toggle'),
  playIcon: document.getElementById('play-icon'),
  scrubClock: document.getElementById('scrub-clock'),
  scrubRel: document.getElementById('scrub-rel'),
  scrubSlider: document.getElementById('scrub-slider'),
  scrubTicks: document.getElementById('scrub-ticks'),
  scrubStart: document.getElementById('scrub-start'),
  scrubEnd: document.getElementById('scrub-end'),
  speedSelect: document.getElementById('speed-select'),
};

const SLIDER_MAX = 1000;
const PLAY_PATH = 'M8 5v14l11-7z';
const PAUSE_PATH = 'M7 5h4v14H7zM13 5h4v14h-4z';

const state = {
  data: null,
  objects: null, // Map<noradId, {obj, satrec, worstBand}>
  mode: 'global', // 'global' | 'india'
  selectedId: null,
  windowStartMs: 0,
  windowEndMs: 0,
  currentMs: 0,
  playing: false,
  speedSecPerSec: 300,
  highlight: null, // active highlightConjunction() handle
};

async function main() {
  const dataUrl = await resolveDataUrl();
  const data = await loadData(dataUrl);
  state.data = data;

  const objMap = uniqueObjects(data);
  const bandRank = { CRITICAL: 0, HIGH: 1, MODERATE: 2, LOW: 3 };
  const worstBand = new Map();
  for (const c of data.conjunctions) {
    for (const id of [c.primary.norad_id, c.secondary.norad_id]) {
      const cur = worstBand.get(id);
      if (!cur || bandRank[c.risk_band] < bandRank[cur]) worstBand.set(id, c.risk_band);
    }
  }
  state.objects = new Map(
    [...objMap.entries()].map(([id, obj]) => [
      id,
      { obj, satrec: buildSatrec(obj.orbit, id), band: worstBand.get(id) },
    ]),
  );

  state.windowStartMs = new Date(data.screening.window_start_utc).getTime();
  state.windowEndMs = new Date(data.screening.window_end_utc).getTime();
  state.currentMs = state.windowStartMs;

  el.metaWindow.textContent = `${data.screening.window_hours}h`;
  el.metaScreened.textContent = `${data.screening.objects_screened} obj`;
  el.scrubStart.textContent = fmtUtc(data.screening.window_start_utc);
  el.scrubEnd.textContent = fmtUtc(data.screening.window_end_utc);

  el.uncertaintyNote.innerHTML = `<strong>Uncertainty is modelled, not measured.</strong> ${data.uncertainty_model.summary}`;
  el.uncertaintyNote.hidden = false;
  el.uncertaintyToggle.setAttribute('aria-expanded', 'true');

  const thresholdKm = data.screening.reporting_threshold_km;
  renderLegend(el.legendRulerBar, el.legendRulerTicks, el.legendThreshold, data.risk_bands);

  const viewer = await createGlobe('cesiumContainer');
  const entries = [...state.objects.entries()].map(([noradId, v]) => ({
    noradId,
    obj: v.obj,
    satrec: v.satrec,
    band: v.band,
  }));
  const cloud = buildObjectCloud(viewer, entries);

  function satrecOf(noradId) {
    return state.objects.get(noradId).satrec;
  }

  function activeConjunctions() {
    return state.mode === 'india' ? state.data.india.conjunctions : state.data.conjunctions;
  }

  function visibleNoradIds() {
    if (state.mode === 'global') return null;
    const ids = new Set();
    for (const c of state.data.india.conjunctions) {
      ids.add(c.primary.norad_id);
      ids.add(c.secondary.norad_id);
    }
    return ids;
  }

  function selectConjunction(id, { fly = true } = {}) {
    state.selectedId = id;
    if (state.highlight) {
      state.highlight.remove();
      state.highlight = null;
    }
    const c = activeConjunctions().find((x) => x.id === id) ?? state.data.conjunctions.find((x) => x.id === id);
    if (!c) return;

    state.highlight = highlightConjunction(viewer, c, satrecOf);
    if (fly) flyToConjunction(viewer, c, satrecOf);

    el.panelList.hidden = true;
    el.panelDetail.hidden = false;
    renderDetail(el.detailBody, c, state.data.risk_bands);
  }

  function backToList() {
    state.selectedId = null;
    if (state.highlight) {
      state.highlight.remove();
      state.highlight = null;
    }
    el.panelDetail.hidden = true;
    el.panelList.hidden = false;
    renderList();
  }

  function renderList() {
    const list = activeConjunctions();
    renderRiskList(el.riskRows, el.panelCount, list, state.selectedId, new Date(state.currentMs), thresholdKm, (id) =>
      selectConjunction(id),
    );
    renderTicks(el.scrubTicks, list, state.windowStartMs, state.windowEndMs, (c) => {
      state.currentMs = new Date(c.tca_utc).getTime();
      state.playing = false;
      updatePlayIcon();
      selectConjunction(c.id);
      syncSliderFromTime();
    });
  }

  function setMode(mode) {
    state.mode = mode;
    document.body.classList.toggle('mode-india', mode === 'india');
    el.modeGlobal.classList.toggle('is-active', mode === 'global');
    el.modeGlobal.setAttribute('aria-selected', String(mode === 'global'));
    el.modeIndia.classList.toggle('is-active', mode === 'india');
    el.modeIndia.setAttribute('aria-selected', String(mode === 'india'));
    el.indiaBanner.hidden = mode !== 'india';

    if (mode === 'india') {
      const ind = state.data.india;
      el.panelHeading.textContent = 'India watch: ranked risks';
      el.indiaBannerCopy.textContent = `${ind.objects_screened} operational satellites screened continuously against every tracked object. ${ind.conjunctions.length} conjunction${ind.conjunctions.length === 1 ? '' : 's'} inside the reporting threshold.`;
      flyToIndia(viewer);
    } else {
      el.panelHeading.textContent = 'Ranked risks';
    }

    state.selectedId = null;
    el.panelDetail.hidden = true;
    el.panelList.hidden = false;
    renderList();
  }

  el.modeGlobal.addEventListener('click', () => setMode('global'));
  el.modeIndia.addEventListener('click', () => setMode('india'));
  el.detailBack.addEventListener('click', backToList);

  el.uncertaintyToggle.addEventListener('click', () => {
    const open = el.uncertaintyNote.hidden;
    el.uncertaintyNote.hidden = !open;
    el.uncertaintyToggle.setAttribute('aria-expanded', String(open));
  });

  function syncSliderFromTime() {
    const frac = (state.currentMs - state.windowStartMs) / (state.windowEndMs - state.windowStartMs);
    el.scrubSlider.value = String(Math.round(frac * SLIDER_MAX));
  }

  el.scrubSlider.addEventListener('input', () => {
    state.playing = false;
    updatePlayIcon();
    const frac = Number(el.scrubSlider.value) / SLIDER_MAX;
    state.currentMs = state.windowStartMs + frac * (state.windowEndMs - state.windowStartMs);
    tickVisuals();
  });

  function updatePlayIcon() {
    el.playIcon.querySelector('path').setAttribute('d', state.playing ? PAUSE_PATH : PLAY_PATH);
    el.playToggle.setAttribute('aria-label', state.playing ? 'Pause time scrub' : 'Play time scrub');
  }

  el.playToggle.addEventListener('click', () => {
    if (!state.playing && state.currentMs >= state.windowEndMs) {
      state.currentMs = state.windowStartMs;
    }
    state.playing = !state.playing;
    updatePlayIcon();
  });

  el.speedSelect.addEventListener('change', () => {
    state.speedSecPerSec = Number(el.speedSelect.value);
  });

  window.addEventListener('resize', () => viewer.resize());

  function tickVisuals() {
    const date = new Date(state.currentMs);
    cloud.update(date, visibleNoradIds());
    if (state.highlight) state.highlight.update(date);
    el.scrubClock.textContent = fmtUtc(date.toISOString());
    const untilTca = state.selectedId
      ? state.data.conjunctions.find((c) => c.id === state.selectedId)
      : null;
    el.scrubRel.textContent = untilTca
      ? `TCA ${untilTca.risk_band.toLowerCase()} in view`
      : `t+${Math.round((state.currentMs - state.windowStartMs) / 60000)} min`;
  }

  let lastFrameMs = performance.now();
  function frame(nowMs) {
    const deltaS = (nowMs - lastFrameMs) / 1000;
    lastFrameMs = nowMs;

    if (state.playing) {
      state.currentMs += deltaS * state.speedSecPerSec * 1000;
      if (state.currentMs >= state.windowEndMs) {
        state.currentMs = state.windowEndMs;
        state.playing = false;
        updatePlayIcon();
      }
      syncSliderFromTime();
    }

    tickVisuals();
    requestAnimationFrame(frame);
  }

  setMode('global');
  tickVisuals();
  requestAnimationFrame(frame);
}

main().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<div style="color:#ff8a3d;font-family:monospace;padding:24px">Failed to load OrbitVision: ${err.message}</div>`;
});
