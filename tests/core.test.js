'use strict';

/**
 * Pruebas del núcleo CAD/CAM: cargador DXF, geometría, offsets, motor CAM,
 * postprocesadores y verificador de seguridad.
 */

const fs = require('fs');
const path = require('path');

const {
  test, approx, ok, includes, excludes,
} = require('./harness');
const builder = require('./fixtures/dxf-builder');

const { DxfLoader, inferOperation } = require('../src/shared/dxf-loader');
const { GeometryProcessor, Contour2D } = require('../src/shared/geometry');
const { CAMEngine, CAMParameters } = require('../src/shared/cam-engine');
const { PostProcessor } = require('../src/shared/postprocessor');
const { SafetyChecker } = require('../src/shared/safety-check');
const { ringArea } = require('../src/shared/polygon-ops');

const PROJECT_ROOT = path.join(__dirname, '..');
const TMP_DIR = path.join(PROJECT_ROOT, '.cache', 'test-tmp');
const EXAMPLE_DXF = path.join(PROJECT_ROOT, 'examples', 'ejemplo_pieza.dxf');

let fileCounter = 0;

/** Escribe un DXF temporal y lo carga. */
function loadFromText(text) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const file = path.join(TMP_DIR, `fixture-${fileCounter}.dxf`);
  fileCounter += 1;
  fs.writeFileSync(file, text, 'utf8');
  const loader = new DxfLoader();
  const okLoad = loader.loadFile(file);
  return { loader, okLoad };
}

/** Carga el DXF de ejemplo incluido. */
function loadExample() {
  const loader = new DxfLoader();
  loader.loadFile(EXAMPLE_DXF);
  return loader;
}

/** Configuraciones de capa a partir de las operaciones inferidas. */
function autoLayerConfigs(loader) {
  const configs = {};
  for (const [name, layer] of Object.entries(loader.layers)) {
    if (layer.count > 0) {
      configs[name] = { visible: true, operation: inferOperation(name) };
    }
  }
  return configs;
}

/**
 * Recorre el código G comprobando las invariantes de seguridad.
 * @returns {{minZ:number, g0AtLowZ:number, maxZ:number}}
 */
function inspectSafety(gcode, safeZ) {
  let x = 0;
  let y = 0;
  let z = safeZ;
  let minZ = safeZ;
  let maxZ = safeZ;
  let g0AtLowZ = 0;

  for (const raw of gcode.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    const upper = line.toUpperCase();

    const xm = upper.match(/X(-?[\d.]+)/);
    const ym = upper.match(/Y(-?[\d.]+)/);
    const zm = upper.match(/Z(-?[\d.]+)/);
    const nx = xm ? parseFloat(xm[1]) : x;
    const ny = ym ? parseFloat(ym[1]) : y;
    const nz = zm ? parseFloat(zm[1]) : z;

    const isG0 = upper.startsWith('G0') || upper.startsWith('G00');
    if (isG0) {
      const moved = Math.abs(nx - x) > 1e-3 || Math.abs(ny - y) > 1e-3;
      if (moved && z < safeZ - 0.01) g0AtLowZ += 1;
    }

    x = nx; y = ny; z = nz;
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }

  return { minZ, g0AtLowZ, maxZ };
}

/** G-code de ejemplo con parámetros por defecto. */
function exampleGcode(overrides = {}, layerOverrides = {}) {
  const loader = loadExample();
  const params = new CAMParameters({ tabsEnabled: false, ...overrides });
  const configs = { ...autoLayerConfigs(loader), ...layerOverrides };
  const engine = new CAMEngine(params);
  const gcode = engine.generateGcode(loader.entities, loader.bounds, configs);
  return {
    loader, params, engine, gcode, configs,
  };
}

// ---------------------------------------------------------------------------
// Cargador DXF
// ---------------------------------------------------------------------------

