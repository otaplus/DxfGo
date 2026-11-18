'use strict';

/**
 * Cargador DXF: extrae y normaliza entidades 2D.
 *
 * Soporta LINE, ARC, CIRCLE, LWPOLYLINE, POLYLINE (incluidos bulges de arco),
 * SPLINE (NURBS con vector de nudos) y ELLIPSE, además de INSERT con expansión
 * recursiva de bloques (incluidos arreglos MINSERT).
 *
 * Todos los tipos se convierten a polilíneas de puntos [[x, y], ...] para que el
 * análisis geométrico y el mecanizado sean homogéneos, conservando información
 * de círculo/arco para los ciclos de taladrado.
 */

const fs = require('fs');
const path = require('path');
const DxfParser = require('dxf-parser');

const { LAYER_PALETTE } = require('./constants');

/** Tolerancia de teselado (mm): máxima flecha entre curva real y polilínea. */
const FLATTEN_TOLERANCE = 0.02;

/** Límite de recursión al expandir bloques (evita ciclos de bloques). */
const MAX_BLOCK_DEPTH = 8;

/** Operaciones CAM inferidas por el nombre de la capa. */
function inferOperation(layerName) {
  const upper = String(layerName).toUpperCase();
  if (upper.includes('AGUJERO') || upper.includes('HOLE') || upper.includes('INTERIOR')) {
    return 'PERFIL_INTERIOR';
  }
  if (upper.includes('GRABADO') || upper.includes('TEXT') || upper.includes('ENGRAVE')
    || upper.includes('LINE')) {
    return 'SOBRE_LINEA';
  }
  if (upper.includes('POCKET') || upper.includes('CAJEADO')) return 'CAJEADO';
  if (upper.includes('DRILL') || upper.includes('TALADRO')) return 'TALADRADO';
  return 'PERFIL_EXTERIOR';
}

/** Distancia de un punto a la recta definida por dos puntos. */
function distanceToLine(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) return Math.hypot(px - ax, py - ay);
  return Math.abs((px - ax) * dy - (py - ay) * dx) / len;
}

/**
 * Subdivide paramétricamente una curva hasta que la flecha sea <= tolerancia.
 * @param {(u:number)=>[number, number]} evalFn
 * @param {number} u0
 * @param {number} u1
 * @param {number} [tolerance]
 * @param {number} [initialSegments]
 * @returns {Array<[number, number]>}
 */
function flattenParametric(evalFn, u0, u1, tolerance = FLATTEN_TOLERANCE, initialSegments = 8) {
  const result = [];
  const tol = Math.max(1e-6, tolerance);
  const maxDepth = 10;

  const step = (u1 - u0) / initialSegments;
  let prev = evalFn(u0);
  result.push(prev);

  const refine = (ua, ub, pa, pb, depth) => {
    const um = (ua + ub) / 2;
    const pm = evalFn(um);
    const deviation = distanceToLine(pm[0], pm[1], pa[0], pa[1], pb[0], pb[1]);
    if (depth >= maxDepth || deviation <= tol) {
      result.push(pb);
      return;
    }
    refine(ua, um, pa, pm, depth + 1);
    refine(um, ub, pm, pb, depth + 1);
  };

  for (let i = 0; i < initialSegments; i += 1) {
    const ua = u0 + step * i;
    const ub = u0 + step * (i + 1);
    const pb = evalFn(ub);
    refine(ua, ub, prev, pb, 0);
    prev = pb;
  }

  return result;
}

