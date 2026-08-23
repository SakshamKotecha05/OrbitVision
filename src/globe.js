import * as Cesium from 'cesium';
import { positionEcefKm } from './propagate.js';

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

export async function createGlobe(containerId) {
  const imageryProvider = Cesium.TileMapServiceImageryProvider.fromUrl(
    Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII'),
  );

  const viewer = new Cesium.Viewer(containerId, {
    baseLayer: Cesium.ImageryLayer.fromProviderAsync(imageryProvider),
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

  viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#04060A');
  viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#04060A');
  viewer.scene.skyAtmosphere.hueShift = -0.05;
  viewer.scene.skyAtmosphere.saturationShift = -0.35;
  viewer.scene.skyAtmosphere.brightnessShift = -0.3;
  viewer.cesiumWidget.creditContainer.style.display = 'none';

  return viewer;
}

function toCartesian(ecefKm) {
  return new Cesium.Cartesian3(ecefKm[0] * 1000, ecefKm[1] * 1000, ecefKm[2] * 1000);
}

// The bulk object cloud: PointPrimitiveCollection, not Entity, so scrubbing
// stays smooth however many objects the real engine ends up reporting.
export function buildObjectCloud(viewer, entries) {
  const collection = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
  const refs = entries.map((e) => {
    const isIndian = e.obj.owner_country === 'IND';
    const primitive = collection.add({
      position: Cesium.Cartesian3.ZERO,
      pixelSize: isIndian ? 10 : e.band === 'CRITICAL' || e.band === 'HIGH' ? 8 : 6,
      color: isIndian ? ACCENT_SAFFRON : BAND_COLOR[e.band],
      outlineColor: isIndian
        ? Cesium.Color.fromCssColorString('#3A2A0F')
        : Cesium.Color.fromCssColorString('#04060A'),
      outlineWidth: isIndian ? 2 : 1,
      show: false,
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
  viewer.camera.flyToBoundingSphere(sphere, {
    duration: 1.6,
    offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-35), sphere.radius * 2.4),
  });
}

export function flyToIndia(viewer) {
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(78.9629, 20.5937, 6500000),
    duration: 1.4,
  });
}
