'use strict';

/**
 * Lógica de la interfaz: formularios, capas, generación de código G y
 * coordinación entre los dos lienzos (visor CAD y simulador).
 */

(function attachApp() {
  const { $, toast, debounce, showModal, hideModal } = window.U;

  /** Campos numéricos del formulario. */
  const NUMERIC_FIELDS = [
    'toolDiameter', 'safeZ', 'retractZ', 'targetDepth', 'stepdown',
    'cutFeed', 'plungeFeed', 'spindleRpm', 'tabCount', 'tabWidth', 'tabHeight',
  ];

  const state = {
    info: null,
    payload: null,
    layerConfigs: {},
    visibility: {},
    gcode: '',
    safety: null,
    stats: null,
    busy: false,
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
    return params;
  }

  /** Vuelca los parámetros al formulario. */
  function writeParams(params) {
    for (const field of NUMERIC_FIELDS) {
      const input = $(field);
      if (input && Number.isFinite(params[field])) input.value = String(params[field]);
    }
    $('tabsEnabled').checked = Boolean(params.tabsEnabled);
  }

  /** Solicitud que entiende el proceso principal. */
  function requestPayload() {
    return { params: readParams(), layerConfigs: state.layerConfigs };
  }

  // ---------------------------------------------------------------------------
  // Interfaz de capas
  // ---------------------------------------------------------------------------

  function renderLayers() {
    const container = $('layerList');
    container.textContent = '';

    const layers = (state.payload ? state.payload.layers : [])
      .filter((layer) => layer.count > 0);

    if (!layers.length) {
      container.appendChild(window.U.el('p', 'hint-text', 'Sin capas con entidades.'));
      return;
    }

    const fragment = document.createDocumentFragment();

    for (const layer of layers) {
      const config = state.layerConfigs[layer.name] || { visible: true, operation: layer.operation };

      const row = window.U.el('div', 'layer-row');

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = config.visible !== false;
      checkbox.title = 'Mostrar u ocultar capa';
      checkbox.addEventListener('change', () => {
        config.visible = checkbox.checked;
        state.visibility[layer.name] = checkbox.checked;
        cadView.setVisibility(state.visibility);
        schedulePreview();
      });

      const dot = window.U.el('span', 'layer-dot');
      dot.style.background = layer.colorHex;

      const name = window.U.el('span', 'layer-name', layer.name);
      name.title = `${layer.name} (${layer.count} entidades)`;

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
      select.title = descriptions[config.operation] || 'Operación CAM de la capa';
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
      ? `${fileName} — CAD-CAM 2D CNC`
      : 'CAD-CAM 2D CNC - Generador de Trayectorias Seguras';
  }

  function applyLoadResult(result) {
    if (!result.ok) {
      if (!result.canceled) toast(result.error || 'No se pudo cargar el archivo.', 'error', 7000);
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

    $('gcodeText').value = '';
    $('gcodeStats').textContent = 'Genere el código G para visualizar estadísticas.';
    setSafety(null);

    const bounds = state.payload.bounds;
    $('fileInfo').textContent = `${state.payload.fileName} · ${bounds.width.toFixed(1)} × `
      + `${bounds.height.toFixed(1)} mm · ${state.payload.entityCount} entidades`;

    const unsupported = Object.entries(state.payload.unsupported || {});
    if (unsupported.length) {
      const detail = unsupported.map(([type, count]) => `${type} (${count})`).join(', ');
      toast(`Entidades no soportadas ignoradas: ${detail}`, 'warn', 6000);
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

    const label = `DXF cargado: ${state.payload.fileName} · `
      + `${state.payload.entityCount} entidades procesables`;
    $('statusText').textContent = label;
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
      toast('No hay ningún DXF cargado.', 'warn');
      return;
    }
    const result = await window.api.reloadDxf();
    if (applyLoadResult(result)) toast('Archivo DXF recargado.', 'ok', 2200);
  }

  async function loadExample() {
    const result = await window.api.loadExample();
    if (applyLoadResult(result)) toast('Ejemplo cargado: ejemplo_pieza.dxf', 'ok', 2600);
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
      badge.textContent = 'Seguridad: sin calcular';
      return;
    }
    const icons = { SEGURO: '✔', ADVERTENCIA: '⚠', PELIGRO: '✖' };
    badge.dataset.status = status;
    badge.textContent = `Seguridad: ${status} ${icons[status] || ''}`.trim();
  }

  function setBusy(busy) {
    state.busy = busy;
    $('btnGenerate').disabled = busy;
    $('btnGenerate').textContent = busy ? '⏳ Generando...' : '🚀 GENERAR G-CODE SEGURO';
  }

  async function generate() {
    if (state.busy) return;
    if (!state.payload) {
      toast('Cargue primero un archivo DXF.', 'warn');
      return;
    }

    setBusy(true);
    try {
      const result = await window.api.generate(requestPayload());
      if (!result.ok) {
        toast(result.error || 'No se pudo generar el código G.', 'error', 7000);
        $('statusText').textContent = 'Error en la generación de código G.';
        return;
      }

      state.gcode = result.gcode;
      state.safety = result.safety;
      state.stats = result.stats;

      $('gcodeText').value = result.gcode;
      $('gcodeText').scrollTop = 0;

      const stats = result.stats;
      $('gcodeStats').textContent = `${stats.totalCommands} bloques · `
        + `corte ${stats.cutDistance} mm · rápido ${stats.rapidDistance} mm · `
        + `${stats.timeTotalMin} min · ${stats.numPasses} pasadas · ${result.safety.status}`;

      setSafety(result.safety.status);

      simView.setData(
        result.sim,
        result.params ? result.params.toolDiameter : 3.175,
        result.params ? result.params.stockSurfaceZ : 0,
      );
      if (result.zero) cadView.setZero(result.zero);

      $('statusText').textContent = `Código G generado · ${stats.totalCommands} bloques · `
        + `${result.safety.status}`;

      const type = result.safety.status === 'PELIGRO' ? 'error'
        : (result.safety.status === 'ADVERTENCIA' ? 'warn' : 'ok');
      toast(`Código G generado con éxito.\n`
        + `• Estado de seguridad: ${result.safety.status}\n`
        + `• Pasadas en Z: ${stats.numPasses}\n`
        + `• Tiempo estimado: ${stats.timeTotalMin} min\n`
        + `• Profundidad Z: ${result.params ? result.params.targetDepth : ''} mm`, type, 5200);

      switchTab('sim');
    } finally {
      setBusy(false);
    }
  }

  async function saveGcode() {
    if (!state.gcode) {
      toast('Genere primero el código G antes de guardar.', 'warn');
      return;
    }
    const result = await window.api.saveGcode(state.gcode);
    if (result.canceled) return;
    if (!result.ok) {
      toast(result.error || 'No se pudo guardar el archivo.', 'error', 6000);
      return;
    }
    const fileName = result.filePath.split(/[\\/]/).pop();
    $('statusText').textContent = `G-Code guardado en ${fileName}`;
    toast(`Archivo guardado:\n${result.filePath}`, 'ok', 4200);
  }

  async function exportReport() {
    if (!state.safety) {
      toast('Genere primero el código G.', 'warn');
      return;
    }
    const result = await window.api.exportReport(state.safety.reportText);
    if (result.canceled) return;
    if (!result.ok) {
      toast(result.error || 'No se pudo exportar el informe.', 'error', 6000);
      return;
    }
    toast(`Informe exportado:\n${result.filePath}`, 'ok', 4200);
  }

  async function copyGcode() {
    if (!state.gcode) {
      toast('No hay código G para copiar.', 'warn');
      return;
    }
    await window.api.copyText(state.gcode);
    toast('Código G copiado al portapapeles.', 'ok', 2200);
  }

  function showSafety() {
    if (!state.safety) {
      toast('Genere primero el código G para inspeccionar su seguridad.', 'warn');
      return;
    }
    const status = state.safety.status;
    showModal('Informe de verificación de seguridad CNC', state.safety.reportText, {
      mono: status !== 'SEGURO',
    });
  }

  // ---------------------------------------------------------------------------
  // Ayuda
  // ---------------------------------------------------------------------------

  const HELP_TEXT = [
    'GUÍA DE TRAYECTORIAS SEGURAS CNC 2D',
    '',
    '1. Planos de seguridad Z',
    '   • Z Seguro (Clearance): altura a la que se ejecutan todos los movimientos',
    '     rápidos G0. Evita mordazas, tornillos y fijaciones.',
    '   • Z Aproximación (Retract): altura intermedia antes de penetrar a avance',
    '     controlado.',
    '',
    '2. Regla Inside-First (interiores primero)',
    '   • El programa detecta agujeros y cajeras interiores y los mecaniza ANTES',
    '     que el perímetro exterior. Si se corta el exterior primero, la pieza se',
    '     suelta y puede causar una colisión.',
    '',
    '3. Pasadas múltiples',
    '   • La profundidad total se reparte en capas uniformes que nunca superan el',
    '     paso por pasada (stepdown), protegiendo la fresa.',
    '',
    '4. Pestañas de sujeción',
    '   • Dejan pequeños puentes de material en la última pasada para evitar que la',
    '     pieza se proyecte al terminar el corte.',
    '',
    '5. Compensación de radio de fresa',
    '   • Perfil exterior: desplaza el filo hacia fuera (+R).',
    '   • Perfil interior: desplaza el filo hacia dentro (-R).',
    '   • Sobre línea: corta directamente sobre el vector (grabado, láser, plasma).',
    '',
    '6. Comprobaciones automáticas antes de volar',
    '   • Ningún G0 en XY por debajo de Z seguro.',
    '   • Husillo encendido (M3) antes de tocar material.',
    '   • Penetración en Z a avance controlado.',
    '   • Profundidad mínima dentro de la programada.',
    '   • Retracción final y apagado (M5).',
  ].join('\n');

  function showHelp() {
    showModal('Guía de trayectorias seguras', HELP_TEXT, { mono: true });
  }

  function showAbout() {
    const info = state.info || { version: '—', electron: '—', platform: '—' };
    showModal(
      'Acerca de',
      `CAD-CAM 2D CNC · Generador de trayectorias seguras\n`
      + `Versión ${info.version}\n\n`
      + 'Suite CAD-CAM multiplataforma construida con Electron.\n'
      + 'Importa DXF (líneas, arcos, círculos, polilíneas con bulges, splines y\n'
      + 'elipses), genera código G con compensación de herramienta, pasadas\n'
      + 'múltiples, pestañas de sujeción y verificación de seguridad previa.\n\n'
      + 'Compatible con GRBL, Candle, CNCjs, UGS, Mach3/4, LinuxCNC, Marlin y\n'
      + 'láser/plasma 2D.\n\n'
      + `Electron ${info.electron} · Plataforma ${info.platform}`,
    );
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

    if (Number.isFinite(depth) && Number.isFinite(stepdown) && stepdown > 0.001 && depth > 0.001) {
      const passes = Math.max(1, Math.ceil(depth / stepdown));
      const actual = depth / passes;
      const values = [];
      for (let i = 1; i <= passes; i += 1) values.push(`-${(actual * i).toFixed(2)}`);
      label.textContent = `Cálculo: ${passes} pasada${passes === 1 ? '' : 's'} en Z (${values.join(', ')} mm)`;
    } else {
      label.textContent = 'Cálculo: 1 pasada';
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
  // Inicialización
  // ---------------------------------------------------------------------------

  function fillSelects(info) {
    const zeroSelect = $('workZero');
    for (const mode of info.zeroModes) {
      const option = document.createElement('option');
      option.value = mode.value;
      option.textContent = mode.label;
      zeroSelect.appendChild(option);
    }

    const postSelect = $('postProfile');
    for (const profile of info.postProfiles) {
      const option = document.createElement('option');
      option.value = profile;
      option.textContent = profile;
      postSelect.appendChild(option);
    }
  }

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
    $('workZero').addEventListener('change', onParamChange);
    $('postProfile').addEventListener('change', onParamChange);

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
      if (event.key === 'Escape') hideModal();
    });

    window.addEventListener('resize', debounce(() => {
      cadView.draw();
      simView.draw();
    }, 120));

    window.api.onMenuAction(handleMenu);
  }

  async function init() {
    const info = await window.api.info();
    state.info = info;

    fillSelects(info);
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
      `APP_READY v${info.version} · entidades=${state.payload ? state.payload.entityCount : 0}`
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
      toast(`Error al iniciar la aplicación: ${error.message}`, 'error', 8000);
    });
  });
}());