/** Tesela un arco de círculo (ángulos en radianes, sentido antihorario). */
function tessellateArc(cx, cy, radius, startAngle, sweep, tolerance = FLATTEN_TOLERANCE, closed = false) {
  const absSweep = Math.abs(sweep);
  if (absSweep < 1e-9 || radius <= 1e-9) {
    return [[cx + radius * Math.cos(startAngle), cy + radius * Math.sin(startAngle)]];
  }
  const ratio = Math.max(-1, Math.min(1, 1 - tolerance / radius));
  const maxAngle = ratio <= -1 ? Math.PI : 2 * Math.acos(ratio);
  const segments = Math.max(2, Math.min(360, Math.ceil(absSweep / Math.max(1e-3, maxAngle))));

  const points = [];
  for (let i = 0; i <= segments; i += 1) {
    const angle = startAngle + (sweep * i) / segments;
    points.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]);
  }

  // Un barrido completo debe cerrar exactamente sobre el primer punto.
  if (Math.abs(Math.abs(sweep) - 2 * Math.PI) < 1e-9 && points.length > 2) {
    points[points.length - 1] = [points[0][0], points[0][1]];
  }

  return points;
}

/**
 * Expande una polilínea con bulges (arcos) a una secuencia de puntos.
 * @param {Array<{x:number,y:number,bulge?:number}>} vertices
 * @param {boolean} closed
 */
function tessellatePolyline(vertices, closed) {
  const clean = vertices.filter((v) => Number.isFinite(v.x) && Number.isFinite(v.y));
  if (!clean.length) return [];

  const points = [[clean[0].x, clean[0].y]];
  const count = clean.length;

  for (let i = 0; i < count - 1; i += 1) {
    const a = clean[i];
    const b = clean[i + 1];
    appendSegment(points, a, b);
  }

  if (closed && count > 1) {
    const last = clean[count - 1];
    const first = clean[0];
    const same = Math.abs(last.x - first.x) < 1e-9 && Math.abs(last.y - first.y) < 1e-9;
    // Si el DXF ya repite el primer vértice al final, no se añade otro cierre.
    if (!same) appendSegment(points, last, first);
  }

  return points;
}

/** Añade a `points` el tramo entre dos vértices, teselando el bulge si existe. */
function appendSegment(points, a, b) {
  const bulge = Number.isFinite(a.bulge) ? a.bulge : 0;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const chord = Math.hypot(dx, dy);

  if (Math.abs(bulge) < 1e-9 || chord < 1e-12) {
    points.push([b.x, b.y]);
    return;
  }

  const theta = 4 * Math.atan(bulge); // Barrido con signo (positivo = antihorario).
  const absTheta = Math.abs(theta);
  if (absTheta > 2 * Math.PI - 1e-6) {
    points.push([b.x, b.y]);
    return;
  }

  const radius = chord / (2 * Math.sin(absTheta / 2));
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  // Normal izquierda de la cuerda.
  const nx = -dy / chord;
  const ny = dx / chord;
  const offset = (chord / 2) / Math.tan(theta / 2);
  const cx = midX + nx * offset;
  const cy = midY + ny * offset;

  const startAngle = Math.atan2(a.y - cy, a.x - cx);
  const sweep = theta;
  const arcPoints = tessellateArc(cx, cy, radius, startAngle, sweep);
  for (let i = 1; i < arcPoints.length; i += 1) points.push(arcPoints[i]);
}

/**
 * Evalúa una B-Spline racional (de Boor) o, si faltan datos, interpola los
 * puntos de control con Catmull-Rom.
 * @returns {Array<[number, number]>}
 */
function tessellateSpline(entity) {
  const control = (entity.controlPoints || []).map((p) => [p.x, p.y]);
  const fit = (entity.fitPoints || []).map((p) => [p.x, p.y]);
  const degree = Number.isFinite(entity.degreeOfSplineCurve) ? entity.degreeOfSplineCurve : 3;
  const knots = entity.knotValues || [];

  if (control.length >= 2 && knots.length >= control.length + degree + 1) {
    const points = evaluateNurbs(control, knots, degree);
    if (points.length >= 2) return closeIfNeeded(points, entity);
  }
  if (fit.length >= 2) return closeIfNeeded(catmullRom(fit), entity);
  if (control.length >= 2) return closeIfNeeded(catmullRom(control), entity);
  return [];
}