test('DXF de ejemplo: entidades, capas y dimensiones', () => {
  const loader = loadExample();
  ok(loader.entities.length === 8, `se esperaban 8 entidades, hay ${loader.entities.length}`);
  approx(loader.bounds.width, 120, 1e-6, 'ancho');
  approx(loader.bounds.height, 80, 1e-6, 'alto');
  approx(loader.bounds.minX, 0, 1e-6, 'minX');
  approx(loader.bounds.maxY, 80, 1e-6, 'maxY');

  const layers = Object.values(loader.layers).filter((layer) => layer.count > 0);
  ok(layers.length === 3, `se esperaban 3 capas con entidades, hay ${layers.length}`);
  ok(loader.unsupported && Object.keys(loader.unsupported).length === 0, 'no debería haber entidades no soportadas');
});

test('Círculo: se tesela cerrado con centro y radio', () => {
  const dxf = builder.buildDxf([builder.circle('CAPA', 5, 5, 10)]);
  const { loader } = loadFromText(dxf);
  ok(loader.entities.length === 1, 'debería haber una entidad');
  const entity = loader.entities[0];
  ok(entity.closed, 'el círculo debe ser cerrado');
  ok(entity.circleRadius === 10, 'radio incorrecto');
  const first = entity.points[0];
  const last = entity.points[entity.points.length - 1];
  ok(first[0] === last[0] && first[1] === last[1], 'el anillo debe cerrarse');
  for (const [px, py] of entity.points) {
    approx(Math.hypot(px - 5, py - 5), 10, 1e-6, 'punto sobre el círculo');
  }
});

test('Arco: respeta ángulos y radio', () => {
  const dxf = builder.buildDxf([builder.arc('CAPA', 0, 0, 10, 0, 90)]);
  const { loader } = loadFromText(dxf);
  const entity = loader.entities[0];
  const first = entity.points[0];
  const last = entity.points[entity.points.length - 1];
  approx(first[0], 10, 1e-6);
  approx(first[1], 0, 1e-6);
  approx(last[0], 0, 1e-6);
  approx(last[1], 10, 1e-6);
  ok(!entity.closed, 'un cuarto de arco no es cerrado');
  for (const [px, py] of entity.points) approx(Math.hypot(px, py), 10, 1e-6);
});

test('Polilínea con bulge: genera el arco correcto', () => {
  // Bulge 1 = semicírculo antihorario de (0,0) a (4,0) con centro (2,0).
  const dxf = builder.buildDxf([builder.lwpolyline('CAPA', [[0, 0, 1], [4, 0]], false)]);
  const { loader } = loadFromText(dxf);
  const points = loader.entities[0].points;

  const hasBottom = points.some(([, py]) => Math.abs(py + 2) < 0.02);
  ok(hasBottom, 'el semicírculo debe pasar por (2, -2)');
  const maxDistance = Math.max(...points.map(([px, py]) => Math.abs(Math.hypot(px - 2, py) - 2)));
  ok(maxDistance < 0.03, `los puntos deben estar sobre el arco (error ${maxDistance})`);
});

test('POLYLINE clásica con bulge se interpreta igual', () => {
  const dxf = builder.buildDxf([builder.polyline('CAPA', [[0, 0], [10, 0], [10, 10]], true)]);
  const { loader } = loadFromText(dxf);
  const entity = loader.entities[0];
  ok(entity.closed, 'la polilínea debe ser cerrada');
  ok(entity.points.length === 4, `se esperaban 4 puntos, hay ${entity.points.length}`);
});

test('Spline cuadrática: extremos y punto medio', () => {
  const dxf = builder.buildDxf([
    builder.spline('CAPA', [[0, 0], [5, 10], [10, 0]], 2, [0, 0, 0, 1, 1, 1]),
  ]);
  const { loader } = loadFromText(dxf);
  const points = loader.entities[0].points;
  const first = points[0];
  const last = points[points.length - 1];
  approx(first[0], 0, 1e-6); approx(first[1], 0, 1e-6);
  approx(last[0], 10, 1e-6); approx(last[1], 0, 1e-6);

  // La curva de Bézier cuadrática pasa por (5,5) en t = 0,5.
  const middle = points.reduce((best, p) => (
    Math.hypot(p[0] - 5, p[1] - 5) < Math.hypot(best[0] - 5, best[1] - 5) ? p : best
  ), points[0]);
  approx(middle[0], 5, 0.05);
  approx(middle[1], 5, 0.05);
});

