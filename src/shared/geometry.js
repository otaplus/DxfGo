'use strict';

/**
 * Motor geométrico: encadenado de perfiles, jerarquía de anidado (Inside-First),
 * compensación de radio de fresa, cajeado y pestañas de sujeción.
 *
 * Es una traducción de cad_cam_core/geometry.py sustituyendo shapely por Clipper.
 */

const {
  ringArea, offsetRings, polygonContains, signedArea,
} = require('./polygon-ops');

/** Distancia por debajo de la cual dos extremos se consideran unidos (mm). */
const CLOSE_TOLERANCE = 0.005;

/**
 * Contorno 2D: secuencia de puntos más su información topológica.
 */
class Contour2D {
  /**
   * @param {Array<[number, number]>} points
   * @param {boolean} [isClosed]
   * @param {string} [layer]
   * @param {string} [entityType]
   */
  constructor(points, isClosed = false, layer = '0', entityType = '') {
    this.points = points.map((p) => [p[0], p[1]]);
    this.isClosed = isClosed;
    this.layer = layer;
    this.entityType = entityType;

    this.nestingLevel = 0; // 0 = exterior, 1+ = interior
    this.area = 0;
    this.hasPolygon = false;
    this.isCcw = true;

    this.circleCenter = null;
    this.circleRadius = null;

    this._analyze();
  }

  /** Normaliza cierre y calcula área/orientación cuando es un anillo válido. */
  _analyze() {
    if (this.points.length < 2) return;

    const start = this.points[0];
    const end = this.points[this.points.length - 1];
    const distance = Math.hypot(start[0] - end[0], start[1] - end[1]);

    if (distance < CLOSE_TOLERANCE) {
      this.isClosed = true;
      if (start[0] !== end[0] || start[1] !== end[1]) this.points.push([start[0], start[1]]);
    }

    if (this.isClosed && this.points.length >= 4) {
      const area = ringArea(this.points);
      if (area > 1e-9) {
        this.hasPolygon = true;
        this.area = area;
        this.isCcw = Contour2D.checkCcw(this.points);
      }
    }
  }

  /** Orientación por suma de áreas con signo (true si antihorario). */
  static checkCcw(points) {
    let total = 0;
    for (let i = 0; i < points.length - 1; i += 1) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[i + 1];
      total += (x2 - x1) * (y2 + y1);
    }
    return total < 0;
  }

  /** Longitud del perímetro o de la polilínea. */
  totalLength() {
    let length = 0;
    for (let i = 0; i < this.points.length - 1; i += 1) {
      const [x1, y1] = this.points[i];
      const [x2, y2] = this.points[i + 1];
      length += Math.hypot(x2 - x1, y2 - y1);
    }
    return length;
  }

  /** Invierte el sentido del contorno. */
  reverse() {
    this.points.reverse();
    this.isCcw = !this.isCcw;
  }

  /** Fuerza la orientación (solo contornos cerrados). */
  setOrientation(ccw) {
    if (this.isClosed && this.isCcw !== ccw) this.reverse();
  }
}

/**
 * Procesador geométrico: encadenado, anidado, orden seguro y compensaciones.
 */
class GeometryProcessor {
  constructor(tolerance = 0.01) {
    this.tolerance = tolerance;
  }