/** Cierra la polilínea si la spline está marcada como cerrada. */
function closeIfNeeded(points, entity) {
  if (!entity.closed || points.length < 3) return points;
  const first = points[0];
  const last = points[points.length - 1];
  if (Math.hypot(first[0] - last[0], first[1] - last[1]) > 1e-9) points.push([first[0], first[1]]);
  return points;
}

/** Evaluación de B-Spline con el algoritmo de de Boor. */
function evaluateNurbs(control, knots, degree) {
  const n = control.length - 1;
  const p = Math.max(1, Math.min(degree, n));
  const uStart = knots[p];
  const uEnd = knots[n + 1];
  if (!(uEnd > uStart)) return [];

  const evalAt = (u) => {
    const clamped = Math.min(Math.max(u, uStart), uEnd);
    // Localiza el intervalo de nudos.
    let k = p;
    while (k < n && clamped >= knots[k + 1]) k += 1;
    const d = [];
    for (let j = 0; j <= p; j += 1) {
      const index = Math.min(Math.max(j + k - p, 0), n);
      d.push([control[index][0], control[index][1]]);
    }
    for (let r = 1; r <= p; r += 1) {
      for (let j = p; j >= r; j -= 1) {
        const i = j + k - p;
        const denom = knots[i + p - r + 1] - knots[i];
        const alpha = denom === 0 ? 0 : (clamped - knots[i]) / denom;
        d[j] = [
          (1 - alpha) * d[j - 1][0] + alpha * d[j][0],
          (1 - alpha) * d[j - 1][1] + alpha * d[j][1],
        ];
      }
    }
    return d[p];
  };

  return flattenParametric(evalAt, uStart, uEnd, FLATTEN_TOLERANCE, Math.max(8, control.length));
}

