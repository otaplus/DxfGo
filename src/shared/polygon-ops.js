'use strict';

/**
 * Operaciones poligonales basadas en Clipper (sustituye a shapely en la versión
 * Python). Trabaja con anillos abiertos (el primer punto no se repite al final).
 *
 * Convención: `delta > 0` expande el polígono hacia fuera; `delta < 0` lo contrae.
 */

const ClipperLib = require('clipper-lib');

/** Factor de escala para pasar de milímetros a unidades enteras de Clipper. */
const SCALE = 10000;

/** Tolerancia de arco en unidades escaladas (5 µm) para uniones redondeadas. */
const ARC_TOLERANCE = 0.005 * SCALE;

const { JoinType, EndType } = ClipperLib;

/**
 * Factor aplicado al `delta` antes de llamar a ClipperOffset.
 *
 * Los anillos se normalizan a sentido antihorario (área positiva) y, en esa
 * convención, un `delta` positivo expande el polígono. El valor se comprueba al
 * cargar para detectar el caso contrario si cambiara el comportamiento del
 * polígono en una versión futura de Clipper.
 */
const GROW_SIGN = (() => {
  const square = [
    { X: 0, Y: 0 }, { X: 1000, Y: 0 }, { X: 1000, Y: 1000 }, { X: 0, Y: 1000 },
  ];
  if (ClipperLib.Clipper.Area(square) < 0) square.reverse();
  const offsetter = new ClipperLib.ClipperOffset(2, ARC_TOLERANCE);
  offsetter.AddPath(square, JoinType.jtRound, EndType.etClosedPolygon);
  const solution = [];
  offsetter.Execute(solution, 100);
  if (!solution.length) return 1;
  const area = Math.abs(ClipperLib.Clipper.Area(solution[0]));
  // Cuadrado de 1000x1000 desplazado 100: 1200^2 = 1.440.000 si expande.
  return area > 1000 * 1000 ? 1 : -1;
})();

/** Área con signo de un anillo (positiva si es antihorario). */
function signedArea(points) {
  let total = 0;
  const n = points.length;
  for (let i = 0; i < n; i += 1) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % n];
    total += x1 * y2 - x2 * y1;
  }
  return total / 2;
}

/** Área absoluta del anillo. */
function ringArea(points) {
  return Math.abs(signedArea(points));
}

/** Convierte [[x,y],...] a la representación entera de Clipper. */
function toClipperPath(points) {
  const path = [];
  for (let i = 0; i < points.length; i += 1) {
    const [x, y] = points[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const px = Math.round(x * SCALE);
    const py = Math.round(y * SCALE);
    const last = path[path.length - 1];
    if (last && last.X === px && last.Y === py) continue;
    path.push({ X: px, Y: py });
  }
  // Elimina el punto de cierre duplicado: Clipper trata los anillos como cerrados.
  while (path.length > 1) {
    const first = path[0];
    const last = path[path.length - 1];
    if (first.X === last.X && first.Y === last.Y) path.pop();
    else break;
  }
  return path;
}

/** Convierte un path de Clipper a [[x,y],...] cerrando el anillo. */
function fromClipperPath(path) {
  const points = path.map((p) => [p.X / SCALE, p.Y / SCALE]);
  if (points.length > 1) {
    const first = points[0];
    const last = points[points.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) points.push([first[0], first[1]]);
  }
  return points;
}

/**
 * Desplaza (offset) uno o varios anillos cerrados.
 * @param {Array<Array<[number, number]>>} rings Anillos de entrada.
 * @param {number} delta Distancia en mm (>0 expande).
 * @param {object} [options]
 * @param {number} [options.step] Paso para anillos anidados en cajeado.
 * @returns {Array<Array<[number, number]>>} Anillos resultantes.
 */
function offsetRings(rings, delta) {
  const solution = [];
  const offsetter = new ClipperLib.ClipperOffset(2, ARC_TOLERANCE);

  let added = 0;
  for (const ring of rings) {
    const path = toClipperPath(ring);
    if (path.length < 3) continue;
    // Normaliza a antihorario para que GROW_SIGN sea determinista.
    if (ClipperLib.Clipper.Area(path) < 0) path.reverse();
    offsetter.AddPath(path, JoinType.jtRound, EndType.etClosedPolygon);
    added += 1;
  }
  if (!added) return [];

  offsetter.Execute(solution, delta * SCALE * GROW_SIGN);

  const results = [];
  for (const path of solution) {
    if (!path || path.length < 3) continue;
    const cleaned = ClipperLib.Clipper.CleanPolygon(path, 1);
    if (!cleaned || cleaned.length < 3) continue;
    results.push(fromClipperPath(cleaned));
  }
  return results.filter((ring) => ringArea(ring) > 1e-6);
}

/** Comprueba si un punto está en el segmento (con tolerancia). */
function onSegment(px, py, x1, y1, x2, y2, eps) {
  const cross = (px - x1) * (y2 - y1) - (py - y1) * (x2 - x1);
  if (Math.abs(cross) > eps) return false;
  const dot = (px - x1) * (x2 - x1) + (py - y1) * (y2 - y1);
  if (dot < -eps) return false;
  const lenSq = (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1);
  return dot <= lenSq + eps;
}

/**
 * Punto dentro de anillo por lanzamiento de rayo; el borde cuenta como interior.
 * @returns {boolean}
 */
function pointInRing(x, y, ring) {
  const n = ring.length;
  if (n < 3) return false;
  const eps = 1e-9;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (onSegment(x, y, xi, yi, xj, yj, eps)) return true;
    const intersects = ((yi > y) !== (yj > y))
      && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Caja envolvente de un anillo: [minX, minY, maxX, maxY]. */
function ringBounds(ring) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

/**
 * Indica si `outer` contiene estrictamente a `inner`.
 * Equivale a Polygon.contains() de shapely para polígonos sin intersección de bordes.
 */
function polygonContains(outer, inner) {
  if (outer === inner) return false;
  if (outer.length < 3 || inner.length < 3) return false;

  const [ax1, ay1, ax2, ay2] = ringBounds(outer);
  const [bx1, by1, bx2, by2] = ringBounds(inner);
  const eps = 1e-9;
  if (bx1 < ax1 - eps || by1 < ay1 - eps || bx2 > ax2 + eps || by2 > ay2 + eps) return false;

  const areaOuter = ringArea(outer);
  const areaInner = ringArea(inner);
  if (areaInner >= areaOuter) return false;

  // Muestreo del contorno interior: si todos sus puntos están dentro, lo contiene.
  const samples = Math.min(inner.length, 32);
  const stride = Math.max(1, Math.floor(inner.length / samples));
  for (let i = 0; i < inner.length; i += stride) {
    const [x, y] = inner[i];
    if (!pointInRing(x, y, outer)) return false;
  }
  return true;
}

module.exports = {
  SCALE,
  GROW_SIGN,
  signedArea,
  ringArea,
  ringBounds,
  offsetRings,
  pointInRing,
  polygonContains,
};
