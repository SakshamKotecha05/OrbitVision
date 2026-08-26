import * as Cesium from 'cesium';
import { positionEcefKm, positionEciKm, gmstAt } from './propagate.js';

// Never touch Cesium ion: no token, no ion-backed imagery/terrain/geocoder.
Cesium.Ion.defaultAccessToken = undefined;

export const BAND_COLOR = {
  CRITICAL: Cesium.Color.fromCssColorString('#FF3B47'),
  HIGH: Cesium.Color.fromCssColorString('#FF8A3D'),
  MODERATE: Cesium.Color.fromCssColorString('#F2C94C'),
  LOW: Cesium.Color.fromCssColorString('#4FD1C5'),
};
const ACCENT_CYAN = Cesium.Color.fromCssColorString('#5AC8FA');
const ACCENT_SAFFRON = Cesium.Color.fromCssColorString('#FFB454');

// One revolution every 5 minutes: reads as a stately planet turning, not a
// spinning toy. Camera-only orbit around the ECEF Z axis, never the clock -
// the mission timeline alone owns simulated time, and ground tracks are
// sampled per-point with their own GMST, so nothing here may nudge it.
const IDLE_ROTATE_RADIANS_PER_SEC = (2 * Math.PI) / 300;
const IDLE_RESUME_MS = 4000;

function setupIdleRotation(viewer) {
  const canvas = viewer.scene.canvas;
  let lastInteractionMs = performance.now();
  let pointerDown = false;

  function markInteraction() {
    lastInteractionMs = performance.now();
  }
  function onPointerDown() {
    pointerDown = true;
    markInteraction();
  }
  function onPointerUp() {
    pointerDown = false;
    markInteraction();
  }
  function onPointerMove() {
    if (pointerDown) markInteraction();
  }

  canvas.addEventListener('mousedown', onPointerDown);
  canvas.addEventListener('touchstart', onPointerDown, { passive: true });
  canvas.addEventListener('wheel', markInteraction, { passive: true });
  canvas.addEventListener('mousemove', onPointerMove);
  canvas.addEventListener('touchmove', onPointerMove, { passive: true });
  window.addEventListener('mouseup', onPointerUp);
  window.addEventListener('touchend', onPointerUp);

  let lastFrameMs = performance.now();
  viewer.scene.preRender.addEventListener(() => {
    const nowMs = performance.now();
    const deltaS = (nowMs - lastFrameMs) / 1000;
    lastFrameMs = nowMs;

    if (!pointerDown && nowMs - lastInteractionMs > IDLE_RESUME_MS) {
      viewer.camera.rotate(Cesium.Cartesian3.UNIT_Z, -IDLE_ROTATE_RADIANS_PER_SEC * deltaS);
    }
  });

  // flyToConjunction / flyToIndia call this so a camera flight always wins
  // and idle rotation only resumes once it has settled.
  viewer.orbitVisionMarkInteraction = markInteraction;
}

export async function createGlobe(containerId) {
  const dayProvider = Cesium.SingleTileImageryProvider.fromUrl('textures/earth-day.jpg');
  const nightProvider = Cesium.SingleTileImageryProvider.fromUrl('textures/earth-night.jpg');

  const viewer = new Cesium.Viewer(containerId, {
    baseLayer: Cesium.ImageryLayer.fromProviderAsync(dayProvider),
    baseLayerPicker: false,
    geocoder: false,
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    animation: false,
    timeline: false,
    sceneModePicker: false,
    homeButton: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    shouldAnimate: false,
  });

  // City lights layer: dayAlpha 0 keeps it invisible on the lit hemisphere,
  // nightAlpha 1 shows it wherever enableLighting says the sun isn't up.
  const nightLayer = Cesium.ImageryLayer.fromProviderAsync(nightProvider);
  nightLayer.dayAlpha = 0.0;
  nightLayer.nightAlpha = 1.0;
  viewer.scene.imageryLayers.add(nightLayer);

  const globe = viewer.scene.globe;
  globe.enableLighting = true;
  globe.dynamicAtmosphereLighting = true;
  globe.showGroundAtmosphere = true;
  globe.baseColor = Cesium.Color.fromCssColorString('#050912');

  // Cesium's realistic-atmosphere defaults (0/0/0) - the previous build
  // fought them with three negative shifts, which is what flattened the
  // limb glow into a cartoon halo.
  viewer.scene.skyAtmosphere.hueShift = 0.0;
  viewer.scene.skyAtmosphere.saturationShift = 0.0;
  viewer.scene.skyAtmosphere.brightnessShift = 0.0;

  viewer.cesiumWidget.creditContainer.style.display = 'none';

  setupIdleRotation(viewer);

  return viewer;
}