/** Interpolación Catmull-Rom usada como respaldo cuando no hay vector de nudos. */
function catmullRom(points) {
  if (points.length < 3) return points.slice();

  const extended = [points[0], ...points, points[points.length - 1]];
  const result = [];
  const segmentsPerSpan = 16;

  for (let i = 1; i < extended.length - 2; i += 1) {
    const p0 = extended[i - 1];
    const p1 = extended[i];
    const p2 = extended[i + 1];
    const p3 = extended[i + 2];
    for (let s = 0; s < segmentsPerSpan; s += 1) {
      const t = s / segmentsPerSpan;
      const t2 = t * t;
      const t3 = t2 * t;
      const x = 0.5 * ((2 * p1[0])
        + (-p0[0] + p2[0]) * t
        + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2
        + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const y = 0.5 * ((2 * p1[1])
        + (-p0[1] + p2[1]) * t
        + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2
        + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      result.push([x, y]);
    }
  }
  result.push([points[points.length - 1][0], points[points.length - 1][1]]);
  return result;
}

/** Tesela una elipse a partir de sus parámetros DXF. */
function tessellateEllipse(entity) {
  const center = entity.center || { x: 0, y: 0 };
  const major = entity.majorAxisEndPoint || { x: 1, y: 0 };
  const ratio = Number.isFinite(entity.axisRatio) ? entity.axisRatio : 1;
  const minor = { x: -major.y * ratio, y: major.x * ratio };

  const start = Number.isFinite(entity.startAngle) ? entity.startAngle : 0;
  let end = Number.isFinite(entity.endAngle) ? entity.endAngle : 2 * Math.PI;
  let sweep = end - start;
  if (sweep <= 0) sweep += 2 * Math.PI;

  const evalAt = (t) => {
    const angle = start + sweep * t;
    return [
      center.x + major.x * Math.cos(angle) + minor.x * Math.sin(angle),
      center.y + major.y * Math.cos(angle) + minor.y * Math.sin(angle),
    ];
  };

  const points = flattenParametric(evalAt, 0, 1, FLATTEN_TOLERANCE, 16);
  const isFull = sweep >= 2 * Math.PI - 1e-6;
  if (isFull && points.length > 2) {
    points[points.length - 1] = [points[0][0], points[0][1]];
  }
  return { points, closed: isFull };
}
/** Cierra un anillo repitiendo el primer punto. */
function closeRing(points) {
  if (points.length < 2) return points;
  const first = points[0];
  const last = points[points.length - 1];
  if (Math.hypot(first[0] - last[0], first[1] - last[1]) > 1e-9) points.push([first[0], first[1]]);
  return points;
}

/** Aplica una transformación afín a una lista de puntos. */
function transformPoints(points, transform) {
  return points.map(([x, y]) => transform(x, y));
}

/** Compone la transformación de un INSERT (base -> escala -> giro -> posición). */
function makeInsertTransform(insert, base) {
  const sx = Number.isFinite(insert.xScale) && insert.xScale !== 0 ? insert.xScale : 1;
  const sy = Number.isFinite(insert.yScale) && insert.yScale !== 0 ? insert.yScale : 1;
  const rotation = ((Number.isFinite(insert.rotation) ? insert.rotation : 0) * Math.PI) / 180;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const pos = insert.position || { x: 0, y: 0 };
  const baseX = base ? base.x : 0;
  const baseY = base ? base.y : 0;

  return (x, y) => {
    const lx = (x - baseX) * sx;
    const ly = (y - baseY) * sy;
    return [
      lx * cos - ly * sin + (pos.x || 0),
      lx * sin + ly * cos + (pos.y || 0),
    ];
  };
}

/**
 * Cargador de archivos DXF.
 */
class DxfLoader {
  constructor() {
    this.filePath = '';
    this.fileName = '';
    this.layers = {};
    this.entities = [];
    this.bounds = {
      minX: 0, maxX: 0, minY: 0, maxY: 0, width: 0, height: 0,
    };
    this.unsupported = {};
  }

  /**
   * Lee un archivo DXF del disco y normaliza sus entidades.
   * @param {string} filePath
   * @returns {boolean} true si se encontraron entidades procesables.
   */
  loadFile(filePath) {
    this.filePath = filePath;
    this.fileName = path.basename(filePath);
    this.unsupported = {};

    const buffer = fs.readFileSync(filePath);
    let text = buffer.toString('utf8');
    if (text.includes('\uFFFD')) text = buffer.toString('latin1');

    const parser = new DxfParser();
    const doc = parser.parseSync(text);
    if (!doc) throw new Error('El archivo DXF está vacío o no se pudo interpretar.');

    this.layers = this._buildLayerTable(doc);
    this.entities = this._collectEntities(doc);

    for (const entity of this.entities) {
      if (this.layers[entity.layer]) this.layers[entity.layer].count += 1;
    }

    this.bounds = this._calculateBounds();
    return this.entities.length > 0;
  }

  /** Construye la tabla de capas con color asignado de la paleta. */
  _buildLayerTable(doc) {
    const layers = {};
    const tableLayers = (doc.tables && doc.tables.layer && doc.tables.layer.layers) || {};
    let colorIndex = 0;

    for (const name of Object.keys(tableLayers)) {
      const info = tableLayers[name] || {};
      layers[name] = {
        name,
        colorHex: LAYER_PALETTE[colorIndex % LAYER_PALETTE.length],
        colorIndex: Number.isFinite(info.colorIndex) ? info.colorIndex : 7,
        visible: info.visible !== false,
        count: 0,
        operation: inferOperation(name),
      };
      colorIndex += 1;
    }
    return layers;
  }

  /** Garantiza que una capa exista aunque no estuviera en la tabla LAYER. */
  _ensureLayer(name) {
    const key = name || '0';
    if (!this.layers[key]) {
      const colorIndex = Object.keys(this.layers).length;
      this.layers[key] = {
        name: key,
        colorHex: LAYER_PALETTE[colorIndex % LAYER_PALETTE.length],
        colorIndex: 7,
        visible: true,
        count: 0,
        operation: inferOperation(key),
      };
    }
    return this.layers[key];
  }

  /** Recorre el ModelSpace expandiendo INSERT y devolviendo entidades normalizadas. */
  _collectEntities(doc) {
    const blocks = doc.blocks || {};
    const entities = [];
    const stack = [];

    const walk = (source, transform, inheritedLayer, depth) => {
      for (const raw of source) {
        if (!raw || raw.visible === false) continue;
        const type = String(raw.type || '').toUpperCase();
        const layerName = raw.layer && raw.layer !== '0' ? raw.layer : inheritedLayer;

        if (type === 'INSERT') {
          const block = blocks[raw.name];
          if (!block || !Array.isArray(block.entities) || depth >= MAX_BLOCK_DEPTH) {
            this._countUnsupported('INSERT');
            continue;
          }
          if (stack.includes(raw.name)) continue; // Ciclo de bloques.
          stack.push(raw.name);

          const base = block.position || { x: 0, y: 0 };
          const outer = transform;
          const insertLayer = layerName || raw.layer || '0';

          const cols = Math.max(1, Math.min(200, raw.columnCount || 1));
          const rows = Math.max(1, Math.min(200, raw.rowCount || 1));
          const colSpacing = raw.columnSpacing || 0;
          const rowSpacing = raw.rowSpacing || 0;

          for (let r = 0; r < rows; r += 1) {
            for (let c = 0; c < cols; c += 1) {
              const shifted = { ...raw };
              shifted.position = {
                x: (raw.position ? raw.position.x : 0) + c * colSpacing,
                y: (raw.position ? raw.position.y : 0) + r * rowSpacing,
              };
              const shiftedTransform = makeInsertTransform(shifted, base);
              const combined = (x, y) => {
                const [tx, ty] = shiftedTransform(x, y);
                return outer ? outer(tx, ty) : [tx, ty];
              };
              walk(block.entities, combined, insertLayer, depth + 1);
            }
          }

          stack.pop();
          continue;
        }

        const primitive = this._normalizeEntity(raw, type);
        if (!primitive) {
          if (type) this._countUnsupported(type);
          continue;
        }

        const layer = layerName || '0';
        this._ensureLayer(layer);
        const color = this.layers[layer].colorHex;

        let points = primitive.points;
        let circleCenter = primitive.circleCenter;
        let circleRadius = primitive.circleRadius;

        if (transform) {
          points = transformPoints(points, transform);
          if (circleCenter) {
            const originalCenter = circleCenter;
            circleCenter = transform(originalCenter[0], originalCenter[1]);
            // El radio se recalcula desde un punto del contorno ya transformado,
            // de modo que una escala o un giro del bloque se reflejen en el taladro.
            if (circleRadius && points.length > 1) {
              circleRadius = Math.hypot(
                points[0][0] - circleCenter[0],
                points[0][1] - circleCenter[1],
              );
            }
          }
        }

        entities.push({
          type: primitive.type,
          layer,
          color,
          points,
          closed: primitive.closed,
          circleCenter,
          circleRadius,
          arcInfo: primitive.arcInfo,
        });
      }
    };

    walk(doc.entities || [], null, '0', 0);
    return entities;
  }

  _countUnsupported(type) {
    this.unsupported[type] = (this.unsupported[type] || 0) + 1;
  }

  /**
   * Convierte una entidad DXF cruda en una primitiva normalizada.
   * @returns {?{type:string, points:Array<[number,number]>, closed:boolean}}
   */
  _normalizeEntity(raw, type) {
    switch (type) {
      case 'LINE': {
        const v = raw.vertices || [];
        if (v.length < 2) return null;
        return {
          type: 'LINE',
          points: [[v[0].x, v[0].y], [v[1].x, v[1].y]],
          closed: false,
        };
      }

      case 'ARC': {
        const center = raw.center || { x: 0, y: 0 };
        const radius = raw.radius;
        if (!Number.isFinite(radius) || radius <= 0) return null;

        let startAngle = raw.startAngle || 0;
        let endAngle = Number.isFinite(raw.endAngle) ? raw.endAngle : startAngle + 2 * Math.PI;
        let sweep = endAngle - startAngle;
        while (sweep <= 0) sweep += 2 * Math.PI;
        while (sweep > 2 * Math.PI) sweep -= 2 * Math.PI;

        const isFull = sweep >= 2 * Math.PI - 1e-6;
        const points = isFull
          ? tessellateArc(center.x, center.y, radius, startAngle, 2 * Math.PI)
          : tessellateArc(center.x, center.y, radius, startAngle, sweep);

        return {
          type: 'ARC',
          // Un arco parcial es una polilínea abierta: no se cierra el anillo.
          points: isFull ? closeRing(points) : points,
          closed: isFull,
          arcInfo: {
            center: [center.x, center.y],
            radius,
            startAngle: (startAngle * 180) / Math.PI,
            endAngle: (endAngle * 180) / Math.PI,
          },
        };
      }

      case 'CIRCLE': {
        const center = raw.center || { x: 0, y: 0 };
        const radius = raw.radius;
        if (!Number.isFinite(radius) || radius <= 0) return null;

        // Resolución compatible con el comportamiento original (24..72 lados).
        const segments = Math.min(72, Math.max(24, Math.round(radius * 4)));
        const points = [];
        for (let i = 0; i <= segments; i += 1) {
          const angle = (2 * Math.PI * i) / segments;
          points.push([center.x + radius * Math.cos(angle), center.y + radius * Math.sin(angle)]);
        }
        // El punto final coincide exactamente con el inicial (cierre limpio).
        if (points.length > 2) points[points.length - 1] = [points[0][0], points[0][1]];

        return {
          type: 'CIRCLE',
          points,
          closed: true,
          circleCenter: [center.x, center.y],
          circleRadius: radius,
        };
      }

      case 'LWPOLYLINE':
      case 'POLYLINE': {
        const vertices = raw.vertices || [];
        if (vertices.length < 2) return null;
        const closed = raw.shape === true;
        const points = tessellatePolyline(vertices, closed);
        if (points.length < 2) return null;
        return { type, points: closeRing(points), closed };
      }

      case 'SPLINE': {
        const points = tessellateSpline(raw);
        if (points.length < 2) return null;
        const closed = raw.closed === true;
        return { type, points: closed ? closeRing(points) : points, closed };
      }

      case 'ELLIPSE': {
        if (!raw.majorAxisEndPoint) return null;
        const { points, closed } = tessellateEllipse(raw);
        if (points.length < 2) return null;
        return { type, points, closed };
      }

      default:
        return null;
    }
  }

  /** Calcula el cuadro delimitador global de las entidades. */
  _calculateBounds() {
    if (!this.entities.length) {
      return {
        minX: 0, maxX: 0, minY: 0, maxY: 0, width: 0, height: 0,
      };
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const entity of this.entities) {
      for (const [x, y] of entity.points) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }

    if (!Number.isFinite(minX)) {
      return {
        minX: 0, maxX: 0, minY: 0, maxY: 0, width: 0, height: 0,
      };
    }

    const round = (value) => Math.round(value * 10000) / 10000;
    return {
      minX: round(minX),
      maxX: round(maxX),
      minY: round(minY),
      maxY: round(maxY),
      width: round(maxX - minX),
      height: round(maxY - minY),
    };
  }

  /** Resumen serializable para la interfaz. */
  toPayload() {
    return {
      fileName: this.fileName,
      filePath: this.filePath,
      bounds: this.bounds,
      entities: this.entities,
      layers: Object.values(this.layers).map((layer) => ({
        name: layer.name,
        colorHex: layer.colorHex,
        count: layer.count,
        operation: layer.operation,
      })),
      unsupported: this.unsupported,
      entityCount: this.entities.length,
    };
  }
}

module.exports = {
  DxfLoader,
  inferOperation,
  FLATTEN_TOLERANCE,
  // Exportado para pruebas unitarias del teselado.
  _internals: {
    tessellatePolyline,
    tessellateSpline,
    tessellateEllipse,
    flattenParametric,
    evaluateNurbs,
    catmullRom,
    makeInsertTransform,
  },
};
