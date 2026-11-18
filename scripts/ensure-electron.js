'use strict';

/**
 * Garantiza que el binario de Electron esté descargado.
 *
 * Las versiones recientes de npm pueden bloquear el script de instalación de las
 * dependencias (política de `allowScripts`), dejando `node_modules/electron` sin
 * su carpeta `dist`. Este script comprueba el binario y, si falta, ejecuta el
 * instalador oficial de Electron.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');
const distDir = path.join(electronDir, 'dist');

/** Nombre del ejecutable según la plataforma. */
const executable = process.platform === 'win32'
  ? 'electron.exe'
  : (process.platform === 'darwin' ? 'Electron.app' : 'electron');

if (!fs.existsSync(electronDir)) {
  console.log('[electron] La dependencia no está instalada todavía; se omite la comprobación.');
  process.exit(0);
}

if (fs.existsSync(path.join(distDir, executable))) {
  process.exit(0);
}

// El instalador de Electron 45 usa un extractor nativo que exige Node 22.12+.
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 12)) {
  console.warn(`[electron] Node ${process.versions.node} no cumple el requisito de Electron (>=22.12.0).`);
  console.warn('           Actualiza Node.js antes de ejecutar: npm run setup:electron');
}

console.log('[electron] Binario no encontrado: descargando la distribución de Electron...');

try {
  execFileSync(process.execPath, [path.join(electronDir, 'install.js')], {
    stdio: 'inherit',
    env: process.env,
  });
  console.log('[electron] Listo.');
} catch (error) {
  console.warn('[electron] No se pudo descargar el binario automáticamente.');
  console.warn(`           Detalle: ${error.message}`);
  console.warn('           Comprueba la conexión, actualiza Node a 22.12+ y ejecuta:');
  console.warn('           npm run setup:electron');
  // No se falla la instalación: el resto de dependencias sigue siendo válido.
  process.exit(0);
}
