'use strict';

/**
 * Menú nativo de la aplicación. Cada comando envía una acción al renderer, que
 * es el único que conoce el estado de la interfaz.
 *
 * El menú se reconstruye al cambiar de idioma para que sus etiquetas y la lista
 * de idiomas disponibles queden siempre actualizadas.
 */

const { Menu, app } = require('electron');
const { translate, DEFAULT_LANGUAGE } = require('../shared/locales');

/**
 * @param {import('electron').BrowserWindow} win
 * @param {{
 *   language?: string,
 *   languages?: Array<{code:string,name:string}>,
 *   onSelectLanguage?: (code:string) => void,
 * }} [options]
 * @returns {Electron.Menu}
 */
function buildMenu(win, options = {}) {
  const language = options.language || DEFAULT_LANGUAGE;
  const t = typeof options.t === 'function'
    ? options.t
    : (key) => translate(language, key);
  const languages = Array.isArray(options.languages) && options.languages.length
    ? options.languages
    : [{ code: DEFAULT_LANGUAGE, name: 'Español' }];
  const onSelectLanguage = typeof options.onSelectLanguage === 'function'
    ? options.onSelectLanguage
    : () => {};

  const send = (action) => {
    if (win && !win.isDestroyed()) win.webContents.send('menu:action', action);
  };

  const template = [
    {
      label: t('menu.file'),
      submenu: [
        {
          label: t('menu.open'),
          accelerator: 'CmdOrCtrl+O',
          click: () => send('open-dxf'),
        },
        {
          label: t('menu.reload'),
          accelerator: 'CmdOrCtrl+R',
          click: () => send('reload-dxf'),
        },
        { type: 'separator' },
        {
          label: t('menu.save'),
          accelerator: 'CmdOrCtrl+S',
          click: () => send('save-gcode'),
        },
        {
          label: t('menu.exportReport'),
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => send('export-report'),
        },
        { type: 'separator' },
        {
          label: t('menu.loadExample'),
          click: () => send('load-example'),
        },
        { type: 'separator' },
        {
          label: t('menu.language'),
          submenu: languages.map((entry) => ({
            label: entry.name,
            type: 'radio',
            checked: entry.code === language,
            click: () => onSelectLanguage(entry.code),
          })),
        },
        { type: 'separator' },
        { label: t('menu.exit'), role: 'quit' },
      ],
    },
    {
      label: t('menu.cam'),
      submenu: [
        {
          label: t('menu.generate'),
          accelerator: 'F5',
          click: () => send('generate'),
        },
        {
          label: t('menu.safety'),
          accelerator: 'F6',
          click: () => send('show-safety'),
        },
        { type: 'separator' },
        {
          label: t('menu.fit'),
          accelerator: 'CmdOrCtrl+0',
          click: () => send('fit-cad'),
        },
        { type: 'separator' },
        {
          label: t('menu.viewCad'),
          accelerator: 'CmdOrCtrl+1',
          click: () => send('tab-cad'),
        },
        {
          label: t('menu.viewGcode'),
          accelerator: 'CmdOrCtrl+2',
          click: () => send('tab-gcode'),
        },
        {
          label: t('menu.viewSim'),
          accelerator: 'CmdOrCtrl+3',
          click: () => send('tab-sim'),
        },
      ],
    },
    {
      label: t('menu.help'),
      submenu: [
        {
          label: t('menu.guide'),
          accelerator: 'F1',
          click: () => send('show-help'),
        },
        {
          label: t('menu.about'),
          click: () => send('show-about'),
        },
        { type: 'separator' },
        {
          label: t('menu.openExamples'),
          click: () => send('open-examples'),
        },
        {
          label: t('menu.devTools'),
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => {
            if (win && !win.isDestroyed()) win.webContents.toggleDevTools();
          },
        },
      ],
    },
  ];

  // En macOS la primera entrada del menú debe ser el menú de la aplicación.
  if (process.platform === 'darwin') {
    template.unshift({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  return Menu.buildFromTemplate(template);
}

module.exports = { buildMenu };
