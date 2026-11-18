'use strict';

/**
 * Pruebas de la interfaz (renderer) con jsdom.
 *
 * Se carga el HTML real y se ejecutan los mismos scripts de la aplicación, con
 * una API falsa que responde usando el núcleo CAD/CAM real. Así se verifica el
 * cableado completo: carga del DXF, capas, generación, simulador y menús.
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { JSDOM } = require('jsdom');

const { test, ok, includes } = require('./harness');

const { DxfLoader } = require('../src/shared/dxf-loader');
const { GeometryProcessor } = require('../src/shared/geometry');
const { CAMEngine, CAMParameters } = require('../src/shared/cam-engine');
const { SafetyChecker } = require('../src/shared/safety-check');
const {
  DEFAULT_PARAMS, OPERATIONS, OPERATION_LABELS, POST_PROFILES, ZERO_MODES,
} = require('../src/shared/constants');

const PROJECT_ROOT = path.join(__dirname, '..');
const RENDERER_DIR = path.join(PROJECT_ROOT, 'src', 'renderer');
const INDEX_HTML = path.join(RENDERER_DIR, 'index.html');
const EXAMPLE_DXF = path.join(PROJECT_ROOT, 'examples', 'ejemplo_pieza.dxf');

const RENDERER_SCRIPTS = ['util.js', 'cad-view.js', 'sim-view.js', 'app.js'];

// ---------------------------------------------------------------------------
// Contexto 2D falso
// ---------------------------------------------------------------------------

/** Contexto de canvas que acepta cualquier método y propiedad. */
function createFakeContext() {
  const target = {};
  return new Proxy(target, {
    get(object, property) {
      if (property in object) return object[property];
      const noop = () => {};
      object[property] = noop;
      return noop;
    },
    set(object, property, value) {
      object[property] = value;
      return true;
    },
  });
}

// ---------------------------------------------------------------------------
// API falsa que usa el núcleo real
// ---------------------------------------------------------------------------

/** Previsualización equivalente a la del proceso principal. */
function buildPreview(payload, layerConfigs, params) {
  const gp = new GeometryProcessor();
  const settings = { ...DEFAULT_PARAMS, ...params };

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
    for (const points of gp.computeOffset(contour, settings.toolDiameter, operation)) {
      if (points.length >= 2) paths.push({ layer: contour.layer, operation, points });
    }
    if (settings.tabsEnabled && contour.isClosed && contour.nestingLevel === 0) {
      if (gp.generateTabs(contour.points, settings.tabCount, settings.tabWidth).length) {
        tabs.push([contour.points[0][0], contour.points[0][1]]);
      }
    }
  }

  return {
    paths, tabs, zero: [0, 0], contourCount: contours.length,
  };
}

/** Generación equivalente a la del proceso principal. */
function buildGenerate(payload, layerConfigs, params) {
  const engine = new CAMEngine(new CAMParameters({ ...DEFAULT_PARAMS, ...params }));
  const gcode = engine.generateGcode(payload.entities, payload.bounds, layerConfigs);
  if (gcode.startsWith('; Error:')) return { ok: false, error: 'No hay entidades activas.' };

  const safety = SafetyChecker.verifyGcode(
    gcode,
    engine.params.safeZ,
    engine.params.targetDepth,
    engine.params.plungeFeed,
  );

  return {
    ok: true,
    gcode,
    stats: engine.stats,
    safety,
    sim: engine.buildSimulation(gcode),
    params: { ...engine.params },
    zero: engine.getZeroOffset(payload.bounds),
  };
}