test('Elipse: semiejes y cierre', () => {
  const dxf = builder.buildDxf([builder.ellipse('CAPA', 0, 0, 10, 0, 0.5)]);
  const { loader } = loadFromText(dxf);
  const entity = loader.entities[0];
  ok(entity.closed, 'la elipse completa debe ser cerrada');
  approx(loader.bounds.width, 20, 0.02);
  approx(loader.bounds.height, 10, 0.02);

  const hasRight = entity.points.some(([px, py]) => Math.abs(px - 10) < 0.02 && Math.abs(py) < 0.02);
  const hasTop = entity.points.some(([px, py]) => Math.abs(px) < 0.02 && Math.abs(py - 5) < 0.02);
  ok(hasRight, 'debe pasar por (10, 0)');
  ok(hasTop, 'debe pasar por (0, 5)');
});

test('INSERT: aplica giro, escala y punto base', () => {
  const blockLine = builder.line('0', 0, 0, 10, 0);
  const dxf = builder.buildDxf(
    [builder.insert('CAPA', 'BLOQUE', 5, 5, 90)],
    [builder.block('BLOQUE', 0, 0, [blockLine])],
  );
  const { loader } = loadFromText(dxf);
  ok(loader.entities.length === 1, 'el INSERT debe expandirse a una línea');
  const [start, end] = loader.entities[0].points;
  approx(start[0], 5, 1e-6); approx(start[1], 5, 1e-6);
  approx(end[0], 5, 1e-6); approx(end[1], 15, 1e-6);
});

test('INSERT escalado: el círculo conserva un radio coherente', () => {
  const dxf = builder.buildDxf(
    [builder.insert('CORTE', 'H', 0, 0, 0, 2, 2)],
    [builder.block('H', 0, 0, [builder.circle('0', 0, 0, 5)])],
  );
  const { loader } = loadFromText(dxf);
  const entity = loader.entities[0];
  approx(entity.circleRadius, 10, 1e-6, 'radio escalado x2');
  approx(loader.bounds.width, 20, 0.05, 'ancho escalado');
});

test('El bloque hereda la capa del INSERT cuando la entidad está en la capa 0', () => {
  const dxf = builder.buildDxf(
    [builder.insert('CORTE', 'B', 0, 0, 0)],
    [builder.block('B', 0, 0, [builder.line('0', 0, 0, 5, 0)])],
  );
  const { loader } = loadFromText(dxf);
  ok(loader.entities[0].layer === 'CORTE', `capa inesperada: ${loader.entities[0].layer}`);
});

test('Entidades no soportadas se contabilizan sin romper la carga', () => {
  const text = builder.buildDxf([
    builder.line('CAPA', 0, 0, 10, 0),
    [[0, 'TEXT'], [8, 'CAPA'], [10, 1], [20, 1], [40, 2.5], [1, 'HOLA']],
  ]);
  const { loader } = loadFromText(text);
  ok(loader.entities.length === 1, 'debería quedar solo la línea');
  ok(loader.unsupported.TEXT === 1, 'debería contabilizar un TEXT');
});

// ---------------------------------------------------------------------------
// Geometría
// ---------------------------------------------------------------------------

test('Encadenado: une líneas consecutivas en un contorno abierto', () => {
  const gp = new GeometryProcessor();
  const entities = [
    { type: 'LINE', layer: 'C', points: [[0, 0], [10, 0]], closed: false },
    { type: 'LINE', layer: 'C', points: [[10, 0], [10, 10]], closed: false },
  ];
  const contours = gp.chainEntities(entities);
  ok(contours.length === 1, `se esperaba un contorno, hay ${contours.length}`);
  ok(contours[0].points.length === 3, `se esperaban 3 puntos, hay ${contours[0].points.length}`);
  ok(!contours[0].isClosed, 'el contorno debe quedar abierto');
});

test('Encadenado: cierra un contorno cuando los extremos coinciden', () => {
  const gp = new GeometryProcessor();
  const entities = [
    { type: 'LINE', layer: 'C', points: [[0, 0], [10, 0]], closed: false },
    { type: 'LINE', layer: 'C', points: [[10, 0], [10, 10]], closed: false },
    { type: 'LINE', layer: 'C', points: [[10, 10], [0, 0]], closed: false },
  ];
  const contours = gp.chainEntities(entities);
  ok(contours.length === 1, 'debe ser un único contorno');
  ok(contours[0].isClosed, 'el contorno debe cerrarse');
  ok(contours[0].hasPolygon, 'debe tener polígono válido');
  approx(contours[0].area, 50, 1e-6, 'área del triángulo');
});

