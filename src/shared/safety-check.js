'use strict';

/**
 * Verificador de seguridad pre-vuelo.
 * Réplica exacta de cad_cam_core/safety_check.py.
 *
 * Reglas comprobadas:
 *  1. Ningún movimiento rápido G0 en XY por debajo de Z Seguro.
 *  2. El husillo debe estar encendido (M3) antes de entrar en material.
 *  3. La penetración en Z no puede superar 1,5x el avance de penetración seguro.
 *  4. No se puede exceder la profundidad objetivo.
 *  5. El programa debe terminar con M5 y la herramienta retraída.
 */

const M3_RE = /\bM0?3\b/;
const M5_RE = /\bM0?5\b/;
const S_RE = /S(\d+)/;
const F_RE = /F([-+]?[\d.]+)/;
const X_RE = /X([-+]?[\d.]+)/;
const Y_RE = /Y([-+]?[\d.]+)/;
const Z_RE = /Z([-+]?[\d.]+)/;

class SafetyChecker {
  /**
   * @param {string} gcodeText Programa G completo.
   * @param {number} safeZ Altura de seguridad configurada.
   * @param {number} targetDepth Profundidad objetivo.
   * @param {number} maxPlungeFeed Avance de penetración considerado seguro.
   * @returns {{status:string, errors:string[], warnings:string[], minZ:number, maxZ:number, reportText:string}}
   */
  static verifyGcode(gcodeText, safeZ, targetDepth, maxPlungeFeed) {
    const lines = String(gcodeText || '').split('\n');

    const errors = [];
    const warnings = [];

    let currentX = 0.0;
    let currentY = 0.0;
    let currentZ = safeZ;
    let currentFeed = 0.0;
    let spindleOn = false;
    let spindleSpeed = 0;
    let minZ = safeZ;
    let maxZ = safeZ;
    let rapidMoves = 0;
    let cutMoves = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const lineNum = i + 1;
      const line = lines[i].trim();
      if (!line || line.startsWith(';')) continue;

      const lineUpper = line.toUpperCase();

      // Estado del husillo (regex con límites para que M30 no active M3).
      if (M3_RE.test(lineUpper)) {
        spindleOn = true;
        const sMatch = lineUpper.match(S_RE);
        if (sMatch) spindleSpeed = parseInt(sMatch[1], 10);
      } else if (M5_RE.test(lineUpper)) {
        spindleOn = false;
      }

      // Avance.
      const fMatch = lineUpper.match(F_RE);
      if (fMatch) currentFeed = parseFloat(fMatch[1]);

      // Coordenadas.
      const xMatch = lineUpper.match(X_RE);
      const yMatch = lineUpper.match(Y_RE);
      const zMatch = lineUpper.match(Z_RE);

      const newX = xMatch ? parseFloat(xMatch[1]) : currentX;
      const newY = yMatch ? parseFloat(yMatch[1]) : currentY;
      const newZ = zMatch ? parseFloat(zMatch[1]) : currentZ;

      const isG0 = lineUpper.includes('G0 ') || lineUpper.includes('G00 ')
        || lineUpper.startsWith('G0') || lineUpper.startsWith('G00');
      const isG1 = lineUpper.includes('G1 ') || lineUpper.includes('G01 ')
        || lineUpper.startsWith('G1') || lineUpper.startsWith('G01');
      const isG2 = lineUpper.includes('G2 ') || lineUpper.includes('G02 ');
      const isG3 = lineUpper.includes('G3 ') || lineUpper.includes('G03 ');

      if (isG0) {
        rapidMoves += 1;
        // REGLA CRÍTICA 1.
        const xyMoved = Math.abs(newX - currentX) > 0.001 || Math.abs(newY - currentY) > 0.001;
        if (xyMoved && currentZ < safeZ - 0.01) {
          errors.push(
            `Línea ${lineNum}: Movimiento rápido G0 en XY a Z=${currentZ.toFixed(3)}mm `
            + `(por debajo de Z Seguro ${safeZ}mm). Peligro de colisión.`,
          );
        }
      }

      if (isG1 || isG2 || isG3) {
        cutMoves += 1;
        // REGLA CRÍTICA 2.
        if (newZ < -0.001 && !spindleOn) {
          warnings.push(
            `Línea ${lineNum}: Corte a Z=${newZ.toFixed(3)}mm sin comando M3 previo o con husillo apagado.`,
          );
        }
        // REGLA CRÍTICA 3.
        if (newZ < currentZ && currentFeed > maxPlungeFeed * 1.5) {
          warnings.push(
            `Línea ${lineNum}: Penetración en Z con avance F${currentFeed.toFixed(1)} `
            + `mayor al límite seguro (${maxPlungeFeed.toFixed(1)} mm/min).`,
          );
        }
      }

      currentX = newX;
      currentY = newY;
      currentZ = newZ;
      minZ = Math.min(minZ, currentZ);
      maxZ = Math.max(maxZ, currentZ);
    }

    // REGLA CRÍTICA 4.
    if (minZ < targetDepth - 0.05) {
      errors.push(
        `Profundidad mínima alcanzada (${minZ.toFixed(3)}mm) excede la profundidad objetivo (${targetDepth.toFixed(3)}mm).`,
      );
    }

    // REGLA CRÍTICA 5.
    if (spindleOn) {
      warnings.push('El programa no incluye comando M5 para apagar el husillo al finalizar.');
    }
    if (currentZ < safeZ - 0.01) {
      warnings.push(`El programa no finaliza con la herramienta retraída a Z seguro (${safeZ}mm).`);
    }

    let status = 'SEGURO';
    if (warnings.length) status = 'ADVERTENCIA';
    if (errors.length) status = 'PELIGRO';

    const reportLines = [
      '=== INFORME DE SEGURIDAD CNC ===',
      `Estado general: ${status}`,
      `Z Seguro configurado: ${safeZ.toFixed(2)} mm | Z Máximo alcanzado: ${maxZ.toFixed(2)} mm`,
      `Z Objetivo: ${targetDepth.toFixed(2)} mm | Z Mínimo alcanzado: ${minZ.toFixed(2)} mm`,
      `Movimientos rápidos G0: ${rapidMoves} | Movimientos de corte: ${cutMoves}`,
    ];

    if (!errors.length && !warnings.length) {
      reportLines.push('[OK] Todas las comprobaciones de colisión y cotas superadas con éxito.');
    } else {
      if (errors.length) {
        reportLines.push('');
        reportLines.push('ERRORES CRÍTICOS:');
        for (const e of errors) reportLines.push(` [ERROR] ${e}`);
      }
      if (warnings.length) {
        reportLines.push('');
        reportLines.push('ADVERTENCIAS:');
        for (const w of warnings) reportLines.push(` [AVISO] ${w}`);
      }
    }

    return {
      status,
      errors,
      warnings,
      minZ,
      maxZ,
      spindleSpeed,
      rapidMoves,
      cutMoves,
      reportText: reportLines.join('\n'),
    };
  }
}

module.exports = { SafetyChecker };
