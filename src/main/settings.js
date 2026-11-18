'use strict';

/**
 * Preferencias persistentes de la aplicación.
 *
 * Se guarda un único archivo JSON en la carpeta de datos del usuario
 * (`app.getPath('userData')`). Si el archivo no existe, está corrupto o no se
 * puede escribir, la aplicación sigue funcionando con los valores por defecto:
 * las preferencias nunca deben impedir el arranque.
 */

const fs = require('fs');
const path = require('path');

class Settings {
  /** @param {string} filePath Ruta del archivo JSON de preferencias. */
  constructor(filePath) {
    this.filePath = filePath;
    this.data = this._read();
  }

  /** Lee el archivo; devuelve un objeto vacío si no es legible. */
  _read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      return {};
    }
  }

  /**
   * Devuelve un valor guardado o el valor por defecto.
   * @param {string} key
   * @param {*} [fallback]
   */
  get(key, fallback) {
    return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : fallback;
  }

  /**
   * Guarda un valor y persiste el archivo.
   * @param {string} key
   * @param {*} value
   */
  set(key, value) {
    this.data[key] = value;
    this.save();
  }

  /** Escribe el archivo en disco (crea la carpeta si hace falta). */
  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
      return true;
    } catch (error) {
      return false;
    }
  }
}

module.exports = { Settings };
