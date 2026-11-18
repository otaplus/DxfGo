'use strict';

/**
 * Postprocesadores: formateo del código G para cada controlador CNC.
 * Réplica exacta del comportamiento de cad_cam_core/postprocessor.py.
 */
class PostProcessor {
  constructor(profileName = 'GRBL / Candle', precision = 3) {
    this.profileName = profileName;
    this.precision = precision;
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
    const lines = [];
    const name = params.program_name || 'CNC_PROGRAM';
    const safeZ = this.formatCoord(params.safe_z !== undefined ? params.safe_z : 5.0);
    const rpm = Math.trunc(params.spindle_rpm !== undefined ? params.spindle_rpm : 12000);
    const dwell = params.spindle_dwell !== undefined ? params.spindle_dwell : 1.5;
    const coolant = params.coolant || 'none';

    lines.push('; ==========================================');
    lines.push(`; Programa: ${name}`);
    lines.push(`; Postprocesador: ${this.profileName}`);
    lines.push(`; Herramienta: D=${this.formatValue(params.tool_diameter !== undefined ? params.tool_diameter : 3.175)}mm`);
    lines.push(`; Profundidad Total: ${this.formatValue(params.target_depth !== undefined ? params.target_depth : -3.0)}mm`);
    lines.push(`; Avance Corte: ${this.formatValue(params.cut_feed !== undefined ? params.cut_feed : 800)} mm/min`);
    lines.push(`; Avance Penetración: ${this.formatValue(params.plunge_feed !== undefined ? params.plunge_feed : 250)} mm/min`);
    lines.push('; ==========================================');

    switch (this.profileName) {
      case 'GRBL / Candle':
        lines.push('G21 ; Unidades en milímetros (mm)');
        lines.push('G90 ; Coordenadas absolutas');
        lines.push('G17 ; Plano de trabajo XY');
        lines.push(`G0 Z${safeZ} ; Posición de seguridad inicial`);
        lines.push(`M3 S${rpm} ; Encender husillo horario`);
        if (dwell > 0) lines.push(`G4 P${Number(dwell).toFixed(1)} ; Espera para alcanzar RPM`);
        if (coolant === 'flood') lines.push('M8 ; Refrigerante encendido');
        break;

      case 'Mach3 / Mach4':
        lines.push('G21 G90 G17 G40 G49 G80');
        lines.push('T1 M6 ; Cambio a herramienta 1');
        lines.push(`G0 Z${safeZ}`);
        lines.push(`M3 S${rpm}`);
        if (dwell > 0) lines.push(`G4 P${Number(dwell).toFixed(1)}`);
        if (coolant === 'flood') lines.push('M8');
        break;

      case 'LinuxCNC':
        lines.push('G21 G90 G17 G64 P0.02 ; Control de trayectoria continuo');
        lines.push(`G0 Z${safeZ}`);
        lines.push(`M3 S${rpm}`);
        if (dwell > 0) lines.push(`G4 P${Number(dwell).toFixed(1)}`);
        break;

      case 'Marlin CNC':
        lines.push('G21 ; mm');
        lines.push('G90 ; absoluto');
        lines.push(`G0 Z${safeZ}`);
        lines.push(`M3 S${rpm}`);
        break;

      case 'Láser / Plasma 2D':
        lines.push('G21 ; mm');
        lines.push('G90 ; absoluto');
        lines.push('M5 ; Láser apagado para inicio seguro');
        lines.push(`G0 Z${safeZ}`);
        break;

      default: // Genérico ISO
        lines.push('G21 G90 G17');
        lines.push(`G0 Z${safeZ}`);
        lines.push(`M3 S${rpm}`);
        break;
    }

    return lines;
  }

  /** Líneas de pie de programa. */
  getFooter(params = {}) {
    const lines = [];
    const safeZ = this.formatCoord(params.safe_z !== undefined ? params.safe_z : 5.0);
    const coolant = params.coolant || 'none';

    lines.push('; ==========================================');
    lines.push('; Fin de operaciones de mecanizado');
    lines.push('; ==========================================');
    lines.push(`G0 Z${safeZ} ; Retracción obligatoria a Z seguro`);
    if (coolant === 'flood') lines.push('M9 ; Apagar refrigerante');
    lines.push('M5 ; Apagar husillo / antorcha');
    lines.push('G0 X0 Y0 ; Retorno a origen de pieza');
    lines.push('M30 ; Fin de programa CNC');

    return lines;
  }
}

module.exports = { PostProcessor };