function toCartesian(ecefKm) {
  return new Cesium.Cartesian3(ecefKm[0] * 1000, ecefKm[1] * 1000, ecefKm[2] * 1000);
}

// Light outline (was near-black): against a lit photographic globe a black
// ring can vanish into the night hemisphere or shadowed ocean, where the
// old flat-black scene never had that problem. A light ring holds contrast
// on both the lit and unlit sides.
const POINT_OUTLINE = Cesium.Color.fromCssColorString('#E6EDF3').withAlpha(0.85);

// The bulk object cloud: PointPrimitiveCollection, not Entity, so scrubbing
// stays smooth however many objects the real engine ends up reporting.
export function buildObjectCloud(viewer, entries) {
  const collection = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
  const refs = entries.map((e) => {
    const isIndian = e.obj.owner_country === 'IND';
    const primitive = collection.add({
      position: Cesium.Cartesian3.ZERO,
      pixelSize: isIndian ? 10 : e.band === 'CRITICAL' || e.band === 'HIGH' ? 8 : 7,
      color: isIndian ? ACCENT_SAFFRON : BAND_COLOR[e.band],
      outlineColor: isIndian ? Cesium.Color.fromCssColorString('#3A2A0F') : POINT_OUTLINE,
      outlineWidth: isIndian ? 2 : 1.5,
      show: false,
      id: { isFleetObject: true, name: e.obj.name, band: e.band, isIndian },
    });
    return { ...e, primitive };
  });

  function update(date, visibleNoradIds) {
    for (const r of refs) {
      if (visibleNoradIds && !visibleNoradIds.has(r.noradId)) {
        r.primitive.show = false;
        continue;
      }
      const pos = positionEcefKm(r.satrec, date);
      if (pos) {
        r.primitive.position = toCartesian(pos);
        r.primitive.show = true;
      } else {
        r.primitive.show = false;
      }
    }
  }

  return { collection, refs, update };
}

// Ambient shell colour: a single cool, very-low-alpha neutral rather than
// band colour. Tinting 700+ rings by band read as coloured spaghetti
// competing with the point cloud's own band colours; one quiet tone reads
// as a shell on both the lit and night hemispheres and stays out of the way
// of the highlighted conjunction's cyan/saffron tracks. The alpha is far
// lower than a single ring would want - with 700+ overlapping near the
// poles, anything above a few percent stacks into a bright haze. Tuned by
// eye in-browser (0.16 -> 0.08 -> 0.045 -> 0.03) against the default,
// selected-conjunction, and India Watch views; 0.03 was the first value
// that read as a soft shell rather than a wireframe ball.
const ORBIT_RING_COLOR = Cesium.Color.fromCssColorString('#8FB4D6').withAlpha(0.03);

// Row-major ECI(TEME)->ECEF rotation for a single instant, built from the
// same GMST angle positionEcefKm uses per-point. Verified against
// satellite.js's own eciToEcf() output rather than assumed from convention.
function eciToEcefMatrix4(gmst) {
  const c = Math.cos(gmst);
  const s = Math.sin(gmst);
  return Cesium.Matrix4.fromRotationTranslation(new Cesium.Matrix3(c, s, 0, -s, c, 0, 0, 0, 1), Cesium.Cartesian3.ZERO);
}

// One period of an object's orbit sampled in the raw inertial (TEME) frame,
// centered on the object's own element epoch for best SGP4 accuracy. These
// points are never rotated to ECEF individually - the whole ring rotates as
// one rigid body via the primitive's modelMatrix, so this only runs once
// per object, not once per frame.
function orbitRingEci(satrec, epochDate, periodMinutes, pointCount = 72) {
  const points = [];
  const spanMs = periodMinutes * 60 * 1000;
  const startMs = epochDate.getTime() - spanMs / 2;
  const stepMs = spanMs / (pointCount - 1);
  for (let i = 0; i < pointCount; i++) {
    const t = new Date(startMs + i * stepMs);
    const pos = positionEciKm(satrec, t);
    if (pos) points.push(toCartesian(pos));
  }
  return points;
}

