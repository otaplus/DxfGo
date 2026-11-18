'use strict';

/**
 * Menú nativo de la aplicación. Cada comando envía una acción al renderer, que
 * es el único que conoce el estado de la interfaz.
 */

const { Menu, app } = require('electron');

/**
 * @param {import('electron').BrowserWindow} win
 * @returns {Electron.Menu}
 */
function buildMenu(win) {
  const send = (action) => {
    if (win && !win.isDestroyed()) win.webContents.send('menu:action', action);
  };

  const template = [
    {
      label: 'Archivo',
      submenu: [
        {
          label: 'Abrir archivo DXF...',
          accelerator: 'CmdOrCtrl+O',
          click: () => send('open-dxf'),
        },
        {
          label: 'Recargar DXF actual',
          accelerator: 'CmdOrCtrl+R',
          click: () => send('reload-dxf'),
        },
        { type: 'separator' },
        {
          label: 'Guardar Código G (.nc, .gcode)...',
          accelerator: 'CmdOrCtrl+S',
          click: () => send('save-gcode'),
        },
        {
          label: 'Exportar Informe de Seguridad...',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => send('export-report'),
        },
        { type: 'separator' },
        {
          label: 'Abrir ejemplo incluido',
          click: () => send('load-example'),
        },
        { type: 'separator' },
        { label: 'Salir', role: 'quit' },
      ],
    },
    {
      label: 'CAM / Herramientas',
      submenu: [
        {
          label: 'Generar Código G Seguro',
          accelerator: 'F5',
          click: () => send('generate'),
        },
        {
          label: 'Verificar Seguridad de Trayectorias',
          accelerator: 'F6',
          click: () => send('show-safety'),
        },
        { type: 'separator' },
        {
          label: 'Centrar Vista CAD',
          accelerator: 'CmdOrCtrl+0',
          click: () => send('fit-cad'),
        },
        { type: 'separator' },
        {
          label: 'Visor CAD',
          accelerator: 'CmdOrCtrl+1',
          click: () => send('tab-cad'),
        },
        {
          label: 'Código G',
          accelerator: 'CmdOrCtrl+2',
          click: () => send('tab-gcode'),
        },
        {
          label: 'Simulador CNC',
          accelerator: 'CmdOrCtrl+3',
          click: () => send('tab-sim'),
        },
      ],
    },
    {
      label: 'Ayuda',
      submenu: [
        {
          label: 'Guía de Trayectorias Seguras',
          accelerator: 'F1',
          click: () => send('show-help'),
        },
        {
          label: 'Acerca de',
          click: () => send('show-about'),
        },
        { type: 'separator' },
        {
          label: 'Abrir carpeta de ejemplos',
          click: () => send('open-examples'),
        },
        {
          label: 'Herramientas de desarrollo',
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
