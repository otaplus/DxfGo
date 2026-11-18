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

// Movimientos con límites reales: evita confundir G17/G10 con G1.
const G0_RE = /(?:^|\s)G0?0(?=[\sA-Z]|$)/;
const G1_RE = /(?:^|\s)G0?1(?=[\sA-Z]|$)/;
const G2_RE = /(?:^|\s)G0?2(?=[\sA-Z]|$)/;
const G3_RE = /(?:^|\s)G0?3(?=[\sA-Z]|$)/;

const { translator } = require('./locales');

class SafetyChecker {
  /**
   * @param {string} gcodeText Programa G completo.
   * @param {number} safeZ Altura de seguridad configurada.
   * @param {number} targetDepth Profundidad objetivo.
   * @param {number} maxPlungeFeed Avance de penetración considerado seguro.
   * @param {{twoDMode?:boolean, t?:Function}} [options] Modo 2D (no hay eje Z que
   *   verificar) y función de traducción del informe.
   * @returns {{status:string, errors:string[], warnings:string[], minZ:number, maxZ:number, reportText:string}}
   */
  static verifyGcode(gcodeText, safeZ, targetDepth, maxPlungeFeed, options = {}) {
    const lines = String(gcodeText || '').split('\n');
    const twoD = Boolean(options && options.twoDMode);
    const t = options && typeof options.t === 'function' ? options.t : translator();

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

      const isG0 = G0_RE.test(lineUpper);
      const isG1 = G1_RE.test(lineUpper);
      const isG2 = G2_RE.test(lineUpper);
      const isG3 = G3_RE.test(lineUpper);

      if (isG0) {
        rapidMoves += 1;
        // REGLA CRÍTICA 1 (no aplica en modo 2D: no hay eje Z).
        const xyMoved = Math.abs(newX - currentX) > 0.001 || Math.abs(newY - currentY) > 0.001;
        if (!twoD && xyMoved && currentZ < safeZ - 0.01) {
          errors.push(t('safety.rule.rapidXY', {
            line: lineNum,
            z: currentZ.toFixed(3),
            safe: safeZ,
          }));
        }
      }

      if (isG1 || isG2 || isG3) {
        cutMoves += 1;
        if (!twoD) {
          // REGLA CRÍTICA 2.
          if (newZ < -0.001 && !spindleOn) {
            warnings.push(t('safety.rule.cutNoSpindle', {
              line: lineNum,
              z: newZ.toFixed(3),
            }));
          }
          // REGLA CRÍTICA 3.
          if (newZ < currentZ && currentFeed > maxPlungeFeed * 1.5) {
            warnings.push(t('safety.rule.plungeFeed', {
              line: lineNum,
              feed: currentFeed.toFixed(1),
              limit: maxPlungeFeed.toFixed(1),
            }));
          }
        } else if (!spindleOn) {
          // En modo 2D el encendido de la antorcha sigue siendo obligatorio.
          warnings.push(t('safety.rule.cutNoSpindle2d', { line: lineNum }));
        }
      }

      currentX = newX;
      currentY = newY;
      currentZ = newZ;
      minZ = Math.min(minZ, currentZ);
      maxZ = Math.max(maxZ, currentZ);
    }

    // REGLA CRÍTICA 4 (no aplica en modo 2D).
    if (!twoD && minZ < targetDepth - 0.05) {
      errors.push(t('safety.rule.depth', {
        min: minZ.toFixed(3),
        target: targetDepth.toFixed(3),
      }));
    }

    // REGLA CRÍTICA 5.
    if (spindleOn) {
      warnings.push(t('safety.rule.noM5'));
    }
    if (!twoD && currentZ < safeZ - 0.01) {
      warnings.push(t('safety.rule.notRetracted', { safe: safeZ }));
    }

    let status = 'SEGURO';
    if (warnings.length) status = 'ADVERTENCIA';
    if (errors.length) status = 'PELIGRO';

    const reportLines = [
      t('safety.report.title'),
      t('safety.report.status', { status: t(`safety.${status}`) }),
      t('safety.report.mode', {
        mode: twoD ? t('safety.report.mode2d') : t('safety.report.mode25d'),
      }),
      t('safety.report.moves', { rapid: rapidMoves, cut: cutMoves }),
    ];

    if (twoD) {
      reportLines.push(t('safety.report.ok2d'));
    } else {
      reportLines.push(
        t('safety.report.zsafe', { safe: safeZ.toFixed(2), max: maxZ.toFixed(2) }),
        t('safety.report.ztarget', { target: targetDepth.toFixed(2), min: minZ.toFixed(2) }),
      );
    }

    if (!errors.length && !warnings.length) {
      reportLines.push(t('safety.report.allOk'));
    } else {
      if (errors.length) {
        reportLines.push('');
        reportLines.push(t('safety.report.errors'));
        for (const e of errors) reportLines.push(` [ERROR] ${e}`);
      }
      if (warnings.length) {
        reportLines.push('');
        reportLines.push(t('safety.report.warnings'));
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