function ringGeometryInstance(noradId, positions) {
  return new Cesium.GeometryInstance({
    geometry: new Cesium.PolylineGeometry({
      positions,
      width: 1,
      vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT,
      arcType: Cesium.ArcType.NONE,
    }),
    attributes: {
      color: Cesium.ColorGeometryInstanceAttribute.fromColor(ORBIT_RING_COLOR),
    },
    id: { noradId },
  });
}

// Ambient orbit shell: every tracked object's full ring, batched into one
// Cesium.Primitive (a handful of GPU draw calls, geometry baked once) and
// re-oriented each frame by writing its modelMatrix - a single czm_model
// uniform, not a per-vertex rebuild. That's the part a PointPrimitiveCollection
// or PolylineCollection can't give you: PolylineCollection's own modelMatrix
// setter re-encodes every polyline's vertex buffer on every assignment
// (measured ~20-40ms/frame for this object count, worse than not having
// rings at all), which is why this reaches for the lower-level Primitive/
// GeometryInstance API instead. See PR body for the before/after numbers.
export function buildOrbitRings(viewer, entries) {
  const rings = entries
    .map((e) => ({
      noradId: e.noradId,
      positions: orbitRingEci(e.satrec, new Date(e.obj.orbit.epoch_utc), e.obj.orbit.period_minutes),
    }))
    .filter((r) => r.positions.length > 1);

  function makePrimitive(list) {
    if (list.length === 0) return null;
    return viewer.scene.primitives.add(
      new Cesium.Primitive({
        geometryInstances: list.map((r) => ringGeometryInstance(r.noradId, r.positions)),
        // Explicit depthTest: translucent geometry must still occlude behind
        // the opaque globe (depthMask stays off so blending order among the
        // rings themselves is undefined but harmless at this alpha) - without
        // it every ring's far-side arc bleeds through the planet and the
        // shell reads as a wireframe ball instead of orbits around a solid Earth.
        appearance: new Cesium.PolylineColorAppearance({
          translucent: true,
          renderState: {
            depthTest: { enabled: true },
            depthMask: false,
            blending: Cesium.BlendingState.ALPHA_BLEND,
          },
        }),
        asynchronous: false,
      }),
    );
  }

  let primitive = makePrimitive(rings);
  let lastFilterState = 'global';

  function update(date, visibleNoradIds) {
    const modelMatrix = eciToEcefMatrix4(gmstAt(date));
    if (primitive) primitive.modelMatrix = modelMatrix;

    const filterState = visibleNoradIds ? 'filtered' : 'global';
    if (filterState === lastFilterState) return;
    lastFilterState = filterState;

    if (primitive) viewer.scene.primitives.remove(primitive);
    const visible = visibleNoradIds ? rings.filter((r) => visibleNoradIds.has(r.noradId)) : rings;
    primitive = makePrimitive(visible);
    if (primitive) primitive.modelMatrix = modelMatrix;
  }

  return { update };
}

// Samples one full orbital period around the conjunction's TCA, converting
// each sample's ECI position to ECEF with that sample's own GMST. That
// per-sample conversion (not one rotation of the whole ellipse) is what the
// contract's frame_note warns is required for an Earth-fixed scene.
function groundTrack(satrec, centerDate, periodMinutes, pointCount = 120) {
  const points = [];
  const spanMs = periodMinutes * 60 * 1000;
  const startMs = centerDate.getTime() - spanMs / 2;
  const stepMs = spanMs / (pointCount - 1);
  for (let i = 0; i < pointCount; i++) {
    const t = new Date(startMs + i * stepMs);
    const pos = positionEcefKm(satrec, t);
    if (pos) points.push(toCartesian(pos));
  }
  return points;
}