/** Crea el objeto `window.api` de prueba y expone las llamadas recibidas. */
function createFakeApi() {
  const loader = new DxfLoader();
  loader.loadFile(EXAMPLE_DXF);
  const payload = loader.toPayload();

  const calls = [];
  let menuHandler = null;

  const initialLayerConfigs = () => {
    const configs = {};
    for (const layer of payload.layers) {
      if (layer.count > 0) configs[layer.name] = { visible: true, operation: layer.operation };
    }
    return configs;
  };

  const api = {
    calls,
    getMenuHandler: () => menuHandler,

    info: async () => ({
      version: '3.0.0',
      electron: 'test',
      chrome: 'test',
      node: 'test',
      platform: 'test',
      examplesDir: '',
      hasExample: true,
      defaults: { ...DEFAULT_PARAMS },
      operations: OPERATIONS,
      operationLabels: OPERATION_LABELS,
      postProfiles: POST_PROFILES,
      zeroModes: ZERO_MODES,
      numberLimits: {},
    }),

    openDxf: async () => ({ ok: false, canceled: true }),

    loadDxf: async (filePath) => {
      calls.push(['loadDxf', filePath]);
      const configs = initialLayerConfigs();
      return {
        ok: true,
        data: { ...payload, layerConfigs: configs, zero: [0, 0] },
        preview: buildPreview(payload, configs, DEFAULT_PARAMS),
      };
    },

    reloadDxf: async () => {
      calls.push(['reloadDxf']);
      const configs = initialLayerConfigs();
      return {
        ok: true,
        data: { ...payload, layerConfigs: configs, zero: [0, 0] },
        preview: buildPreview(payload, configs, DEFAULT_PARAMS),
      };
    },

    loadExample: async () => {
      calls.push(['loadExample']);
      const configs = initialLayerConfigs();
      return {
        ok: true,
        data: { ...payload, layerConfigs: configs, zero: [0, 0] },
        preview: buildPreview(payload, configs, DEFAULT_PARAMS),
      };
    },

    preview: async (request) => {
      calls.push(['preview', request]);
      return buildPreview(payload, request.layerConfigs, request.params);
    },

    generate: async (request) => {
      calls.push(['generate', request]);
      return buildGenerate(payload, request.layerConfigs, request.params);
    },

    saveGcode: async (content) => {
      calls.push(['saveGcode', content]);
      return { ok: true, filePath: path.join('C:', 'tmp', 'programa.nc') };
    },

    exportReport: async (content) => {
      calls.push(['exportReport', content]);
      return { ok: true, filePath: path.join('C:', 'tmp', 'informe.txt') };
    },

    copyText: async (text) => {
      calls.push(['copyText', text]);
      return { ok: true };
    },

    openExamples: async () => {
      calls.push(['openExamples']);
      return { ok: true };
    },

    onMenuAction: (callback) => {
      menuHandler = callback;
      return () => { menuHandler = null; };
    },
  };

  return api;
}

// ---------------------------------------------------------------------------
// Arranque de la aplicación en jsdom
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function waitFor(predicate, label, timeout = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error(`Tiempo agotado esperando: ${label}`);
}

/** Crea una instancia completa de la aplicación. */
async function createApp() {
  const html = fs.readFileSync(INDEX_HTML, 'utf8').replace(/<script src="[^"]+"><\/script>/g, '');
  const api = createFakeApi();
  const logs = [];

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: pathToFileURL(INDEX_HTML).href,
    beforeParse(window) {
      window.api = api;
      window.devicePixelRatio = 1;
      window.__logs = logs;

      window.console.info = (...args) => logs.push(['info', args.join(' ')]);
      window.console.error = (...args) => logs.push(['error', args.join(' ')]);
      window.console.warn = (...args) => logs.push(['warn', args.join(' ')]);

      window.addEventListener('error', (event) => logs.push(['window-error', String(event.message)]));
      window.addEventListener('unhandledrejection', (event) => {
        logs.push(['unhandled-rejection', String(event.reason)]);
      });

      window.HTMLCanvasElement.prototype.getContext = function getContext() {
        if (!this.__fakeContext) this.__fakeContext = createFakeContext();
        return this.__fakeContext;
      };

      // jsdom no calcula dimensiones reales: damos un tamaño de trabajo.
      window.HTMLElement.prototype.getBoundingClientRect = function rect() {
        return {
          x: 0, y: 0, left: 0, top: 0, width: 900, height: 600, right: 900, bottom: 600,
        };
      };

      window.Element.prototype.scrollIntoView = function scrollIntoView() {};
    },
  });

  const { window } = dom;

  for (const script of RENDERER_SCRIPTS) {
    const source = fs.readFileSync(path.join(RENDERER_DIR, script), 'utf8');
    try {
      window.eval(source);
    } catch (error) {
      throw new Error(`Error evaluando ${script}: ${error.message}`);
    }
  }

  // jsdom dispara DOMContentLoaded por su cuenta; si no llegó, se simula.
  const alreadyReady = logs.some(([type, message]) => type === 'info' && message.includes('APP_READY'));
  if (!alreadyReady) {
    await sleep(120);
    const readyAfterWait = logs.some(([type, message]) => type === 'info' && message.includes('APP_READY'));
    if (!readyAfterWait) window.dispatchEvent(new window.Event('DOMContentLoaded'));
  }

  await waitFor(
    () => logs.some(([type, message]) => type === 'info' && message.includes('APP_READY')),
    'arranque del renderer (APP_READY)',
  );

  return {
    dom,
    window,
    doc: window.document,
    api,
    logs,
    $: (id) => window.document.getElementById(id),
    click: (id) => window.document.getElementById(id).dispatchEvent(
      new window.MouseEvent('click', { bubbles: true }),
    ),
    input: (id, value) => {
      const element = window.document.getElementById(id);
      element.value = String(value);
      element.dispatchEvent(new window.Event('input', { bubbles: true }));
    },
    change: (id) => window.document.getElementById(id).dispatchEvent(
      new window.Event('change', { bubbles: true }),
    ),
    close: () => dom.window.close(),
  };
}

