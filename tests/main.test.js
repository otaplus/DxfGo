'use strict';

/**
 * Pruebas del proceso principal y del preload.
 *
 * Se sustituye el módulo `electron` por una implementación mínima en memoria para
 * poder ejercitar los manejadores IPC reales (carga de DXF, generación, guardado)
 * sin abrir una ventana.
 */

const fs = require('fs');
const path = require('path');

const { test, ok, includes } = require('./harness');

const PROJECT_ROOT = path.join(__dirname, '..');
const EXAMPLE_DXF = path.join(PROJECT_ROOT, 'examples', 'ejemplo_pieza.dxf');
const TMP_DIR = path.join(PROJECT_ROOT, '.cache', 'test-tmp');

// ---------------------------------------------------------------------------
// Electron simulado
// ---------------------------------------------------------------------------

/** Instala un módulo `electron` falso y devuelve sus piezas de control. */
function installFakeElectron() {
  const handlers = new Map();
  const events = new Map();
  const windows = [];
  const clipboardWrites = [];
  let readyCallback = null;
  let saveDialogResult = { canceled: true, filePath: undefined };
  let openDialogResult = { canceled: true, filePaths: [] };

  const app = {
    name: 'CAD-CAM 2D CNC',
    requestSingleInstanceLock: () => true,
    quit: () => {},
    on: (event, callback) => {
      if (!events.has(event)) events.set(event, []);
      events.get(event).push(callback);
    },
    whenReady: () => ({
      then: (callback) => {
        readyCallback = callback;
        callback();
        return { catch: () => {} };
      },
    }),
    getVersion: () => '3.0.0',
    getAppPath: () => PROJECT_ROOT,
    getPath: (name) => (name === 'documents' ? TMP_DIR : TMP_DIR),
    setAppUserModelId: () => {},
  };

  class FakeBrowserWindow {
    constructor(options) {
      this.options = options;
      this.destroyed = false;
      windows.push(this);
      this.webContents = {
        on: () => {},
        once: (event, callback) => {
          if (event === 'did-finish-load') this.__didFinishLoad = callback;
        },
        setWindowOpenHandler: () => {},
        openDevTools: () => {},
        toggleDevTools: () => {},
        capturePage: async () => ({ toPNG: () => Buffer.alloc(0) }),
      };
    }

    loadFile(filePath) {
      this.loadedFile = filePath;
    }

    once() {}

    on(event, callback) {
      if (event === 'closed') this.__onClosed = callback;
    }

    show() {}

    isDestroyed() {
      return this.destroyed;
    }

    static getAllWindows() {
      return windows;
    }
  }

  const electron = {
    app,
    BrowserWindow: FakeBrowserWindow,
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
    },
    dialog: {
      showOpenDialog: async () => openDialogResult,
      showSaveDialog: async () => saveDialogResult,
    },
    Menu: {
      buildFromTemplate: (template) => ({ template }),
      setApplicationMenu: () => {},
    },
    clipboard: {
      writeText: (text) => clipboardWrites.push(text),
    },
    shell: {
      openPath: async () => '',
      showItemInFolder: () => {},
      openExternal: () => {},
    },
  };

  const electronPath = require.resolve('electron');
  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: electron,
  };

  return {
    electron,
    handlers,
    windows,
    clipboardWrites,
    get readyCallback() { return readyCallback; },
    setSaveDialog: (result) => { saveDialogResult = result; },
    setOpenDialog: (result) => { openDialogResult = result; },
    uninstall: () => { delete require.cache[electronPath]; },
  };
}

let mainLoaded = false;
let fake = null;

/** Carga el proceso principal una sola vez. */
function loadMain() {
  if (!mainLoaded) {
    fake = installFakeElectron();
    delete require.cache[require.resolve('../src/main/main.js')];
    require('../src/main/main.js');
    mainLoaded = true;
  }
  return fake;
}

/** Invoca un manejador IPC registrado. */
async function invoke(channel, ...args) {
  const control = loadMain();
  const handler = control.handlers.get(channel);
  ok(handler, `no existe el manejador IPC "${channel}"`);
  return handler({}, ...args);
}

