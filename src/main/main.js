'use strict';

/**
 * Proceso principal de Electron.
 *
 * Custodia el estado de la sesión (DXF cargado, parámetros y capas), ejecuta el
 * núcleo CAD/CAM y expone una API mínima al renderer mediante IPC.
 */

const {
  app, BrowserWindow, ipcMain, dialog, Menu, clipboard, shell,
} = require('electron');
const path = require('path');
const fs = require('fs');

const { DxfLoader } = require('../shared/dxf-loader');
const { GeometryProcessor } = require('../shared/geometry');
const { CAMEngine, CAMParameters } = require('../shared/cam-engine');
const { SafetyChecker } = require('../shared/safety-check');
const {
  DEFAULT_MODAL_CODES, sanitizeModalCodes, injectModalCodes,
} = require('../shared/gcode-injector');
const {
  OPERATIONS, DEFAULT_PARAMS, NUMBER_LIMITS, POST_PROFILES, ZERO_MODES,
} = require('../shared/constants');
const {
  DEFAULT_LANGUAGE, loadLocales, translate,
} = require('../shared/locales');
const { Settings } = require('./settings');
const { buildMenu } = require('./menu');

/** @type {BrowserWindow|null} */
let mainWindow = null;

/** Estado de la sesión. */
const state = {
  loader: null,
  payload: null,
  params: new CAMParameters({ ...DEFAULT_PARAMS }),
  layerConfigs: {},
  gcode: '',
  safety: null,
  sim: null,
  stats: null,
  currentFile: '',
  language: DEFAULT_LANGUAGE,
  languages: [],
  messages: {},
  settings: null,
};

/**
 * Traduce una clave al idioma activo.
 * @param {string} key
 * @param {Object<string, unknown>} [vars]
 * @returns {string}
 */
function t(key, vars) {
  return translate(state.language, key, vars, state.messages);
}

/**
 * Catálogos de la interfaz traducidos (operaciones, descripciones y ceros).
 */
function localizedCatalogs() {
  const operationLabels = {};
  const operationDescriptions = {};
  for (const operation of OPERATIONS) {
    operationLabels[operation] = t(`operation.${operation}`);
    operationDescriptions[operation] = t(`operationDesc.${operation}`);
  }
  return {
    operationLabels,
    operationDescriptions,
    zeroModes: ZERO_MODES.map((mode) => ({
      value: mode.value,
      label: t(`zero.${mode.value}`),
    })),
  };
}

/** Lista de idiomas sin los diccionarios (para el menú y el renderer). */
function languageList() {
  return state.languages.map(({ code, name }) => ({ code, name }));
}

/** Payload que recibe el renderer al cambiar de idioma. */
function languagePayload() {
  return {
    language: state.language,
    messages: state.messages,
    languages: languageList(),
    ...localizedCatalogs(),
  };
}

/** Reconstruye el menú nativo en el idioma activo. */
function applyMenu() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const menu = buildMenu(mainWindow, {
    language: state.language,
    languages: languageList(),
    t,
    onSelectLanguage: (code) => applyLanguage(code),
  });
  Menu.setApplicationMenu(menu);
}

/**
 * Activa un idioma: actualiza estado, preferencias, menú y renderer.
 * @param {string} code
 * @param {{persist?: boolean}} [options]
 */
function applyLanguage(code, options = {}) {
  const found = state.languages.find((language) => language.code === code);
  state.language = found ? code : DEFAULT_LANGUAGE;
  state.messages = found && found.messages
    ? found.messages
    : (state.languages.find((language) => language.code === DEFAULT_LANGUAGE) || {}).messages || {};

  if (options.persist !== false && state.settings) state.settings.set('language', state.language);

  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(t('app.windowTitle'));
  applyMenu();

  const payload = languagePayload();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('language:changed', payload);
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

/** Carpeta de ejemplos incluida con la aplicación. */
function examplesDir() {
  return path.join(app.getAppPath(), 'examples');
}

/** Ruta del DXF de ejemplo. */
function exampleDxf() {
  return path.join(examplesDir(), 'ejemplo_pieza.dxf');
}

/** Restringe un número a un rango válido. */
function clampNumber(value, fallback, limits) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  if (!limits) return num;
  return Math.min(Math.max(num, limits.min), limits.max);
}