test('Jerarquía de anidado: agujero dentro de contorno exterior', () => {
  const gp = new GeometryProcessor();
  const square = (size) => new Contour2D(
    [[0, 0], [size, 0], [size, size], [0, size], [0, 0]], true, 'C', 'LWPOLYLINE',
  );
  const outer = square(100);
  const inner = new Contour2D(
    [[40, 40], [60, 40], [60, 60], [40, 60], [40, 40]], true, 'C', 'LWPOLYLINE',
  );
  const contours = gp.analyzeNestingHierarchy([outer, inner]);
  ok(outer.nestingLevel === 0, `el exterior debe ser nivel 0, es ${outer.nestingLevel}`);
  ok(inner.nestingLevel === 1, `el interior debe ser nivel 1, es ${inner.nestingLevel}`);
  ok(contours.length === 2, 'deben devolverse los dos contornos');
});

test('Orden seguro: interiores antes que el exterior', () => {
  const gp = new GeometryProcessor();
  const outer = new Contour2D(
    [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]], true, 'C', 'LWPOLYLINE',
  );
  const hole = new Contour2D(
    [[40, 40], [60, 40], [60, 60], [40, 60], [40, 40]], true, 'C', 'LWPOLYLINE',
  );
  gp.analyzeNestingHierarchy([outer, hole]);
  const ordered = gp.sortContoursSafely([outer, hole], [0, 0]);
  ok(ordered[0] === hole, 'el agujero debe mecanizarse primero');
  ok(ordered[1] === outer, 'el contorno exterior debe ir al final');
});

test('Compensación exterior: área mayor que la pieza', () => {
  const gp = new GeometryProcessor();
  const contour = new Contour2D(
    [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], true, 'C', 'LWPOLYLINE',
  );
  const paths = gp.computeOffset(contour, 2, 'PERFIL_EXTERIOR');
  ok(paths.length === 1, `se esperaba un camino, hay ${paths.length}`);
  const area = ringArea(paths[0]);
  // Cuadrado 10x10 crecido 1 mm con esquinas redondeadas: 144 - (4 - π) ≈ 143,14
  approx(area, 143.14, 0.3, 'área compensada exterior');
});

test('Compensación interior: área menor que la pieza', () => {
  const gp = new GeometryProcessor();
  const contour = new Contour2D(
    [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], true, 'C', 'LWPOLYLINE',
  );
  const paths = gp.computeOffset(contour, 2, 'PERFIL_INTERIOR');
  ok(paths.length === 1, `se esperaba un camino, hay ${paths.length}`);
  approx(ringArea(paths[0]), 64, 0.3, 'área compensada interior');
});

test('Sobre línea: no aplica compensación', () => {
  const gp = new GeometryProcessor();
  const contour = new Contour2D(
    [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], true, 'C', 'LWPOLYLINE',
  );
  const paths = gp.computeOffset(contour, 2, 'SOBRE_LINEA');
  ok(paths.length === 1, 'debe devolver el contorno original');
  ok(paths[0].length === contour.points.length, 'no debe modificarse');
});

test('Cajeado: pasadas concéntricas decrecientes', () => {
  const gp = new GeometryProcessor();
  const contour = new Contour2D(
    [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]], true, 'C', 'LWPOLYLINE',
  );
  const paths = gp.computeOffset(contour, 4, 'CAJEADO');
  ok(paths.length >= 2, `se esperaban varias pasadas, hay ${paths.length}`);

  const areas = paths.map((p) => ringArea(p));
  for (let i = 1; i < areas.length; i += 1) {
    ok(areas[i] <= areas[i - 1] + 1e-6, 'las pasadas deben reducir su área');
  }
  ok(areas[0] < 400, 'la primera pasada debe estar dentro del contorno');
});