  /**
   * Une entidades sueltas cuyos extremos coinciden dentro de la tolerancia.
   * @param {Array<object>} rawEntities
   * @returns {Contour2D[]}
   */
  chainEntities(rawEntities) {
    const contours = [];
    const remaining = [];

    for (const entity of rawEntities) {
      if (entity.type === 'CIRCLE') {
        const contour = new Contour2D(entity.points, true, entity.layer, 'CIRCLE');
        if (entity.circleCenter) {
          contour.circleCenter = entity.circleCenter;
          contour.circleRadius = entity.circleRadius;
        }
        contours.push(contour);
      } else if (entity.closed && entity.points.length >= 3) {
        contours.push(new Contour2D(entity.points, true, entity.layer, entity.type));
      } else {
        remaining.push(entity);
      }
    }

    while (remaining.length) {
      const current = remaining.shift();
      let chainPoints = current.points.map((p) => [p[0], p[1]]);
      const chainLayer = current.layer;
      const chainType = current.type;

      let expanded = true;
      while (expanded) {
        expanded = false;
        const end = chainPoints[chainPoints.length - 1];
        const start = chainPoints[0];

        // ¿La cadena ya cerró sobre sí misma?
        if (chainPoints.length > 2
          && Math.hypot(start[0] - end[0], start[1] - end[1]) <= this.tolerance) {
          chainPoints[chainPoints.length - 1] = [chainPoints[0][0], chainPoints[0][1]];
          break;
        }

        for (let i = 0; i < remaining.length; i += 1) {
          const other = remaining[i];
          const oStart = other.points[0];
          const oEnd = other.points[other.points.length - 1];
          const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

          if (d(end, oStart) <= this.tolerance) {
            chainPoints = chainPoints.concat(other.points.slice(1).map((p) => [p[0], p[1]]));
            remaining.splice(i, 1);
            expanded = true;
            break;
          }
          if (d(end, oEnd) <= this.tolerance) {
            const reversed = other.points.slice().reverse().map((p) => [p[0], p[1]]);
            chainPoints = chainPoints.concat(reversed.slice(1));
            remaining.splice(i, 1);
            expanded = true;
            break;
          }
          if (d(start, oEnd) <= this.tolerance) {
            const head = other.points.slice(0, -1).map((p) => [p[0], p[1]]);
            chainPoints = head.concat(chainPoints);
            remaining.splice(i, 1);
            expanded = true;
            break;
          }
          if (d(start, oStart) <= this.tolerance) {
            const reversed = other.points.slice().reverse().map((p) => [p[0], p[1]]);
            chainPoints = reversed.slice(0, -1).concat(chainPoints);
            remaining.splice(i, 1);
            expanded = true;
            break;
          }
        }
      }

      let isClosed = false;
      if (chainPoints.length > 2) {
        const first = chainPoints[0];
        const last = chainPoints[chainPoints.length - 1];
        if (Math.hypot(first[0] - last[0], first[1] - last[1]) <= this.tolerance) {
          isClosed = true;
          chainPoints[chainPoints.length - 1] = [first[0], first[1]];
        }
      }

      contours.push(new Contour2D(chainPoints, isClosed, chainLayer, chainType));
    }

    return contours;
  }

  /**
   * Calcula el nivel de anidado de cada contorno cerrado.
   * Nivel 0 = exterior (se corta al final); nivel 1+ = interior (se corta primero).
   * @param {Contour2D[]} contours
   */
  analyzeNestingHierarchy(contours) {
    const closed = contours.filter((c) => c.isClosed && c.hasPolygon);

    for (const c1 of closed) {
      let level = 0;
      for (const c2 of closed) {
        if (c1 === c2) continue;
        if (polygonContains(c2.points, c1.points)) level += 1;
      }
      c1.nestingLevel = level;
    }

    return contours;
  }

  /**
   * Ordena los contornos con prioridad de seguridad:
   * interiores primero y, dentro de cada nivel, recorrido voraz por cercanía.
   * @param {Contour2D[]} contours
   * @param {[number, number]} [startPos]
   */
  sortContoursSafely(contours, startPos = [0.0, 0.0]) {
    const levels = new Map();
    const openContours = [];

    for (const contour of contours) {
      if (!contour.isClosed) {
        openContours.push(contour);
      } else {
        const level = contour.nestingLevel;
        if (!levels.has(level)) levels.set(level, []);
        levels.get(level).push(contour);
      }
    }

    const ordered = [];
    let currentPos = [startPos[0], startPos[1]];

    // Los contornos abiertos (grabados, ranuras) van primero.
    if (openContours.length) {
      const pending = openContours.slice();
      while (pending.length) {
        let bestIndex = 0;
        let bestDistance = Infinity;
        let bestReverse = false;

        for (let i = 0; i < pending.length; i += 1) {
          const c = pending[i];
          const first = c.points[0];
          const last = c.points[c.points.length - 1];
          const dStart = Math.hypot(first[0] - currentPos[0], first[1] - currentPos[1]);
          const dEnd = Math.hypot(last[0] - currentPos[0], last[1] - currentPos[1]);
          if (dStart < bestDistance) {
            bestDistance = dStart;
            bestIndex = i;
            bestReverse = false;
          }
          if (dEnd < bestDistance) {
            bestDistance = dEnd;
            bestIndex = i;
            bestReverse = true;
          }
        }

        const chosen = pending.splice(bestIndex, 1)[0];
        if (bestReverse) chosen.reverse();
        ordered.push(chosen);
        currentPos = chosen.points[chosen.points.length - 1];
      }
    }

    // Después, niveles cerrados de mayor a menor (interiores primero).
    const sortedLevels = Array.from(levels.keys()).sort((a, b) => b - a);
    for (const level of sortedLevels) {
      const group = levels.get(level).slice();
      while (group.length) {
        let bestIndex = 0;
        let bestDistance = Infinity;
        for (let i = 0; i < group.length; i += 1) {
          const p = group[i].points[0];
          const distance = Math.hypot(p[0] - currentPos[0], p[1] - currentPos[1]);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = i;
          }
        }
        const chosen = group.splice(bestIndex, 1)[0];
        ordered.push(chosen);
        currentPos = chosen.points[chosen.points.length - 1];
      }
    }