/** Normaliza los parámetros recibidos del renderer. */
function sanitizeParams(raw = {}) {
  const base = { ...DEFAULT_PARAMS };
  const num = (key, target) => {
    base[target] = clampNumber(raw[target], base[target], NUMBER_LIMITS[key]);
  };

  num('toolDiameter', 'toolDiameter');
  num('safeZ', 'safeZ');
  num('retractZ', 'retractZ');
  num('targetDepth', 'targetDepth');
  num('stepdown', 'stepdown');
  num('cutFeed', 'cutFeed');
  num('plungeFeed', 'plungeFeed');
  num('spindleRpm', 'spindleRpm');
  num('tabCount', 'tabCount');
  num('tabWidth', 'tabWidth');
  num('tabHeight', 'tabHeight');

  base.tabsEnabled = raw.tabsEnabled !== false;
  base.tabCount = Math.round(base.tabCount);
  base.spindleRpm = Math.round(base.spindleRpm);
  // Modo 2D: se ignoran las pestañas porque requieren mover el eje Z.
  base.twoDMode = raw.twoDMode === true;
  if (base.twoDMode) base.tabsEnabled = false;
  base.modalCodes = sanitizeModalCodes(raw.modalCodes);

  base.workZero = ZERO_MODES.some((mode) => mode.value === raw.workZero)
    ? raw.workZero : base.workZero;
  base.postProfile = POST_PROFILES.includes(raw.postProfile)
    ? raw.postProfile : base.postProfile;
  base.coolant = raw.coolant === 'flood' ? 'flood' : 'none';
  base.laserPower = clampNumber(raw.laserPower, base.laserPower, { min: 0, max: 100000 });

  return base;
}

/** Normaliza la configuración de capas recibida del renderer. */
function sanitizeLayerConfigs(raw = {}) {
  const clean = {};
  for (const [name, cfg] of Object.entries(raw || {})) {
    clean[name] = {
      visible: cfg && cfg.visible !== false,
      operation: OPERATIONS.includes(cfg && cfg.operation)
        ? cfg.operation : 'PERFIL_EXTERIOR',
    };
  }
  return clean;
}

/** Aplica parámetros y configuración de capas al estado de la sesión. */
function applyRequest(request = {}) {
  state.params = new CAMParameters(sanitizeParams(request.params));
  if (request.layerConfigs) {
    state.layerConfigs = sanitizeLayerConfigs(request.layerConfigs);
  }
  return state.params;
}

/** Cuadro delimitador por defecto cuando no hay pieza cargada. */
function emptyBounds() {
  return {
    minX: 0, maxX: 100, minY: 0, maxY: 100, width: 100, height: 100,
  };
}

/** Offset del cero pieza para los parámetros actuales. */
function currentZero() {
  const bounds = state.payload ? state.payload.bounds : emptyBounds();
  const engine = new CAMEngine(state.params, t);
  return engine.getZeroOffset(bounds);
}

/**
 * Recalcula la previsualización de trayectorias compensadas y pestañas para el
 * visor CAD.
 */