test('Pestañas: cantidad e intervalos dentro del perímetro', () => {
  const gp = new GeometryProcessor();
  const points = [[0, 0], [100, 0], [100, 50], [0, 50], [0, 0]];
  const intervals = gp.generateTabs(points, 4, 5);
  ok(intervals.length === 4, `se esperaban 4 pestañas, hay ${intervals.length}`);

  const perimeter = 300;
  for (const [start, end] of intervals) {
    ok(start >= 0 && end <= perimeter + 1e-6, 'los intervalos deben estar dentro del perímetro');
    ok(end - start <= 5 + 1e-6, 'el ancho no debe superar el configurado');
  }
});

test('Pestañas: no se generan si el perímetro es demasiado corto', () => {
  const gp = new GeometryProcessor();
  const points = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
  ok(gp.generateTabs(points, 10, 2).length === 0, 'no debería generar pestañas');
});

// ---------------------------------------------------------------------------
// Motor CAM
// ---------------------------------------------------------------------------

test('Generación: invariantes de seguridad y profundidad', () => {
  const { gcode, params } = exampleGcode();
  const inspection = inspectSafety(gcode, params.safeZ);
  ok(inspection.g0AtLowZ === 0, `hay ${inspection.g0AtLowZ} traslados G0 por debajo de Z seguro`);
  approx(inspection.minZ, params.targetDepth, 1e-6, 'profundidad mínima');
  approx(inspection.maxZ, params.safeZ, 1e-6, 'altura máxima');

  const safety = SafetyChecker.verifyGcode(gcode, params.safeZ, params.targetDepth, params.plungeFeed);
  ok(safety.status === 'SEGURO', `estado de seguridad inesperado: ${safety.status}`);
});

test('Generación: interiores antes que el exterior', () => {
  const { gcode } = exampleGcode();
  const indexInterior = gcode.indexOf("Capa: 'AGUJEROS'");
  const indexExterior = gcode.indexOf("Capa: 'CONTORNO_EXTERIOR'");
  ok(indexInterior > 0 && indexExterior > 0, 'deben aparecer ambas capas');
  ok(indexInterior < indexExterior, 'los agujeros deben cortarse antes que el contorno exterior');
});

test('Generación: pestañas de sujeción en la última pasada', () => {
  const { gcode, params } = exampleGcode({ tabsEnabled: true, tabCount: 4, tabWidth: 4, tabHeight: 1.2 });
  includes(gcode, 'Pestaña (Tab)', 'debería incluir zonas de pestaña');

  const threshold = params.targetDepth + params.tabHeight;
  const tabLines = gcode.split('\n').filter((line) => line.includes('Pestaña (Tab)'));
  for (const line of tabLines) {
    const match = line.match(/Z(-?[\d.]+)/);
    ok(match, 'la línea de pestaña debe indicar Z');
    approx(parseFloat(match[1]), threshold, 0.001, 'altura de pestaña');
  }

  // Las pestañas solo aparecen después de bajar de la altura umbral.
  ok(gcode.indexOf('Pestaña (Tab)') > gcode.indexOf('; Pasada 2/2'), 'solo en la última pasada');
});

test('Generación: sin pestañas cuando están desactivadas', () => {
  const { gcode } = exampleGcode({ tabsEnabled: false });
  excludes(gcode, 'Pestaña (Tab)');
});

test('Generación: taladrado usa el centro del círculo', () => {
  const dxf = builder.buildDxf([builder.circle('TALADROS', 25, 35, 3)]);
  const { loader } = loadFromText(dxf);
  const params = new CAMParameters({ tabsEnabled: false });
  const engine = new CAMEngine(params);

  const gcode = engine.generateGcode(loader.entities, loader.bounds, {
    TALADROS: { visible: true, operation: 'TALADRADO' },
  });

  includes(gcode, 'G0 X3.000 Y3.000', 'el taladro se posiciona en el centro del círculo');
  includes(gcode, 'G1 Z-1.500 F250.0');
  includes(gcode, 'G1 Z-3.000 F250.0');
  includes(gcode, 'G0 Z1.500');
});

