'use strict';

/**
 * Lógica de la interfaz: formularios, capas, generación de código G y
 * coordinación entre los dos lienzos (visor CAD y simulador).
 *
 * Todos los textos visibles se obtienen de `window.I18n` (cargado antes que este
 * archivo). Al cambiar de idioma se vuelve a aplicar el diccionario y se
 * reconstruyen las partes dinámicas de la interfaz.
 */

(function attachApp() {
  const { $, debounce, showModal, hideModal } = window.U;
  const { I18n } = window;

  /** Traduce una clave al idioma activo. */
  const t = (key, vars) => I18n.t(key, vars);

  /** Campos numéricos del formulario. */
  const NUMERIC_FIELDS = [
    'toolDiameter', 'safeZ', 'retractZ', 'targetDepth', 'stepdown',
    'cutFeed', 'plungeFeed', 'spindleRpm', 'tabCount', 'tabWidth', 'tabHeight',
  ];

  const EMPTY_MODAL_CODES = {
    beforeG0: '', afterG0: '', beforeArc: '', afterArc: '',
  };

  const state = {
    info: null,
    payload: null,
    layerConfigs: {},
    visibility: {},
    gcode: '',
    safety: null,
    stats: null,
    busy: false,
    modalCodes: { ...EMPTY_MODAL_CODES },
    // Datos para poder repintar los textos al cambiar de idioma.
    fileInfoVars: null,
    statsView: null,
    statusKey: 'status.ready',
    statusVars: {},
    languages: [],
  };

  let cadView = null;
  let simView = null;

  // ---------------------------------------------------------------------------
  // Parámetros
  // ---------------------------------------------------------------------------

  /** Lee los parámetros del formulario. */
  function readParams() {
    const params = {};
    for (const field of NUMERIC_FIELDS) {
      const input = $(field);
      const value = input ? Number(input.value) : NaN;
      params[field] = Number.isFinite(value) ? value : state.info.defaults[field];
    }
    params.tabsEnabled = $('tabsEnabled').checked;
    params.workZero = $('workZero').value;
    params.postProfile = $('postProfile').value;
    params.twoDMode = $('twoDMode').checked;
    params.modalCodes = { ...state.modalCodes };
    return params;
  }

  /** Vuelca los parámetros al formulario. */
  function writeParams(params) {
    for (const field of NUMERIC_FIELDS) {
      const input = $(field);
      if (input && Number.isFinite(params[field])) input.value = String(params[field]);
    }
    $('tabsEnabled').checked = Boolean(params.tabsEnabled);
    $('twoDMode').checked = Boolean(params.twoDMode);
    applyTwoDModeUI();
  }

  /** Deshabilita los controles que no intervienen en modo 2D. */
  function applyTwoDModeUI() {
    const twoD = $('twoDMode').checked;
    const disabled = [
      'safeZ', 'retractZ', 'targetDepth', 'stepdown',
      'tabsEnabled', 'tabCount', 'tabWidth', 'tabHeight',
    ];
    for (const id of disabled) {
      const input = $(id);
      if (input) input.disabled = twoD;
    }
    updatePassesInfo();
  }

  /** Solicitud que entiende el proceso principal. */
  function requestPayload() {
    return { params: readParams(), layerConfigs: state.layerConfigs };
  }

  // ---------------------------------------------------------------------------
  // Barra de estado
  // ---------------------------------------------------------------------------

  /** Escribe el mensaje de estado traduciéndolo en el momento de pintarlo. */
  function setStatus(key, vars = {}) {
    state.statusKey = key;
    state.statusVars = vars;
    $('statusText').textContent = t(key, vars);
  }

  // ---------------------------------------------------------------------------
  // Códigos modales configurables
  // ---------------------------------------------------------------------------

  /** Relación entre claves de datos e identificadores del formulario. */
  const MODAL_FIELDS = [
    ['beforeG0', 'codesBeforeG0'],
    ['afterG0', 'codesAfterG0'],
    ['beforeArc', 'codesBeforeArc'],
    ['afterArc', 'codesAfterArc'],
  ];

  /** Etiqueta traducible de cada campo de códigos modales. */
  const MODAL_LABEL_KEYS = {
    beforeG0: 'modalCodes.label.beforeG0',
    afterG0: 'modalCodes.label.afterG0',
    beforeArc: 'modalCodes.label.beforeArc',
    afterArc: 'modalCodes.label.afterArc',
  };

  /** Vuelca los códigos configurados al formulario del diálogo. */
  function writeModalCodesForm(codes = state.modalCodes) {
    for (const [key, id] of MODAL_FIELDS) {
      const field = $(id);
      if (field) field.value = codes[key] || '';
    }
  }

  /** Lee los códigos escritos en el diálogo. */
  function readModalCodesForm() {
    const codes = {};
    for (const [key, id] of MODAL_FIELDS) {
      const field = $(id);
      codes[key] = field ? field.value : '';
    }
    return codes;
  }

  /** Resume en el panel qué fragmentos están configurados. */
  function updateModalCodesSummary() {
    const label = $('modalCodesSummary');
    if (!label) return;
    const active = MODAL_FIELDS
      .filter(([key]) => String(state.modalCodes[key] || '').trim())
      .map(([key]) => t(MODAL_LABEL_KEYS[key]));
    label.textContent = active.length
      ? t('modalCodes.summary.configured', { list: active.join(', ') })
      : t('modalCodes.summary.none');
  }

  function openModalCodes() {
    writeModalCodesForm();
    $('modalCodes').classList.remove('hidden');
  }

  function closeModalCodes() {
    $('modalCodes').classList.add('hidden');
  }

  function applyModalCodes() {
    state.modalCodes = readModalCodesForm();
    updateModalCodesSummary();
    closeModalCodes();
    window.U.toast(t('toast.modalCodesUpdated'), 'ok', 2200);
  }

  // ---------------------------------------------------------------------------
  // Interfaz de capas
  // ---------------------------------------------------------------------------

  function renderLayers() {
    const container = $('layerList');
    if (!container) return;
    container.textContent = '';

    const layers = (state.payload ? state.payload.layers : [])
      .filter((layer) => layer.count > 0);

    if (!layers.length) {
      container.appendChild(window.U.el('p', 'hint-text', t('layers.empty')));
      return;
    }

    const fragment = document.createDocumentFragment();

    for (const layer of layers) {
      const config = state.layerConfigs[layer.name] || { visible: true, operation: layer.operation };

      const row = window.U.el('div', 'layer-row');

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = config.visible !== false;
      checkbox.title = t('layers.toggleTitle');
      checkbox.addEventListener('change', () => {
        config.visible = checkbox.checked;
        state.visibility[layer.name] = checkbox.checked;
        cadView.setVisibility(state.visibility);
        schedulePreview();
      });

      const dot = window.U.el('span', 'layer-dot');
      dot.style.background = layer.colorHex;

      const name = window.U.el('span', 'layer-name', layer.name);
      name.title = t('layers.entitiesTitle', { name: layer.name, count: layer.count });

      const count = window.U.el('span', 'layer-count', String(layer.count));

      const select = document.createElement('select');
      const descriptions = state.info.operationDescriptions || {};
      for (const operation of state.info.operations) {
        const option = document.createElement('option');
        option.value = operation;
        option.textContent = state.info.operationLabels[operation] || operation;
        option.title = descriptions[operation] || '';
        if (operation === config.operation) option.selected = true;
        select.appendChild(option);
      }
      select.title = descriptions[config.operation] || t('layers.operationTitle');
      select.addEventListener('change', () => {
        config.operation = select.value;
        select.title = descriptions[select.value] || '';
        schedulePreview();
      });

      row.append(checkbox, dot, name, count, select);
      fragment.appendChild(row);
    }

    container.appendChild(fragment);
  }

  // ---------------------------------------------------------------------------
  // Carga de DXF
  // ---------------------------------------------------------------------------

  function updateWindowTitle() {
    const fileName = state.payload ? state.payload.fileName : '';
    document.title = fileName
      ? `${fileName} — ${t('app.shortTitle')}`
      : t('app.windowTitle');
  }

  function applyLoadResult(result) {
    if (!result.ok) {
      if (!result.canceled) {
        window.U.toast(result.error || t('toast.loadError'), 'error', 7000);
      }
      return false;
    }

    state.payload = result.data;
    state.layerConfigs = { ...result.data.layerConfigs };
    state.visibility = {};
    for (const layer of state.payload.layers) {
      state.visibility[layer.name] = (state.layerConfigs[layer.name] || {}).visible !== false;
    }

    state.gcode = '';
    state.safety = null;
    state.stats = null;
    state.statsView = null;

    $('gcodeText').value = '';
    $('gcodeStats').textContent = t('gcode.stats.empty');
    setSafety(null);

    const bounds = state.payload.bounds;
    state.fileInfoVars = {
      name: state.payload.fileName,
      width: bounds.width.toFixed(1),
      height: bounds.height.toFixed(1),
      count: state.payload.entityCount,
    };
    $('fileInfo').textContent = t('fileInfo.loaded', state.fileInfoVars);

    const unsupported = Object.entries(state.payload.unsupported || {});
    if (unsupported.length) {
      const detail = unsupported.map(([type, count]) => `${type} (${count})`).join(', ');
      window.U.toast(t('toast.unsupported', { detail }), 'warn', 6000);
    }

    renderLayers();

    cadView.setData({
      entities: state.payload.entities,
      bounds: state.payload.bounds,
      layers: state.payload.layers,
      zero: result.data.zero,
    });
    cadView.setVisibility(state.visibility);
    cadView.setPreview(result.preview);

    simView.clear();

    setStatus('status.loaded', {
      name: state.payload.fileName,
      count: state.payload.entityCount,
    });
    $('cadHint').classList.add('hidden');

    updateWindowTitle();
    return true;
  }

  async function openDxf() {
    const result = await window.api.openDxf();
    applyLoadResult(result);
  }

  async function reloadDxf() {
    if (!state.payload) {
      window.U.toast(t('toast.noDxf'), 'warn');
      return;
    }
    const result = await window.api.reloadDxf();
    if (applyLoadResult(result)) window.U.toast(t('toast.reloaded'), 'ok', 2200);
  }

  async function loadExample() {
    const result = await window.api.loadExample();
    if (applyLoadResult(result)) {
      window.U.toast(t('toast.exampleLoaded'), 'ok', 2600);
    }
  }

  // ---------------------------------------------------------------------------
  // Previsualización
  // ---------------------------------------------------------------------------

  const schedulePreview = debounce(async () => {
    if (!state.payload) return;
    try {
      const preview = await window.api.preview(requestPayload());
      cadView.setPreview(preview);
    } catch (error) {
      // La previsualización es auxiliar: un fallo no debe bloquear la interfaz.
      console.error('preview', error);
    }
  }, 140);

  // ---------------------------------------------------------------------------
  // Generación
  // ---------------------------------------------------------------------------

  function setSafety(status) {
    const badge = $('safetyBadge');
    if (!status) {
      badge.dataset.status = 'none';
      badge.textContent = t('safety.none');
      return;
    }
    const icons = { SEGURO: '✔', ADVERTENCIA: '⚠', PELIGRO: '✖' };
    badge.dataset.status = status;
    badge.textContent = t('safety.status', {
      status: t(`safety.${status}`),
      icon: icons[status] || '',
    }).trim();
  }

  function setBusy(busy) {
    state.busy = busy;
    $('btnGenerate').disabled = busy;
    $('btnGenerate').textContent = busy ? t('actions.generating') : t('actions.generate');
  }

  /** Pinta la línea de estadísticas del programa a partir del último cálculo. */
  function renderStats() {
    const view = state.statsView;
    if (!view || !view.stats) {
      $('gcodeStats').textContent = t('gcode.stats.empty');
      return;
    }
    const { stats, twoD, status } = view;
    $('gcodeStats').textContent = t('stats.summary', {
      blocks: stats.totalCommands,
      cut: stats.cutDistance,
      rapid: stats.rapidDistance,
      time: stats.timeTotalMin,
      mode: twoD ? t('stats.mode2d') : t('stats.passes', { count: stats.numPasses }),
      status: t(`safety.${status}`),
    });
  }

  async function generate() {
    if (state.busy) return;
    if (!state.payload) {
      window.U.toast(t('toast.generateNoDxf'), 'warn');
      return;
    }

    setBusy(true);
    try {
      const result = await window.api.generate(requestPayload());
      if (!result.ok) {
        window.U.toast(result.error || t('toast.generateError'), 'error', 7000);
        setStatus('status.generationError');
        return;
      }

      state.gcode = result.gcode;
      state.safety = result.safety;
      state.stats = result.stats;

      $('gcodeText').value = result.gcode;
      $('gcodeText').scrollTop = 0;

      const stats = result.stats;
      const twoD = Boolean(result.params && result.params.twoDMode);
      state.statsView = { stats, twoD, status: result.safety.status };
      renderStats();

      setSafety(result.safety.status);

      simView.setData(
        result.sim,
        result.params ? result.params.toolDiameter : 3.175,
        result.params ? result.params.stockSurfaceZ : 0,
      );
      if (result.zero) cadView.setZero(result.zero);

      setStatus('status.generated', {
        blocks: stats.totalCommands,
        status: t(`safety.${result.safety.status}`),
      });

      const type = result.safety.status === 'PELIGRO' ? 'error'
        : (result.safety.status === 'ADVERTENCIA' ? 'warn' : 'ok');
      const depthInfo = twoD
        ? t('toast.generated2d')
        : t('toast.generatedDepth', {
          passes: stats.numPasses,
          depth: result.params ? result.params.targetDepth : '',
        });
      window.U.toast(t('toast.generated', {
        status: t(`safety.${result.safety.status}`),
        depth: depthInfo,
        time: stats.timeTotalMin,
      }), type, 5200);

      switchTab('sim');
    } finally {
      setBusy(false);
    }
  }

  async function saveGcode() {
    if (!state.gcode) {
      window.U.toast(t('toast.generateFirst'), 'warn');
      return;
    }
    const result = await window.api.saveGcode(state.gcode);
    if (result.canceled) return;
    if (!result.ok) {
      window.U.toast(result.error || t('toast.saveError'), 'error', 6000);
      return;
    }
    const fileName = result.filePath.split(/[\\/]/).pop();
    setStatus('status.saved', { file: fileName });
    window.U.toast(t('toast.saved', { path: result.filePath }), 'ok', 4200);
  }

  async function exportReport() {
    if (!state.safety) {
      window.U.toast(t('toast.generateFirstReport'), 'warn');
      return;
    }
    const result = await window.api.exportReport(state.safety.reportText);
    if (result.canceled) return;
    if (!result.ok) {
      window.U.toast(result.error || t('toast.reportError'), 'error', 6000);
      return;
    }
    window.U.toast(t('toast.reportExported', { path: result.filePath }), 'ok', 4200);
  }

  async function copyGcode() {
    if (!state.gcode) {
      window.U.toast(t('toast.noGcode'), 'warn');
      return;
    }
    await window.api.copyText(state.gcode);
    window.U.toast(t('toast.copied'), 'ok', 2200);
  }

  function showSafety() {
    if (!state.safety) {
      window.U.toast(t('toast.generateFirstSafety'), 'warn');
      return;
    }
    const status = state.safety.status;
    showModal(t('safety.report.windowTitle'), state.safety.reportText, {
      mono: status !== 'SEGURO',
    });
  }

  // ---------------------------------------------------------------------------
  // Ayuda
  // ---------------------------------------------------------------------------

  function showHelp() {
    showModal(t('help.title'), t('help.text'), { mono: true });
  }

  function showAbout() {
    const info = state.info || { version: '—', electron: '—', platform: '—' };
    showModal(t('about.title'), t('about.text', {
      version: info.version,
      electron: info.electron,
      platform: info.platform,
    }));
  }

  // ---------------------------------------------------------------------------
  // Pestañas
  // ---------------------------------------------------------------------------

  function switchTab(name) {
    for (const tab of document.querySelectorAll('.tab')) {
      tab.classList.toggle('active', tab.dataset.tab === name);
    }
    for (const panel of document.querySelectorAll('.tab-panel')) {
      panel.classList.toggle('active', panel.id === `panel-${name}`);
    }
    // Los lienzos ocultos no tienen tamaño: redibujamos al mostrarlos.
    requestAnimationFrame(() => {
      if (name === 'cad') cadView.draw();
      if (name === 'sim') simView.draw();
    });
  }

  // ---------------------------------------------------------------------------
  // Parámetros: cálculo de pasadas
  // ---------------------------------------------------------------------------

  function updatePassesInfo() {
    const depth = Math.abs(Number($('targetDepth').value));
    const stepdown = Math.abs(Number($('stepdown').value));
    const label = $('passesInfo');
    if (!label) return;

    if ($('twoDMode').checked) {
      label.textContent = t('passes.twoD');
      return;
    }

    if (Number.isFinite(depth) && Number.isFinite(stepdown) && stepdown > 0.001 && depth > 0.001) {
      const passes = Math.max(1, Math.ceil(depth / stepdown));
      const actual = depth / passes;
      const values = [];
      for (let i = 1; i <= passes; i += 1) values.push(`-${(actual * i).toFixed(2)}`);
      label.textContent = passes === 1
        ? t('passes.calcOne', { values: values.join(', ') })
        : t('passes.calcMany', { count: passes, values: values.join(', ') });
    } else {
      label.textContent = t('passes.one');
    }
  }

  function onParamChange() {
    updatePassesInfo();
    schedulePreview();
    simView.setToolDiameter(Number($('toolDiameter').value));
  }

  // ---------------------------------------------------------------------------
  // Menú nativo
  // ---------------------------------------------------------------------------

  function handleMenu(action) {
    switch (action) {
      case 'open-dxf': openDxf(); break;
      case 'reload-dxf': reloadDxf(); break;
      case 'save-gcode': saveGcode(); break;
      case 'export-report': exportReport(); break;
      case 'load-example': loadExample(); break;
      case 'generate': generate(); break;
      case 'show-safety': showSafety(); break;
      case 'fit-cad': switchTab('cad'); cadView.fit(); break;
      case 'tab-cad': switchTab('cad'); break;
      case 'tab-gcode': switchTab('gcode'); break;
      case 'tab-sim': switchTab('sim'); break;
      case 'show-help': showHelp(); break;
      case 'show-about': showAbout(); break;
      case 'open-examples': window.api.openExamples(); break;
      default: break;
    }
  }

  // ---------------------------------------------------------------------------
  // Idioma
  // ---------------------------------------------------------------------------

  /** Reconstruye el selector de cero pieza conservando el valor elegido. */
  function rebuildZeroSelect() {
    const select = $('workZero');
    if (!select || !state.info) return;
    const current = select.value || state.info.defaults.workZero;
    select.textContent = '';
    for (const mode of state.info.zeroModes) {
      const option = document.createElement('option');
      option.value = mode.value;
      option.textContent = mode.label;
      select.appendChild(option);
    }
    select.value = current;
  }

  /** Rellena los selectores que no dependen del idioma. */
  function fillPostProfiles(info) {
    const postSelect = $('postProfile');
    for (const profile of info.postProfiles) {
      const option = document.createElement('option');
      option.value = profile;
      option.textContent = profile;
      postSelect.appendChild(option);
    }
  }

  /**
   * Aplica un diccionario de idioma y repinta todo lo dinámico.
   * @param {{language?:string, messages?:Object, languages?:Array, operationLabels?:Object,
   *   operationDescriptions?:Object, zeroModes?:Array}} payload
   */
  function applyLanguage(payload = {}) {
    I18n.setLanguage(payload);
    if (Array.isArray(payload.languages)) state.languages = payload.languages;

    if (state.info) {
      if (payload.operationLabels) state.info.operationLabels = payload.operationLabels;
      if (payload.operationDescriptions) {
        state.info.operationDescriptions = payload.operationDescriptions;
      }
      if (payload.zeroModes) state.info.zeroModes = payload.zeroModes;
    }

    I18n.apply();                 // Textos estáticos del HTML.
    rebuildZeroSelect();
    renderLayers();
    updateModalCodesSummary();
    updatePassesInfo();
    setStatus(state.statusKey, state.statusVars);
    setSafety(state.safety ? state.safety.status : null);
    setBusy(state.busy);
    renderStats();
    updateWindowTitle();

    if (state.fileInfoVars) {
      $('fileInfo').textContent = t('fileInfo.loaded', state.fileInfoVars);
    }

    if (cadView) cadView.draw();
    if (simView) {
      simView.updateTelemetry();
      simView.draw();
    }
  }

  // ---------------------------------------------------------------------------
  // Inicialización
  // ---------------------------------------------------------------------------

  function bindEvents() {
    $('btnOpen').addEventListener('click', openDxf);
    $('btnReload').addEventListener('click', reloadDxf);
    $('btnGenerate').addEventListener('click', generate);
    $('btnSaveGcode').addEventListener('click', saveGcode);
    $('btnSaveGcode2').addEventListener('click', saveGcode);
    $('btnSafety').addEventListener('click', showSafety);
    $('btnCopyGcode').addEventListener('click', copyGcode);

    $('cadZoomIn').addEventListener('click', () => cadView.zoomBy(1.25));
    $('cadZoomOut').addEventListener('click', () => cadView.zoomBy(1 / 1.25));
    $('cadFit').addEventListener('click', () => cadView.fit());
    $('showToolpaths').addEventListener('change', (event) => {
      cadView.setShowToolpaths(event.target.checked);
    });

    for (const field of NUMERIC_FIELDS) {
      const input = $(field);
      if (input) input.addEventListener('input', onParamChange);
    }
    $('tabsEnabled').addEventListener('change', onParamChange);
    $('twoDMode').addEventListener('change', () => {
      applyTwoDModeUI();
      onParamChange();
    });
    $('workZero').addEventListener('change', onParamChange);
    $('postProfile').addEventListener('change', onParamChange);

    $('btnModalCodes').addEventListener('click', openModalCodes);
    $('modalCodesApply').addEventListener('click', applyModalCodes);
    $('modalCodesCancel').addEventListener('click', closeModalCodes);
    $('modalCodesClose').addEventListener('click', closeModalCodes);
    $('modalCodes').addEventListener('click', (event) => {
      if (event.target.id === 'modalCodes') closeModalCodes();
    });

    for (const tab of document.querySelectorAll('.tab')) {
      tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    }

    $('simStart').addEventListener('click', () => simView.play());
    $('simPause').addEventListener('click', () => simView.pause());
    $('simStop').addEventListener('click', () => simView.stop());
    $('simStep').addEventListener('click', () => simView.step());
    $('simReset').addEventListener('click', () => simView.reset());

    $('modalClose').addEventListener('click', hideModal);
    $('modalOk').addEventListener('click', hideModal);
    $('modal').addEventListener('click', (event) => {
      if (event.target.id === 'modal') hideModal();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      hideModal();
      closeModalCodes();
    });

    window.addEventListener('resize', debounce(() => {
      cadView.draw();
      simView.draw();
    }, 120));

    window.api.onMenuAction(handleMenu);
    if (typeof window.api.onLanguageChange === 'function') {
      window.api.onLanguageChange((payload) => applyLanguage(payload));
    }
  }

  async function init() {
    const info = await window.api.info();
    state.info = info;
    state.languages = info.languages || [];

    // Idioma primero: deja los diccionarios listos para cualquier texto.
    applyLanguage({
      language: info.language,
      messages: info.messages,
      languages: info.languages,
      operationLabels: info.operationLabels,
      operationDescriptions: info.operationDescriptions,
      zeroModes: info.zeroModes,
    });

    fillPostProfiles(info);
    rebuildZeroSelect();
    state.modalCodes = { ...EMPTY_MODAL_CODES, ...(info.defaultModalCodes || {}) };
    writeModalCodesForm();
    updateModalCodesSummary();
    writeParams(info.defaults);
    updatePassesInfo();

    cadView = new window.CadView($('cadCanvas'), $('cadCoords'));
    simView = new window.SimView({
      canvas: $('simCanvas'),
      codeList: $('simCodeList'),
      hint: $('simHint'),
      telemetry: $('simTelemetry'),
      progress: $('simProgress'),
      speed: $('simSpeed'),
      onStateChange: ({ running }) => {
        $('simStart').disabled = running && !simView.paused;
        $('simPause').disabled = !running || simView.paused;
      },
    });

    bindEvents();

    if (info.hasExample) {
      await loadExample();
    } else {
      $('cadHint').classList.remove('hidden');
    }

    cadView.draw();

    // Traza de arranque: útil para diagnosticar problemas de carga en campo.
    console.info(
      `APP_READY v${info.version} · lang=${I18n.language}`
      + ` · entidades=${state.payload ? state.payload.entityCount : 0}`
      + ` · capas=${Object.keys(state.layerConfigs).length}`,
    );
  }

  let booted = false;

  window.addEventListener('DOMContentLoaded', () => {
    // Protección ante un doble evento de carga en entornos embebidos.
    if (booted) return;
    booted = true;
    init().catch((error) => {
      console.error(error);
      window.U.toast(t('toast.initError', { message: error.message }), 'error', 8000);
    });
  });
}());