function buildPreview() {
  const gp = new GeometryProcessor();
  const params = state.params;
  const entities = state.payload ? state.payload.entities : [];

  const active = entities.filter((entity) => {
    const cfg = state.layerConfigs[entity.layer];
    return !cfg || cfg.visible !== false;
  });

  let contours = gp.chainEntities(active);
  contours = gp.analyzeNestingHierarchy(contours);

  const paths = [];
  const tabs = [];

  for (const contour of contours) {
    const cfg = state.layerConfigs[contour.layer];
    const operation = (cfg && cfg.operation) || 'PERFIL_EXTERIOR';
    const offsetPaths = gp.computeOffset(contour, params.toolDiameter, operation);

    for (const points of offsetPaths) {
      if (points.length >= 2) {
        paths.push({ layer: contour.layer, operation, closed: contour.isClosed, points });
      }
    }

    if (params.tabsEnabled && !params.twoDMode && contour.isClosed && contour.nestingLevel === 0) {
      const intervals = gp.generateTabs(contour.points, params.tabCount, params.tabWidth);
      if (intervals.length) {
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
  }

  return {
    paths,
    tabs,
    zero: currentZero(),
    contourCount: contours.length,
  };
}

/** Payload inicial con la información del DXF cargado. */
function buildLoadPayload() {
  const payload = state.payload;
  if (!payload) return null;
  return {
    ...payload,
    layerConfigs: state.layerConfigs,
    zero: currentZero(),
  };
}

/** Carga un archivo DXF y reinicia la configuración de capas. */
function loadDxf(filePath) {
  const loader = new DxfLoader();
  const ok = loader.loadFile(filePath);
  if (!ok) {
    return {
      ok: false,
      error: t('error.dxfEntities'),
    };
  }

  state.loader = loader;
  state.payload = loader.toPayload();
  state.currentFile = filePath;
  state.gcode = '';
  state.safety = null;
  state.sim = null;
  state.stats = null;

  state.layerConfigs = {};
  for (const layer of state.payload.layers) {
    if (layer.count > 0) {
      state.layerConfigs[layer.name] = {
        visible: true,
        operation: layer.operation,
      };
    }
  }

  return { ok: true, data: buildLoadPayload(), preview: buildPreview() };
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    examplesDir: examplesDir(),
    hasExample: fs.existsSync(exampleDxf()),
    // Idioma activo y diccionario ya resuelto para el renderer.
    language: state.language,
    languages: languageList(),
    messages: state.messages,
    // Catálogos y valores por defecto: el renderer no duplica estas constantes.
    defaults: { ...DEFAULT_PARAMS },
    defaultModalCodes: { ...DEFAULT_MODAL_CODES },
    operations: OPERATIONS,
    postProfiles: POST_PROFILES,
    numberLimits: NUMBER_LIMITS,
    ...localizedCatalogs(),
  }));

  ipcMain.handle('language:set', (_event, code) => {
    const payload = applyLanguage(code);
    return { ok: true, ...payload };
  });

  ipcMain.handle('dxf:open', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: t('dialog.openTitle'),
      properties: ['openFile'],
      filters: [
        { name: t('dialog.filterDxf'), extensions: ['dxf'] },
        { name: t('dialog.filterAll'), extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
    try {
      return loadDxf(result.filePaths[0]);
    } catch (error) {
      return { ok: false, error: t('error.dxfOpen', { message: error.message }) };
    }
  });

  ipcMain.handle('dxf:load', (_event, filePath) => {
    try {
      return loadDxf(filePath);
    } catch (error) {
      return { ok: false, error: t('error.dxfOpen', { message: error.message }) };
    }
  });

  ipcMain.handle('dxf:reload', () => {
    if (!state.currentFile) return { ok: false, error: t('error.dxfReloadNone') };
    try {
      return loadDxf(state.currentFile);
    } catch (error) {
      return { ok: false, error: t('error.dxfReload', { message: error.message }) };
    }
  });

  ipcMain.handle('dxf:example', () => {
    if (!fs.existsSync(exampleDxf())) {
      return { ok: false, error: t('error.exampleMissing') };
    }
    try {
      return loadDxf(exampleDxf());
    } catch (error) {
      return { ok: false, error: t('error.exampleLoad', { message: error.message }) };
    }
  });

  ipcMain.handle('cam:preview', (_event, request) => {
    applyRequest(request);
    if (!state.payload) return { paths: [], tabs: [], zero: [0, 0], contourCount: 0 };
    return buildPreview();
  });

  ipcMain.handle('cam:generate', (_event, request) => {
    applyRequest(request);
    if (!state.payload) {
      return { ok: false, error: t('error.noDxf') };
    }

    try {
      const engine = new CAMEngine(state.params, t);
      const gcode = engine.generateGcode(
        state.payload.entities,
        state.payload.bounds,
        state.layerConfigs,
      );

      if (gcode.startsWith('; Error:')) {
        return { ok: false, error: t('error.noEntities') };
      }

      const safety = SafetyChecker.verifyGcode(
        gcode,
        state.params.safeZ,
        state.params.targetDepth,
        state.params.plungeFeed,
        { twoDMode: state.params.twoDMode, t },
      );

      // Los códigos modales del usuario se insertan después de verificar la
      // seguridad, para que sus fragmentos no alteren el análisis de movimiento.
      const finalGcode = injectModalCodes(gcode, state.params.modalCodes);
      const sim = engine.buildSimulation(finalGcode);

      state.gcode = finalGcode;
      state.safety = safety;
      state.stats = engine.stats;
      state.sim = sim;

      return {
        ok: true,
        gcode: finalGcode,
        stats: engine.stats,
        safety,
        sim,
        params: state.params,
        zero: currentZero(),
      };
    } catch (error) {
      return { ok: false, error: t('error.generate', { message: error.message }) };
    }
  });

  ipcMain.handle('file:save-gcode', async (_event, content) => {
    if (!content) return { ok: false, error: t('error.saveNoGcode') };

    const suggested = state.currentFile
      ? `${path.basename(state.currentFile, path.extname(state.currentFile))}.nc`
      : t('file.programName');

    const result = await dialog.showSaveDialog(mainWindow, {
      title: t('dialog.saveTitle'),
      defaultPath: state.currentFile
        ? path.join(path.dirname(state.currentFile), suggested)
        : path.join(app.getPath('documents'), suggested),
      filters: [
        { name: t('dialog.saveFilterNc'), extensions: ['nc'] },
        { name: t('dialog.saveFilterGcode'), extensions: ['gcode'] },
        { name: t('dialog.saveFilterTap'), extensions: ['tap'] },
        { name: t('dialog.saveFilterTxt'), extensions: ['txt'] },
        { name: t('dialog.filterAll'), extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };

    try {
      fs.writeFileSync(result.filePath, content, 'utf8');
      return { ok: true, filePath: result.filePath };
    } catch (error) {
      return { ok: false, error: t('error.save', { message: error.message }) };
    }
  });

  ipcMain.handle('file:export-report', async (_event, reportText) => {
    if (!reportText) return { ok: false, error: t('error.exportNoGcode') };

    const result = await dialog.showSaveDialog(mainWindow, {
      title: t('dialog.reportTitle'),
      defaultPath: t('file.reportName'),
      filters: [{ name: t('dialog.reportFilter'), extensions: ['txt'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };

    try {
      fs.writeFileSync(result.filePath, reportText, 'utf8');
      return { ok: true, filePath: result.filePath };
    } catch (error) {
      return { ok: false, error: `${t('error.export')}\n${error.message}` };
    }
  });

  ipcMain.handle('clipboard:write', (_event, text) => {
    clipboard.writeText(String(text || ''));
    return { ok: true };
  });

  ipcMain.handle('shell:open-examples', async () => {
    const dir = examplesDir();
    try {
      // En desarrollo los ejemplos están en disco y basta con mostrarlos.
      if (!app.isPackaged) {
        if (fs.existsSync(exampleDxf())) {
          shell.showItemInFolder(exampleDxf());
          return { ok: true };
        }
        const error = await shell.openPath(dir);
        return error ? { ok: false, error } : { ok: true };
      }

      // Empaquetada, la carpeta de ejemplos vive dentro de app.asar (solo
      // lectura), así que se copia a Documentos para poder abrirla con el
      // explorador del sistema.
      const target = path.join(app.getPath('documents'), 'CAD-CAM 2D CNC', 'Ejemplos');
      fs.mkdirSync(target, { recursive: true });
      for (const name of fs.readdirSync(dir)) {
        fs.copyFileSync(path.join(dir, name), path.join(target, name));
      }
      const error = await shell.openPath(target);
      if (error) return { ok: false, error };
      return { ok: true, dir: target };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
}

// ---------------------------------------------------------------------------
// Ventana
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#1e1e1e',
    title: t('app.windowTitle'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  // Gancho de diagnóstico para pruebas de humo y CI: registra la consola del
  // renderer, captura la ventana y sale. Solo se activa con variables de entorno.
  if (process.env.DXF2GCODE_SCREENSHOT) {
    const logPath = `${process.env.DXF2GCODE_SCREENSHOT}.log`;
    const log = (text) => {
      try {
        fs.appendFileSync(logPath, `${text}\n`, 'utf8');
      } catch (error) {
        // El registro es auxiliar: si falla no debe afectar a la aplicación.
      }
    };
    log(`START ${new Date().toISOString()} electron=${process.versions.electron}`);

    // Electron >= 33 entrega un único objeto de detalles; se admiten ambas formas.
    mainWindow.webContents.on('console-message', (...args) => {
      const first = args[0];
      if (first && typeof first === 'object' && 'message' in first) {
        log(`[renderer:${first.level}] ${first.message} (${first.sourceId}:${first.lineNumber})`);
      } else {
        log(`[renderer:${args[1]}] ${args[2]} (${args[4]}:${args[3]})`);
      }
    });
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      log(`RENDER_PROCESS_GONE ${JSON.stringify(details)}`);
    });
    mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
      log(`DID_FAIL_LOAD ${code} ${description} ${url}`);
    });

    mainWindow.webContents.once('did-finish-load', () => {
      log('DID_FINISH_LOAD');
      const delay = Number(process.env.DXF2GCODE_SCREENSHOT_DELAY || 3000);
      setTimeout(async () => {
        if (process.env.DXF2GCODE_SCREENSHOT_CAPTURE !== '0') {
          try {
            const image = await mainWindow.webContents.capturePage();
            fs.writeFileSync(process.env.DXF2GCODE_SCREENSHOT, image.toPNG());
            log(`SCREENSHOT ${process.env.DXF2GCODE_SCREENSHOT}`);
          } catch (error) {
            log(`SCREENSHOT_FAILED ${error.message}`);
          }
        }
        if (process.env.DXF2GCODE_SCREENSHOT_QUIT !== '0') app.quit();
      }, delay);
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Los enlaces externos se abren en el navegador, nunca dentro de la app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  applyMenu();
}

// ---------------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.dxf2gcode.cadcam');

    // Idioma: se leen los archivos de locales/ y la preferencia guardada.
    state.settings = new Settings(path.join(app.getPath('userData'), 'settings.json'));
    state.languages = loadLocales(app.getAppPath());
    if (!state.languages.length) {
      state.languages = [{ code: DEFAULT_LANGUAGE, name: 'Español', messages: {} }];
    }
    const savedLanguage = state.settings.get('language', DEFAULT_LANGUAGE);
    state.language = state.languages.some((language) => language.code === savedLanguage)
      ? savedLanguage : DEFAULT_LANGUAGE;
    state.messages = (state.languages.find((language) => language.code === state.language)
      || {}).messages || {};

    registerIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

module.exports = { state };