test('Generación: modo láser enciende y apaga la antorcha', () => {
  const { gcode } = exampleGcode({ postProfile: 'Láser / Plasma 2D' });
  includes(gcode, 'M3 S1000', 'debe encender el láser con la potencia configurada');
  includes(gcode, 'M5 ; Apagar antorcha / láser');
  excludes(gcode, 'Penetración controlada');
});

test('Generación: el filtrado de capas ocultas cambia el programa', () => {
  const loader = loadExample();
  const configs = autoLayerConfigs(loader);
  configs.AGUJEROS.visible = false;
  const params = new CAMParameters({ tabsEnabled: false });
  const engine = new CAMEngine(params);
  const gcode = engine.generateGcode(loader.entities, loader.bounds, configs);

  excludes(gcode, "Capa: 'AGUJEROS'");
  includes(gcode, "Capa: 'CONTORNO_EXTERIOR'");
});

test('Generación: sin entidades activas devuelve un aviso', () => {
  const loader = loadExample();
  const configs = autoLayerConfigs(loader);
  for (const key of Object.keys(configs)) configs[key].visible = false;
  const engine = new CAMEngine(new CAMParameters());
  const gcode = engine.generateGcode(loader.entities, loader.bounds, configs);
  includes(gcode, 'No hay entidades activas');
});

test('Estadísticas: distancias y tiempo coherentes', () => {
  const { engine, params } = exampleGcode();
  const stats = engine.stats;
  ok(stats.totalCommands > 0, 'debe haber comandos');
  ok(stats.cutDistance > 0, 'debe haber distancia de corte');
  ok(stats.numPasses === Math.ceil(Math.abs(params.targetDepth) / params.stepdown), 'número de pasadas');
  ok(stats.timeTotalMin > 0, 'el tiempo debe ser positivo');
  approx(
    stats.totalDistance,
    Math.round((stats.rapidDistance + stats.cutDistance + stats.plungeDistance) * 100) / 100,
    0.02,
    'distancia total',
  );
});

test('Simulación: comandos con tiempos acumulados', () => {
  const { engine, gcode } = exampleGcode();
  const sim = engine.buildSimulation(gcode);
  ok(sim.commands.length === engine.toolpaths.length, 'un comando por segmento');
  ok(sim.totalTime > 0, 'el tiempo total debe ser positivo');
  ok(sim.blockLines.length > 0, 'debe haber bloques de código');
  ok(sim.blockLines.every((line) => !line.startsWith(';')), 'los comentarios se descartan');

  for (const command of sim.commands) {
    ok(Number.isFinite(command.time), 'tiempo finito');
    ok(Number.isFinite(command.dist), 'distancia finita');
  }
});

test('Cero pieza: modos disponibles', () => {
  const engine = new CAMEngine(new CAMParameters({ workZero: 'bottom_left' }));
  const bounds = {
    minX: 0, maxX: 120, minY: 0, maxY: 80, width: 120, height: 80,
  };
  const [bx, by] = engine.getZeroOffset(bounds);
  approx(bx, 0); approx(by, 0);

  engine.params.workZero = 'center';
  const [cx, cy] = engine.getZeroOffset(bounds);
  approx(cx, 60); approx(cy, 40);

  engine.params.workZero = 'top_left';
  const [tx, ty] = engine.getZeroOffset(bounds);
  approx(tx, 0); approx(ty, 80);

  engine.params.workZero = 'drawing_zero';
  const [dx, dy] = engine.getZeroOffset(bounds);
  approx(dx, 0); approx(dy, 0);

  engine.params.workZero = 'custom';
  engine.params.customZeroX = 12;
  engine.params.customZeroY = 34;
  const [ux, uy] = engine.getZeroOffset(bounds);
  approx(ux, 12); approx(uy, 34);
});

test('Pasadas en Z: nunca supera el paso configurado', () => {
  const engine = new CAMEngine(new CAMParameters({
    targetDepth: -10, stockSurfaceZ: 0, stepdown: 1.5,
  }));
  const passes = engine.calculateZPasses();
  ok(passes.length === 7, `se esperaban 7 pasadas, hay ${passes.length}`);
  approx(passes[passes.length - 1], -10, 1e-6, 'última pasada');
  let previous = 0;
  for (const pass of passes) {
    ok(previous - pass <= 1.5 + 1e-6, 'la pasada no debe superar el stepdown');
    previous = pass;
  }
});

