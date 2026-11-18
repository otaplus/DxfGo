'use strict';

/**
 * Generador de archivos DXF mínimos para las pruebas del cargador.
 * Cada función devuelve pares de códigos de grupo como texto DXF válido.
 */

/** Convierte una lista de pares [código, valor] en texto DXF. */
function groups(pairs) {
  return `${pairs.map(([code, value]) => `${code}\n${value}`).join('\n')}\n`;
}

/** Entidad LINE. */
function line(layer, x1, y1, x2, y2) {
  return [[0, 'LINE'], [8, layer], [10, x1], [20, y1], [11, x2], [21, y2]];
}

/** Entidad CIRCLE. */
function circle(layer, cx, cy, radius) {
  return [[0, 'CIRCLE'], [8, layer], [10, cx], [20, cy], [40, radius]];
}

/** Entidad ARC (ángulos en grados). */
function arc(layer, cx, cy, radius, startDeg, endDeg) {
  return [
    [0, 'ARC'], [8, layer], [10, cx], [20, cy], [40, radius],
    [50, startDeg], [51, endDeg],
  ];
}

/**
 * Entidad LWPOLYLINE.
 * @param {string} layer
 * @param {Array<[number, number, number?]>} vertices [x, y, bulge?]
 * @param {boolean} closed
 */
function lwpolyline(layer, vertices, closed = false) {
  const pairs = [
    [0, 'LWPOLYLINE'], [8, layer], [90, vertices.length], [70, closed ? 1 : 0],
  ];
  for (const [x, y, bulge] of vertices) {
    pairs.push([10, x], [20, y]);
    if (bulge) pairs.push([42, bulge]);
  }
  return pairs;
}

/**
 * Entidad POLYLINE con VERTEX (versión antigua, con bulges opcionales).
 * @param {string} layer
 * @param {Array<[number, number, number?]>} vertices
 * @param {boolean} closed
 */
function polyline(layer, vertices, closed = false) {
  const pairs = [
    [0, 'POLYLINE'], [8, layer], [66, 1], [70, closed ? 1 : 0],
  ];
  for (const [x, y, bulge] of vertices) {
    pairs.push([0, 'VERTEX'], [8, layer], [10, x], [20, y]);
    if (bulge) pairs.push([42, bulge]);
  }
  pairs.push([0, 'SEQEND'], [8, layer]);
  return pairs;
}

/**
 * Entidad SPLINE.
 * @param {string} layer
 * @param {Array<[number, number]>} controlPoints
 * @param {number} degree
 * @param {number[]} knots
 * @param {boolean} closed
 */
function spline(layer, controlPoints, degree, knots, closed = false) {
  const pairs = [
    [0, 'SPLINE'], [8, layer], [70, closed ? 1 : 0],
    [71, degree], [72, knots.length], [73, controlPoints.length],
  ];
  for (const knot of knots) pairs.push([40, knot]);
  for (const [x, y] of controlPoints) pairs.push([10, x], [20, y]);
  return pairs;
}

/**
 * Entidad ELLIPSE.
 * @param {string} layer
 * @param {number} cx
 * @param {number} cy
 * @param {number} majorX
 * @param {number} majorY
 * @param {number} ratio
 * @param {number} [startParam]
 * @param {number} [endParam]
 */
function ellipse(layer, cx, cy, majorX, majorY, ratio, startParam = 0, endParam = Math.PI * 2) {
  return [
    [0, 'ELLIPSE'], [8, layer], [10, cx], [20, cy],
    [11, majorX], [21, majorY], [40, ratio], [41, startParam], [42, endParam],
  ];
}

/** Entidad INSERT. */
function insert(layer, blockName, x, y, rotationDeg = 0, xScale = 1, yScale = 1) {
  return [
    [0, 'INSERT'], [8, layer], [2, blockName], [10, x], [20, y],
    [41, xScale], [42, yScale], [50, rotationDeg],
  ];
}

/** Definición de bloque. */
function block(name, baseX, baseY, entities) {
  const pairs = [[0, 'BLOCK'], [8, '0'], [2, name], [70, 0], [10, baseX], [20, baseY]];
  const body = [].concat(...entities);
  return pairs.concat(body, [[0, 'ENDBLK'], [8, '0']]);
}

/**
 * Compone un DXF completo.
 * @param {Array} entities Entidades del ModelSpace (listas de pares).
 * @param {Array} [blocks] Definiciones de bloque.
 * @param {string[]} [layers] Nombres de capa a declarar en la tabla LAYER.
 */
function buildDxf(entities, blocks = [], layers = []) {
  const layerNames = new Set(layers);
  for (const entity of entities) {
    for (const [code, value] of entity) {
      if (code === 8 && value !== '0') layerNames.add(value);
    }
  }

  const layerTable = [];
  if (layerNames.size) {
    layerTable.push([0, 'TABLE'], [2, 'LAYER'], [70, layerNames.size]);
    let index = 1;
    for (const name of layerNames) {
      layerTable.push([0, 'LAYER'], [2, name], [70, 0], [62, index]);
      index += 1;
    }
    layerTable.push([0, 'ENDTAB']);
  }

  const sections = [];

  sections.push(groups([[0, 'SECTION'], [2, 'HEADER'], [9, '$ACADVER'], [1, 'AC1015'], [0, 'ENDSEC']]));

  if (layerTable.length) {
    sections.push(groups([[0, 'SECTION'], [2, 'TABLES']].concat(layerTable, [[0, 'ENDSEC']])));
  }

  if (blocks.length) {
    sections.push(groups([[0, 'SECTION'], [2, 'BLOCKS']].concat(...blocks, [[0, 'ENDSEC']])));
  }

  const modelSpace = [].concat(...entities);
  sections.push(groups([[0, 'SECTION'], [2, 'ENTITIES']].concat(modelSpace, [[0, 'ENDSEC']])));

  sections.push(groups([[0, 'EOF']]));

  return sections.join('');
}

module.exports = {
  groups,
  line,
  circle,
  arc,
  lwpolyline,
  polyline,
  spline,
  ellipse,
  insert,
  block,
  buildDxf,
};