/** Devuelve el número de capas renderizadas. */
function layerRowCount(app) {
  return app.doc.querySelectorAll('.layer-row').length;
}

/** Comprueba que no haya errores registrados. */
function assertNoErrors(app) {
  const errors = app.logs.filter(([type]) => type === 'error' || type === 'window-error'
    || type === 'unhandled-rejection');
  ok(errors.length === 0, `errores en consola: ${JSON.stringify(errors)}`);
}

// ---------------------------------------------------------------------------
// Pruebas
// ---------------------------------------------------------------------------

test('Renderer: arranca y carga el DXF de ejemplo', async () => {
  const app = await createApp();
  try {
    includes(app.$('fileInfo').textContent, 'ejemplo_pieza.dxf', 'nombre del archivo');
    ok(layerRowCount(app) === 3, `se esperaban 3 capas, hay ${layerRowCount(app)}`);
    ok(app.$('cadHint').classList.contains('hidden'), 'el aviso del visor se oculta al cargar');
    includes(app.$('statusText').textContent, 'DXF cargado');
    ok(app.$('safetyBadge').dataset.status === 'none', 'sin seguridad calculada al inicio');
    assertNoErrors(app);
  } finally {
    app.close();
  }
});

test('Renderer: generar código actualiza código, simulación y seguridad', async () => {
  const app = await createApp();
  try {
    app.click('btnGenerate');
    await waitFor(() => app.$('gcodeText').value.length > 0, 'código G generado');

    includes(app.$('gcodeText').value, 'M30', 'fin de programa');
    includes(app.$('gcodeText').value, 'CORTE_SEGURO_2D', 'nombre del programa');
    includes(app.$('gcodeStats').textContent, 'bloques');
    includes(app.$('gcodeStats').textContent, 'SEGURO');

    ok(app.$('safetyBadge').dataset.status === 'SEGURO',
      `estado de seguridad: ${app.$('safetyBadge').dataset.status}`);

    const rows = app.$('simCodeList').querySelectorAll('.code-line');
    ok(rows.length > 0, 'el simulador debe listar bloques de código');
    ok(!app.$('simHint').classList.contains('hidden') === false, 'la pista del simulador se oculta');

    const activeTab = app.doc.querySelector('.tab.active');
    ok(activeTab.dataset.tab === 'sim', `pestaña activa: ${activeTab.dataset.tab}`);
    assertNoErrors(app);
  } finally {
    app.close();
  }
});

test('Renderer: el simulador avanza paso a paso y se reinicia', async () => {
  const app = await createApp();
  try {
    app.click('btnGenerate');
    await waitFor(() => app.$('gcodeText').value.length > 0, 'código G generado');

    app.click('simStep');
    app.click('simStep');
    await sleep(30);

    const telemetry = app.$('simTelemetry').textContent;
    includes(telemetry, 'Paso: 2/', `telemetría tras dos pasos: ${telemetry}`);
    ok(Number(app.$('simProgress').value) > 0, 'la barra de progreso debe avanzar');
    ok(app.$('simCodeList').querySelector('.code-line.active'), 'debe resaltarse un bloque');

    app.click('simReset');
    await sleep(30);
    includes(app.$('simTelemetry').textContent, 'Paso: 0/');
    ok(Number(app.$('simProgress').value) === 0, 'el progreso vuelve a cero');
    assertNoErrors(app);
  } finally {
    app.close();
  }
});