/** Parámetros equivalentes a los de la interfaz. */
function guiParams(overrides = {}) {
  return {
    toolDiameter: 3.175,
    safeZ: 5,
    retractZ: 1.5,
    targetDepth: -3,
    stepdown: 1.5,
    cutFeed: 800,
    plungeFeed: 250,
    spindleRpm: 12000,
    tabCount: 4,
    tabWidth: 4,
    tabHeight: 1.2,
    tabsEnabled: true,
    workZero: 'bottom_left',
    postProfile: 'GRBL / Candle',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pruebas
// ---------------------------------------------------------------------------

test('Main: crea la ventana con la configuración segura esperada', () => {
  const control = loadMain();
  ok(control.windows.length === 1, `se esperaba una ventana, hay ${control.windows.length}`);

  const window = control.windows[0];
  ok(window.loadedFile.endsWith(path.join('src', 'renderer', 'index.html')),
    `archivo cargado: ${window.loadedFile}`);

  const prefs = window.options.webPreferences;
  ok(prefs.contextIsolation === true, 'contextIsolation debe estar activo');
  ok(prefs.nodeIntegration === false, 'nodeIntegration debe estar desactivado');
  ok(prefs.sandbox === true, 'sandbox debe estar activo');
  ok(prefs.preload.endsWith(path.join('src', 'preload', 'preload.js')), 'preload correcto');
  ok(window.options.width === 1380 && window.options.height === 880, 'tamaño inicial');
});

test('Main: app:info expone catálogos y valores por defecto', async () => {
  const info = await invoke('app:info');
  ok(info.version === '3.0.0', `versión: ${info.version}`);
  ok(info.hasExample === true, 'el ejemplo debe estar disponible');
  ok(info.operations.length === 5, 'cinco operaciones CAM');
  ok(info.zeroModes.length === 4, 'cuatro modos de cero');
  ok(info.postProfiles.length === 6, 'seis postprocesadores');
  ok(info.defaults.toolDiameter === 3.175, 'diámetro por defecto');
  ok(info.operationDescriptions.SOBRE_LINEA.includes('grabado'), 'descripciones de operación');
});

test('Main: cargar un DXF devuelve entidades, capas y previsualización', async () => {
  const result = await invoke('dxf:load', EXAMPLE_DXF);
  ok(result.ok === true, `carga fallida: ${result.error || ''}`);
  ok(result.data.entityCount === 8, `entidades: ${result.data.entityCount}`);
  ok(Object.keys(result.data.layerConfigs).length === 3, 'tres capas configuradas');
  ok(result.data.bounds.width === 120, 'ancho de la pieza');

  ok(result.preview.paths.length > 0, 'la previsualización debe tener trayectorias');
  ok(result.preview.tabs.length > 0, 'debe haber marcadores de pestañas');
  ok(result.preview.zero[0] === 0 && result.preview.zero[1] === 0, 'cero por defecto');
});

test('Main: generar código G produce programa, seguridad y simulación', async () => {
  const loaded = await invoke('dxf:load', EXAMPLE_DXF);
  const params = guiParams();
  const layerConfigs = loaded.data.layerConfigs;

  const result = await invoke('cam:generate', { params, layerConfigs });
  ok(result.ok === true, `generación fallida: ${result.error || ''}`);
  includes(result.gcode, 'M30 ; Fin de programa CNC');
  includes(result.gcode, 'Pestaña (Tab)', 'las pestañas están activas en la interfaz');
  ok(result.safety.status === 'SEGURO', `estado: ${result.safety.status}`);
  ok(result.stats.totalCommands > 0, 'estadísticas calculadas');
  ok(result.sim.commands.length === result.stats.totalCommands, 'un comando por segmento');
  ok(result.sim.totalTime > 0, 'tiempo de simulación');
  ok(result.params.toolDiameter === 3.175, 'los parámetros vuelven al renderer');
});

test('Main: los parámetros fuera de rango se recortan', async () => {
  const loaded = await invoke('dxf:load', EXAMPLE_DXF);
  const result = await invoke('cam:generate', {
    params: guiParams({ toolDiameter: -50, safeZ: 99999, postProfile: 'Inventado' }),
    layerConfigs: loaded.data.layerConfigs,
  });

  ok(result.ok === true, 'debe generar igualmente');
  ok(result.params.toolDiameter === 0.05, `diámetro recortado: ${result.params.toolDiameter}`);
  ok(result.params.safeZ === 500, `Z seguro recortado: ${result.params.safeZ}`);
  ok(result.params.postProfile === 'GRBL / Candle', 'postprocesador desconocido se sustituye');
});

test('Main: ocultar capas reduce la previsualización y el programa', async () => {
  const loaded = await invoke('dxf:load', EXAMPLE_DXF);
  const layerConfigs = { ...loaded.data.layerConfigs };
  for (const name of Object.keys(layerConfigs)) {
    layerConfigs[name] = { ...layerConfigs[name], visible: false };
  }
  layerConfigs.CONTORNO_EXTERIOR.visible = true;

  const preview = await invoke('cam:preview', { params: guiParams({ tabsEnabled: false }), layerConfigs });
  ok(preview.paths.length < loaded.preview.paths.length,
    'menos trayectorias al ocultar capas');
  ok(preview.paths.every((entry) => entry.layer === 'CONTORNO_EXTERIOR'),
    'solo debe quedar el contorno exterior');
});

test('Main: recargar sin archivo carga el actual y falla sin DXF', async () => {
  const reload = await invoke('dxf:reload');
  ok(reload.ok === true, 'debe recargar el archivo activo');
  ok(reload.data.entityCount === 8, 'misma pieza tras recargar');

  const bad = await invoke('dxf:load', path.join(TMP_DIR, 'no-existe.dxf'));
  ok(bad.ok === false, 'debe fallar con un archivo inexistente');
  includes(bad.error, 'No se pudo cargar');
});

test('Main: guardar el código G escribe el archivo elegido', async () => {
  loadMain();
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const target = path.join(TMP_DIR, 'salida-test.nc');
  fake.setSaveDialog({ canceled: false, filePath: target });

  const result = await invoke('file:save-gcode', 'G0 Z5\nM30');
  ok(result.ok === true, `guardado fallido: ${result.error || ''}`);
  ok(fs.existsSync(target), 'el archivo debe existir');
  ok(fs.readFileSync(target, 'utf8') === 'G0 Z5\nM30', 'contenido escrito');

  const canceled = await invoke('file:save-gcode', '');
  ok(canceled.ok === false, 'sin contenido no se guarda');
});

test('Main: exportar el informe y copiar al portapapeles', async () => {
  loadMain();
  const target = path.join(TMP_DIR, 'informe-test.txt');
  fake.setSaveDialog({ canceled: false, filePath: target });

  const result = await invoke('file:export-report', 'INFORME DE PRUEBA');
  ok(result.ok === true, 'exportación correcta');
  ok(fs.readFileSync(target, 'utf8') === 'INFORME DE PRUEBA', 'contenido del informe');

  await invoke('clipboard:write', 'texto copiado');
  ok(fake.clipboardWrites.includes('texto copiado'), 'debe escribirse en el portapapeles');
});

test('Main: abrir DXF con el diálogo cancelado no rompe nada', async () => {
  loadMain();
  fake.setOpenDialog({ canceled: true, filePaths: [] });
  const result = await invoke('dxf:open');
  ok(result.ok === false && result.canceled === true, 'debe informar de la cancelación');
});

test('Preload: expone exactamente la API que usa la interfaz', () => {
  const exposed = {};
  const electronPath = require.resolve('electron');
  const previous = require.cache[electronPath];

  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      contextBridge: {
        exposeInMainWorld: (name, api) => {
          exposed[name] = api;
        },
      },
      ipcRenderer: {
        invoke: async () => ({ ok: true }),
        on: () => {},
        removeListener: () => {},
      },
    },
  };

  const preloadPath = require.resolve('../src/preload/preload.js');
  delete require.cache[preloadPath];
  require(preloadPath);

  require.cache[electronPath] = previous;
  delete require.cache[preloadPath];

  ok(exposed.api, 'debe exponerse window.api');
  const expected = [
    'info', 'openDxf', 'loadDxf', 'reloadDxf', 'loadExample', 'preview', 'generate',
    'saveGcode', 'exportReport', 'copyText', 'openExamples', 'onMenuAction',
  ];
  for (const method of expected) {
    ok(typeof exposed.api[method] === 'function', `falta api.${method}`);
  }
  ok(Object.keys(exposed.api).length === expected.length,
    `métodos inesperados: ${Object.keys(exposed.api).join(', ')}`);

  const unsubscribe = exposed.api.onMenuAction(() => {});
  ok(typeof unsubscribe === 'function', 'onMenuAction debe devolver la baja');
});