// ---------------------------------------------------------------------------
// Postprocesador y seguridad
// ---------------------------------------------------------------------------

test('Postprocesador: formato de coordenadas', () => {
  const post = new PostProcessor('GRBL / Candle');
  ok(post.formatCoord(5) === '5', `esperaba "5", obtuve "${post.formatCoord(5)}"`);
  ok(post.formatCoord(1.5) === '1.5', 'debe conservar 1.5');
  ok(post.formatCoord(3.175) === '3.175');
  ok(post.formatCoord(0) === '0');
  ok(post.formatValue(-3) === '-3.0', 'los enteros se muestran con un decimal');
});

test('Postprocesador: cada perfil genera cabecera y pie válidos', () => {
  const profiles = [
    ['GRBL / Candle', 'G21 ; Unidades en milímetros (mm)'],
    ['Mach3 / Mach4', 'T1 M6 ; Cambio a herramienta 1'],
    ['LinuxCNC', 'G64 P0.02'],
    ['Marlin CNC', 'G90 ; absoluto'],
    ['Láser / Plasma 2D', 'M5 ; Láser apagado para inicio seguro'],
    ['Genérico ISO', 'G21 G90 G17'],
  ];

  for (const [profile, marker] of profiles) {
    const post = new PostProcessor(profile);
    const header = post.getHeader({ safe_z: 5, spindle_rpm: 12000, spindle_dwell: 1.5 });
    const footer = post.getFooter({ safe_z: 5 });
    includes(header.join('\n'), marker, `cabecera de ${profile}`);
    includes(footer.join('\n'), 'M30 ; Fin de programa CNC', `pie de ${profile}`);
    includes(footer.join('\n'), 'G0 Z5', `retracción en ${profile}`);
  }
});

test('Seguridad: detecta G0 en XY por debajo de Z seguro', () => {
  const gcode = [
    'G21 G90',
    'G0 Z5.000',
    'G0 Z0.500',
    'G0 X50.000 Y50.000',
    'M5',
    'G0 Z5.000',
  ].join('\n');
  const report = SafetyChecker.verifyGcode(gcode, 5, -3, 250);
  ok(report.status === 'PELIGRO', `estado inesperado: ${report.status}`);
  ok(report.errors.length >= 1, 'debe reportar al menos un error');
  includes(report.reportText, 'ERRORES CRÍTICOS');
});

test('Seguridad: detecta exceso de profundidad', () => {
  const gcode = 'G0 Z5\nM3 S12000\nG1 Z-8.000 F250\nM5\nG0 Z5';
  const report = SafetyChecker.verifyGcode(gcode, 5, -3, 250);
  ok(report.status === 'PELIGRO', 'la profundidad excesiva es un error');
  includes(report.errors.join(' '), 'excede la profundidad objetivo');
});

test('Seguridad: avisa de corte sin husillo encendido', () => {
  const gcode = 'G0 Z5\nG1 Z-1.000 F250\nG1 X10 Y10\nM5\nG0 Z5';
  const report = SafetyChecker.verifyGcode(gcode, 5, -3, 250);
  ok(report.status === 'ADVERTENCIA', `estado inesperado: ${report.status}`);
  includes(report.warnings.join(' '), 'sin comando M3');
});

test('Seguridad: no confunde M30 con M3 ni M5', () => {
  const gcode = 'G0 Z5\nM3 S12000\nG1 Z-1.000 F250\nG1 X10 Y10\nM5\nG0 Z5\nM30';
  const report = SafetyChecker.verifyGcode(gcode, 5, -3, 250);
  ok(report.status === 'SEGURO', `estado inesperado: ${report.status} (${report.warnings.join('; ')})`);
});

test('Seguridad: el programa de ejemplo queda en SEGURO', () => {
  const { gcode, params } = exampleGcode();
  const report = SafetyChecker.verifyGcode(gcode, params.safeZ, params.targetDepth, params.plungeFeed);
  ok(report.status === 'SEGURO', `estado: ${report.status}`);
  ok(report.errors.length === 0, 'sin errores');
  ok(report.warnings.length === 0, 'sin advertencias');
});
