'use strict';

/**
 * Postprocesadores: formateo del código G para cada controlador CNC.
 * Réplica exacta del comportamiento de cad_cam_core/postprocessor.py.
 *
 * Los comentarios del programa se traducen al idioma activo mediante la función
 * `t` recibida; si no se indica ninguna se usa el español.
 */

const { translator } = require('./locales');

class PostProcessor {
  /**
   * @param {string} [profileName]
   * @param {number} [precision]
   * @param {(key:string, vars?:Object<string, unknown>) => string} [t]
   */
  constructor(profileName = 'GRBL / Candle', precision = 3, t) {
    this.profileName = profileName;
    this.precision = precision;
    this.t = typeof t === 'function' ? t : translator();
  }

  /**
   * Formatea una coordenada con la precisión configurada y sin ceros redundantes.
   */
  formatCoord(value) {
    const text = Number(value).toFixed(this.precision);
    if (!text.includes('.')) return text;
    return text.replace(/0+$/, '').replace(/\.$/, '');
  }

  /**
   * Reproduce la representación decimal de Python usada en la cabecera:
   * los enteros se muestran con un decimal ("800.0") para no cambiar el formato
   * de los programas ya generados.
   */
  formatValue(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return String(value);
    return Number.isInteger(num) ? `${num}.0` : String(num);
  }

  /** Líneas de cabecera del programa. */
  getHeader(params = {}) {
    const { t } = this;
    const lines = [];
    const name = params.program_name || 'CNC_PROGRAM';
    const safeZ = this.formatCoord(params.safe_z !== undefined ? params.safe_z : 5.0);
    const rpm = Math.trunc(params.spindle_rpm !== undefined ? params.spindle_rpm : 12000);
    const dwell = params.spindle_dwell !== undefined ? params.spindle_dwell : 1.5;
    const coolant = params.coolant || 'none';
    // Modo 2D: se omite toda referencia al eje Z (antorchas sin elevación).
    const twoD = Boolean(params.two_d_mode);

    lines.push('; ==========================================');
    lines.push(`; ${t('gcode.header.program', { name })}`);
    lines.push(`; ${t('gcode.header.postprocessor', { profile: this.profileName })}`);
    lines.push(`; ${t('gcode.header.tool', {
      diameter: this.formatValue(params.tool_diameter !== undefined ? params.tool_diameter : 3.175),
    })}`);
    if (twoD) {
      lines.push(`; ${t('gcode.header.mode2d')}`);
    } else {
      lines.push(`; ${t('gcode.header.totalDepth', {
        depth: this.formatValue(params.target_depth !== undefined ? params.target_depth : -3.0),
      })}`);
    }
    lines.push(`; ${t('gcode.header.cutFeed', {
      feed: this.formatValue(params.cut_feed !== undefined ? params.cut_feed : 800),
    })}`);
    if (!twoD) {
      lines.push(`; ${t('gcode.header.plungeFeed', {
        feed: this.formatValue(params.plunge_feed !== undefined ? params.plunge_feed : 250),
      })}`);
    }
    lines.push('; ==========================================');

    switch (this.profileName) {
      case 'GRBL / Candle':
        lines.push(`G21 ; ${t('gcode.header.unitsMm')}`);
        lines.push(`G90 ; ${t('gcode.header.absolute')}`);
        lines.push(`G17 ; ${t('gcode.header.planeXY')}`);
        if (!twoD) lines.push(`G0 Z${safeZ} ; ${t('gcode.header.initialSafe')}`);
        lines.push(`M3 S${rpm} ; ${t('gcode.header.spindleOn')}`);
        if (dwell > 0) lines.push(`G4 P${Number(dwell).toFixed(1)} ; ${t('gcode.header.dwell')}`);
        if (coolant === 'flood') lines.push(`M8 ; ${t('gcode.header.coolantOn')}`);
        break;

      case 'Mach3 / Mach4':
        lines.push('G21 G90 G17 G40 G49 G80');
        lines.push(`T1 M6 ; ${t('gcode.header.toolChange')}`);
        if (!twoD) lines.push(`G0 Z${safeZ}`);
        lines.push(`M3 S${rpm}`);
        if (dwell > 0) lines.push(`G4 P${Number(dwell).toFixed(1)}`);
        if (coolant === 'flood') lines.push('M8');
        break;

      case 'LinuxCNC':
        lines.push(`G21 G90 G17 G64 P0.02 ; ${t('gcode.header.continuous')}`);
        if (!twoD) lines.push(`G0 Z${safeZ}`);
        lines.push(`M3 S${rpm}`);
        if (dwell > 0) lines.push(`G4 P${Number(dwell).toFixed(1)}`);
        break;

      case 'Marlin CNC':
        lines.push(`G21 ; ${t('gcode.header.mm')}`);
        lines.push(`G90 ; ${t('gcode.header.absoluteShort')}`);
        if (!twoD) lines.push(`G0 Z${safeZ}`);
        lines.push(`M3 S${rpm}`);
        break;

      case 'Láser / Plasma 2D':
        lines.push(`G21 ; ${t('gcode.header.mm')}`);
        lines.push(`G90 ; ${t('gcode.header.absoluteShort')}`);
        lines.push(`M5 ; ${t('gcode.header.laserOff')}`);
        if (!twoD) lines.push(`G0 Z${safeZ}`);
        break;

      default: // Genérico ISO
        lines.push('G21 G90 G17');
        if (!twoD) lines.push(`G0 Z${safeZ}`);
        lines.push(`M3 S${rpm}`);
        break;
    }

    return lines;
  }

  /** Líneas de pie de programa. */
  getFooter(params = {}) {
    const { t } = this;
    const lines = [];
    const safeZ = this.formatCoord(params.safe_z !== undefined ? params.safe_z : 5.0);
    const coolant = params.coolant || 'none';
    const twoD = Boolean(params.two_d_mode);

    lines.push('; ==========================================');
    lines.push(`; ${t('gcode.footer.finish')}`);
    lines.push('; ==========================================');
    if (!twoD) lines.push(`G0 Z${safeZ} ; ${t('gcode.footer.retract')}`);
    if (coolant === 'flood') lines.push(`M9 ; ${t('gcode.footer.coolantOff')}`);
    lines.push(`M5 ; ${t('gcode.footer.spindleOff')}`);
    lines.push(`G0 X0 Y0 ; ${t('gcode.footer.returnHome')}`);
    lines.push(`M30 ; ${t('gcode.footer.end')}`);

    return lines;
  }
}

module.exports = { PostProcessor };