export function highlightConjunction(viewer, conjunction, satrecOf) {
  const entities = [];
  for (const role of ['primary', 'secondary']) {
    const obj = conjunction[role];
    const satrec = satrecOf(obj.norad_id);
    const isIndian = obj.owner_country === 'IND';
    const color = isIndian ? ACCENT_SAFFRON : ACCENT_CYAN;

    const track = groundTrack(satrec, new Date(conjunction.tca_utc), obj.orbit.period_minutes);
    entities.push(
      viewer.entities.add({
        polyline: {
          positions: track,
          width: 2,
          material: new Cesium.PolylineOutlineMaterialProperty({
            color: color.withAlpha(0.85),
            outlineWidth: 1,
            outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
          }),
          clampToGround: false,
        },
      }),
    );

    entities.push(
      viewer.entities.add({
        id: `marker-${obj.norad_id}`,
        position: Cesium.Cartesian3.ZERO,
        point: {
          pixelSize: 14,
          color,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: obj.name,
          font: '600 13px ui-monospace, SFMono-Regular, Menlo, monospace',
          fillColor: Cesium.Color.fromCssColorString('#E6EDF3'),
          outlineColor: Cesium.Color.fromCssColorString('#04060A'),
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -16),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      }),
    );
  }

  function update(date) {
    for (const role of ['primary', 'secondary']) {
      const obj = conjunction[role];
      const satrec = satrecOf(obj.norad_id);
      const marker = viewer.entities.getById(`marker-${obj.norad_id}`);
      const pos = positionEcefKm(satrec, date);
      if (marker && pos) marker.position = toCartesian(pos);
    }
  }

  function remove() {
    for (const e of entities) viewer.entities.remove(e);
  }

  return { update, remove };
}

export function flyToConjunction(viewer, conjunction, satrecOf) {
  const points = [];
  for (const role of ['primary', 'secondary']) {
    const obj = conjunction[role];
    const pos = positionEcefKm(satrecOf(obj.norad_id), new Date(conjunction.tca_utc));
    if (pos) points.push(toCartesian(pos));
  }
  if (points.length === 0) return;
  const sphere = Cesium.BoundingSphere.fromPoints(points);
  sphere.radius = Math.max(sphere.radius * 6, 400000);
  viewer.orbitVisionMarkInteraction?.();
  viewer.camera.flyToBoundingSphere(sphere, {
    duration: 1.6,
    offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-35), sphere.radius * 2.4),
    complete: () => viewer.orbitVisionMarkInteraction?.(),
  });
}

export function flyToIndia(viewer) {
  viewer.orbitVisionMarkInteraction?.();
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(78.9629, 20.5937, 6500000),
    duration: 1.4,
    complete: () => viewer.orbitVisionMarkInteraction?.(),
  });
}

// Hover-to-identify on the point cloud: cheap scene.pick under a throttle so
// it stays smooth at full object count, wired to a caller-owned DOM tooltip
// (project type/colour tokens live in style.css, not here).
export function attachHoverTooltip(viewer, tooltipEl) {
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  const PICK_THROTTLE_MS = 40;
  let lastPickMs = 0;

  handler.setInputAction((movement) => {
    const nowMs = performance.now();
    if (nowMs - lastPickMs < PICK_THROTTLE_MS) return;
    lastPickMs = nowMs;

    const picked = viewer.scene.pick(movement.endPosition);
    const info = picked?.id?.isFleetObject ? picked.id : null;
    if (!info) {
      tooltipEl.hidden = true;
      return;
    }

    tooltipEl.hidden = false;
    tooltipEl.style.left = `${movement.endPosition.x + 14}px`;
    tooltipEl.style.top = `${movement.endPosition.y + 14}px`;

    tooltipEl.textContent = '';
    const nameEl = document.createElement('div');
    nameEl.className = 'globe-tooltip-name';
    nameEl.textContent = info.name;
    const metaEl = document.createElement('div');
    metaEl.className = 'globe-tooltip-meta';
    const bandEl = document.createElement('span');
    bandEl.className = `globe-tooltip-band band-${info.band.toLowerCase()}`;
    bandEl.textContent = info.band;
    metaEl.appendChild(bandEl);
    if (info.isIndian) {
      const indiaEl = document.createElement('span');
      indiaEl.className = 'globe-tooltip-india';
      indiaEl.textContent = 'INDIA';
      metaEl.appendChild(indiaEl);
    }
    tooltipEl.append(nameEl, metaEl);
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  viewer.scene.canvas.addEventListener('mouseleave', () => {
    tooltipEl.hidden = true;
  });
}