    return ordered;
  }

  /**
   * Compensación de radio de herramienta según la operación de la capa.
   * @param {Contour2D} contour
   * @param {number} toolDiameter
   * @param {string} operation
   * @returns {Array<Array<[number, number]>>}
   */
  computeOffset(contour, toolDiameter, operation) {
    const radius = toolDiameter / 2.0;

    if (operation === 'SOBRE_LINEA' || radius <= 0.001 || !contour.isClosed) {
      return [contour.points];
    }
    if (!contour.hasPolygon) {
      return [contour.points];
    }

    if (operation === 'PERFIL_EXTERIOR') {
      // Un agujero interior con perfil exterior se compensa hacia dentro.
      const effective = contour.nestingLevel === 0 ? radius : -radius;
      const rings = offsetRings([contour.points], effective);
      return rings.length ? rings : [];
    }

    if (operation === 'PERFIL_INTERIOR') {
      const effective = contour.nestingLevel === 0 ? -radius : radius;
      const rings = offsetRings([contour.points], effective);
      return rings.length ? rings : [];
    }

    if (operation === 'CAJEADO') {
      const stepover = toolDiameter * 0.55;
      const paths = [];
      let current = offsetRings([contour.points], -radius);
      let guard = 0;

      while (current.length && guard < 5000) {
        const totalArea = current.reduce((sum, ring) => sum + ringArea(ring), 0);
        if (totalArea <= 0.05) break;
        for (const ring of current) paths.push(ring);

        const next = [];
        for (const ring of current) {
          if (ringArea(ring) <= 0.05) continue;
          next.push(...offsetRings([ring], -stepover));
        }
        current = next;
        guard += 1;
      }

      return paths.length ? paths : [contour.points];
    }

    return [contour.points];
  }

  /**
   * Calcula las zonas de pestañas a lo largo del perímetro.
   * @returns {Array<[number, number]>} Intervalos de distancia recorrida.
   */
  generateTabs(points, numTabs, tabWidth) {
    if (numTabs <= 0 || tabWidth <= 0) return [];
    if (points.length < 2) return [];

    const cumulative = [0];
    for (let i = 0; i < points.length - 1; i += 1) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[i + 1];
      cumulative.push(cumulative[cumulative.length - 1] + Math.hypot(x2 - x1, y2 - y1));
    }

    const totalLength = cumulative[cumulative.length - 1];
    if (totalLength < tabWidth * numTabs * 2) return [];

    const spacing = totalLength / numTabs;
    const intervals = [];
    for (let i = 0; i < numTabs; i += 1) {
      const center = (i + 0.5) * spacing;
      const start = Math.max(0, center - tabWidth / 2);
      const end = Math.min(totalLength, center + tabWidth / 2);
      intervals.push([start, end]);
    }
    return intervals;
  }
}

module.exports = {
  Contour2D,
  GeometryProcessor,
  CLOSE_TOLERANCE,
  _internals: { signedArea },
};