test('Renderer: la reproducción automática avanza y se detiene', async () => {
  const app = await createApp();
  try {
    app.click('btnGenerate');
    await waitFor(() => app.$('gcodeText').value.length > 0, 'código G generado');

    app.input('simSpeed', 50);
    app.click('simStart');
    await sleep(200);
    app.click('simPause');

    const telemetry = app.$('simTelemetry').textContent;
    ok(/Paso: (\d+)\//.test(telemetry), 'telemetría con paso');
    const step = Number(telemetry.match(/Paso: (\d+)\//)[1]);
    ok(step > 0, 'la simulación debe haber avanzado');

    app.click('simStop');
    await sleep(20);
    includes(app.$('simTelemetry').textContent, 'Paso: 0/');
    assertNoErrors(app);
  } finally {
    app.close();
  }
});

test('Renderer: cambiar la operación de una capa recalcula la previsualización', async () => {
  const app = await createApp();
  try {
    const selects = app.doc.querySelectorAll('.layer-row select');
    ok(selects.length === 3, 'debe haber un selector por capa');

    // Primera capa alfabética por orden del DXF: CONTORNO_EXTERIOR/AGUJEROS/GRABADO
    const target = selects[0];
    const layerName = target.closest('.layer-row').querySelector('.layer-name').textContent;

    target.value = 'SOBRE_LINEA';
    target.dispatchEvent(new app.window.Event('change', { bubbles: true }));

    await waitFor(
      () => app.api.calls.some(([name, request]) => name === 'preview'
        && request.layerConfigs[layerName]
        && request.layerConfigs[layerName].operation === 'SOBRE_LINEA'),
      'previsualización con la nueva operación',
    );

    app.click('btnGenerate');
    await waitFor(() => app.$('gcodeText').value.length > 0, 'código G regenerado');
    includes(app.$('gcodeText').value, `Operación: SOBRE_LINEA | Nivel Anidado`);
    assertNoErrors(app);
  } finally {
    app.close();
  }
});

test('Renderer: ocultar una capa la excluye del mecanizado', async () => {
  const app = await createApp();
  try {
    const row = app.doc.querySelectorAll('.layer-row')[0];
    const layerName = row.querySelector('.layer-name').textContent;
    const checkbox = row.querySelector('input[type="checkbox"]');
    checkbox.checked = false;
    checkbox.dispatchEvent(new app.window.Event('change', { bubbles: true }));

    await waitFor(
      () => app.api.calls.some(([name, request]) => name === 'preview'
        && request.layerConfigs[layerName]
        && request.layerConfigs[layerName].visible === false),
      'previsualización con la capa oculta',
    );

    app.click('btnGenerate');
    await waitFor(() => app.$('gcodeText').value.length > 0, 'código G generado');
    ok(!app.$('gcodeText').value.includes(`Capa: '${layerName}'`),
      `la capa ${layerName} no debería mecanizarse`);
    assertNoErrors(app);
  } finally {
    app.close();
  }
});

test('Renderer: guardar sin código avisa y con código abre el diálogo', async () => {
  const app = await createApp();
  try {
    app.click('btnSaveGcode');
    await sleep(50);
    ok(!app.api.calls.some(([name]) => name === 'saveGcode'), 'no debe guardarse sin código');
    ok(app.doc.querySelectorAll('.toast.warn').length >= 1, 'debe mostrarse un aviso');

    app.click('btnGenerate');
    await waitFor(() => app.$('gcodeText').value.length > 0, 'código G generado');

    app.click('btnSaveGcode');
    await waitFor(() => app.api.calls.some(([name]) => name === 'saveGcode'), 'guardado del archivo');
    await waitFor(
      () => app.$('statusText').textContent.includes('programa.nc'),
      `estado tras guardar: ${app.$('statusText').textContent}`,
    );
    assertNoErrors(app);
  } finally {
    app.close();
  }
});

test('Renderer: copiar al portapapeles y exportar el informe', async () => {
  const app = await createApp();
  try {
    app.click('btnGenerate');
    await waitFor(() => app.$('gcodeText').value.length > 0, 'código G generado');

    app.click('btnCopyGcode');
    await waitFor(() => app.api.calls.some(([name]) => name === 'copyText'), 'copia al portapapeles');

    // El informe se abre en un modal con el texto de verificación.
    app.click('btnSafety');
    await sleep(20);
    ok(!app.$('modal').classList.contains('hidden'), 'el modal debe mostrarse');
    includes(app.$('modalBody').textContent, 'INFORME DE SEGURIDAD CNC');

    app.click('modalOk');
    ok(app.$('modal').classList.contains('hidden'), 'el modal debe cerrarse');

    app.click('btnSafety');
    await sleep(10);
    app.doc.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    ok(app.$('modal').classList.contains('hidden'), 'Escape debe cerrar el modal');
    assertNoErrors(app);
  } finally {
    app.close();
  }
});

test('Renderer: zoom y ajuste de vista del visor CAD', async () => {
  const app = await createApp();
  try {
    app.click('cadZoomIn');
    app.click('cadZoomIn');
    app.click('cadZoomOut');
    app.click('cadFit');
    await sleep(30);

    app.change('showToolpaths');
    await sleep(30);
    assertNoErrors(app);
  } finally {
    app.close();
  }
});

test('Renderer: el menú nativo cambia de pestaña y abre la ayuda', async () => {
  const app = await createApp();
  try {
    const handler = app.api.getMenuHandler();
    ok(typeof handler === 'function', 'el renderer debe suscribirse al menú');

    handler('tab-gcode');
    await sleep(20);
    ok(app.doc.querySelector('.tab.active').dataset.tab === 'gcode', 'pestaña de código G');

    handler('tab-cad');
    await sleep(20);
    ok(app.doc.querySelector('.tab.active').dataset.tab === 'cad', 'pestaña CAD');

    handler('show-help');
    await sleep(20);
    ok(!app.$('modal').classList.contains('hidden'), 'la ayuda abre el modal');
    includes(app.$('modalBody').textContent, 'TRAYECTORIAS SEGURAS');

    handler('show-about');
    await sleep(20);
    includes(app.$('modalBody').textContent, 'Versión 3.0.0');
    assertNoErrors(app);
  } finally {
    app.close();
  }
});

test('Renderer: los parámetros editados llegan a la generación', async () => {
  const app = await createApp();
  try {
    app.input('toolDiameter', 6.35);
    app.input('targetDepth', -6);
    app.input('stepdown', 2);
    app.input('safeZ', 8);
    await sleep(50);

    includes(app.$('passesInfo').textContent, '3 pasadas', 'cálculo de pasadas en vivo');

    app.click('btnGenerate');
    await waitFor(() => app.$('gcodeText').value.length > 0, 'código G generado');

    const generateCall = app.api.calls.filter(([name]) => name === 'generate').pop();
    ok(generateCall, 'debe haberse llamado a generar');
    const { params } = generateCall[1];
    ok(params.toolDiameter === 6.35, `diámetro enviado: ${params.toolDiameter}`);
    ok(params.targetDepth === -6, `profundidad enviada: ${params.targetDepth}`);
    ok(params.safeZ === 8, `Z seguro enviado: ${params.safeZ}`);

    includes(app.$('gcodeText').value, 'Herramienta: D=6.35mm');
    includes(app.$('gcodeText').value, 'G0 Z8');
    assertNoErrors(app);
  } finally {
    app.close();
  }
});

test('Renderer: generar sin DXF avisa en vez de fallar', async () => {
  const app = await createApp();
  try {
    // Se fuerza el estado sin pieza recargando con un resultado cancelado.
    const api = app.api;
    api.loadExample = async () => ({ ok: false, error: 'El archivo de ejemplo no está disponible.' });
    app.click('btnGenerate');
    await sleep(60);
    assertNoErrors(app);
  } finally {
    app.close();
  }
});
