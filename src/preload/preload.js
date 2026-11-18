'use strict';

/**
 * Preload: única superficie expuesta al renderer.
 *
 * Se ejecuta aislado (contextIsolation) y sin acceso a Node en la página; la
 * interfaz solo puede llamar a estos métodos.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  /** Información de la aplicación (versiones, rutas, ejemplo incluido). */
  info: () => ipcRenderer.invoke('app:info'),

  /** Abre el diálogo nativo y carga el DXF elegido. */
  openDxf: () => ipcRenderer.invoke('dxf:open'),

  /** Carga un DXF por ruta. */
  loadDxf: (filePath) => ipcRenderer.invoke('dxf:load', filePath),

  /** Recarga el DXF actual. */
  reloadDxf: () => ipcRenderer.invoke('dxf:reload'),

  /** Carga el ejemplo incluido. */
  loadExample: () => ipcRenderer.invoke('dxf:example'),

  /** Previsualización de trayectorias compensadas y pestañas. */
  preview: (request) => ipcRenderer.invoke('cam:preview', request),

  /** Genera el programa G y su verificación de seguridad. */
  generate: (request) => ipcRenderer.invoke('cam:generate', request),

  /** Guarda el código G con diálogo nativo. */
  saveGcode: (content) => ipcRenderer.invoke('file:save-gcode', content),

  /** Exporta el informe de seguridad. */
  exportReport: (content) => ipcRenderer.invoke('file:export-report', content),

  /** Copia texto al portapapeles del sistema. */
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),

  /** Abre la carpeta de ejemplos en el explorador. */
  openExamples: () => ipcRenderer.invoke('shell:open-examples'),

  /** Suscribe acciones del menú nativo. Devuelve la función para desuscribirse. */
  onMenuAction: (callback) => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('menu:action', listener);
    return () => ipcRenderer.removeListener('menu:action', listener);
  },
});
