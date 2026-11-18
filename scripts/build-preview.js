'use strict';

/**
 * Genera una maqueta estática de la interfaz para verla en un navegador real.
 * Usa el núcleo CAD/CAM de verdad para producir los datos y sustituye la API de
 * IPC por una versión en memoria, de modo que se puede revisar el diseño sin
 * arrancar Electron (`npm run preview:ui`).
 */

const fs = require('fs');
const path = require('path');

const { DxfLoader } = require('../src/shared/dxf-loader');
const { GeometryProcessor } = require('../src/shared/geometry');
const { CAMEngine, CAMParameters } = require('../src/shared/cam-engine');
const { SafetyChecker } = require('../src/shared/safety-check');
const {
  DEFAULT_PARAMS, OPERATIONS, OPERATION_LABELS, OPERATION_DESCRIPTIONS,
  POST_PROFILES, ZERO_MODES,
} = require('../src/shared/constants');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.cache', 'preview');
fs.mkdirSync(OUT, { recursive: true });

const loader = new DxfLoader();
loader.loadFile(path.join(ROOT, 'examples', 'ejemplo_pieza.dxf'));
const payload = loader.toPayload();

const layerConfigs = {};
for (const layer of payload.layers) {
  if (layer.count > 0) layerConfigs[layer.name] = { visible: true, operation: layer.operation };
}

const params = new CAMParameters({ ...DEFAULT_PARAMS });

function buildPreview() {
  const gp = new GeometryProcessor();
  const active = payload.entities.filter((entity) => {
    const cfg = layerConfigs[entity.layer];
    return !cfg || cfg.visible !== false;
  });
  const contours = gp.analyzeNestingHierarchy(gp.chainEntities(active));
  const paths = [];
  const tabs = [];
  for (const contour of contours) {
    const cfg = layerConfigs[contour.layer];
    const operation = (cfg && cfg.operation) || 'PERFIL_EXTERIOR';
    for (const points of gp.computeOffset(contour, params.toolDiameter, operation)) {
      if (points.length >= 2) paths.push({ layer: contour.layer, operation, points });
    }
    if (params.tabsEnabled && contour.isClosed && contour.nestingLevel === 0) {
      const intervals = gp.generateTabs(contour.points, params.tabCount, params.tabWidth);
      let cumulative = 0;
      for (let i = 0; i < contour.points.length - 1; i += 1) {
        const p1 = contour.points[i];
        const p2 = contour.points[i + 1];
        const distance = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
        for (const [start, end] of intervals) {
          if (!(cumulative + distance < start || cumulative > end)) {
            tabs.push([(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2]);
          }
        }
        cumulative += distance;
      }
    }
  }
  return {
    paths, tabs, zero: [0, 0], contourCount: contours.length,
  };
}

const engine = new CAMEngine(params);
const gcode = engine.generateGcode(payload.entities, payload.bounds, layerConfigs);
const safety = SafetyChecker.verifyGcode(gcode, params.safeZ, params.targetDepth, params.plungeFeed);

const data = {
  info: {
    version: '3.0.0',
    electron: 'preview',
    chrome: 'navegador',
    node: '—',
    platform: 'preview',
    examplesDir: '',
    hasExample: true,
    defaults: DEFAULT_PARAMS,
    operations: OPERATIONS,
    operationLabels: OPERATION_LABELS,
    operationDescriptions: OPERATION_DESCRIPTIONS,
    postProfiles: POST_PROFILES,
    zeroModes: ZERO_MODES,
    numberLimits: {},
  },
  payload,
  layerConfigs,
  preview: buildPreview(),
  generate: {
    ok: true,
    gcode,
    stats: engine.stats,
    safety,
    sim: engine.buildSimulation(gcode),
    params: { ...engine.params },
    zero: engine.getZeroOffset(payload.bounds),
  },
};

fs.writeFileSync(path.join(OUT, 'data.js'),
  `window.__PREVIEW_DATA__ = ${JSON.stringify(data)};\n`, 'utf8');

fs.writeFileSync(path.join(OUT, 'fake-api.js'), `(function () {
  const D = window.__PREVIEW_DATA__;
  const later = (value) => new Promise((resolve) => setTimeout(() => resolve(value), 0));
  const loaded = () => later({
    ok: true,
    data: { ...D.payload, layerConfigs: D.layerConfigs, zero: [0, 0] },
    preview: D.preview,
  });
  window.api = {
    info: () => later(D.info),
    openDxf: () => later({ ok: false, canceled: true }),
    loadDxf: loaded,
    reloadDxf: loaded,
    loadExample: loaded,
    preview: () => later(D.preview),
    generate: () => later(D.generate),
    saveGcode: () => later({ ok: false, canceled: true }),
    exportReport: () => later({ ok: false, canceled: true }),
    copyText: () => later({ ok: true }),
    openExamples: () => later({ ok: true }),
    onMenuAction: () => () => {},
  };
}());
`, 'utf8');

// Copia del HTML real adaptada a la maqueta.
let html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
html = html.replace(/<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>\s*/, '');
html = html.replace('href="styles.css"', 'href="../../src/renderer/styles.css"');
html = html.replace(
  '<script src="util.js"></script>',
  '<script src="data.js"></script>\n  <script src="fake-api.js"></script>\n'
  + '  <script src="../../src/renderer/util.js"></script>',
);
html = html.replace('<script src="cad-view.js"></script>', '<script src="../../src/renderer/cad-view.js"></script>');
html = html.replace('<script src="sim-view.js"></script>', '<script src="../../src/renderer/sim-view.js"></script>');
html = html.replace('<script src="app.js"></script>', '<script src="../../src/renderer/app.js"></script>');
// Resumen para comprobar el DOM con --dump-dom y navegación por hash.
html = html.replace('</body>', `<script>
  setTimeout(function () {
    var hash = location.hash;
    if (hash === '#sim') {
      var generate = document.getElementById('btnGenerate');
      if (generate) generate.click();
      setTimeout(function () {
        var start = document.getElementById('simStart');
        if (start) start.click();
      }, 400);
      return;
    }
    if (hash === '#gcode') {
      var generateBtn = document.getElementById('btnGenerate');
      if (generateBtn) generateBtn.click();
      setTimeout(function () {
        var tab = document.querySelector('.tab[data-tab="gcode"]');
        if (tab) tab.click();
      }, 400);
      return;
    }
    var rows = document.querySelectorAll('.layer-row').length;
    var gcodeLines = (document.getElementById('gcodeText') || {}).value || '';
    document.title = 'PREVIEW rows=' + rows
      + ' gcode=' + gcodeLines.length
      + ' safety=' + document.getElementById('safetyBadge').dataset.status;
  }, 1200);
</script>
</body>`);

fs.writeFileSync(path.join(OUT, 'index.html'), html, 'utf8');

console.log('PREVIEW LISTO');
console.log('entidades', payload.entities.length, 'capas', Object.keys(layerConfigs).length);
console.log('trayectorias', data.preview.paths.length, 'pestañas', data.preview.tabs.length);
console.log('gcode', gcode.split('\n').length, 'líneas · estado', safety.status);
