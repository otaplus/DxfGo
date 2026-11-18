'use strict';

/**
 * Inyección de códigos modales definidos por el usuario.
 *
 * Permite insertar fragmentos de G-Code antes y después de cada movimiento
 * rápido (G00) y de cada interpolación circular (G02/G03). Es habitual en
 * oxicorte: el oxígeno se apaga antes de un rápido y se vuelve a encender
 * después, sin necesidad de mover el eje Z.
 */

/** Longitud máxima aceptada por cada fragmento (caracteres). */
const MAX_SNIPPET_LENGTH = 4000;

/** Fragmentos vacíos por defecto. */
const DEFAULT_MODAL_CODES = {
  beforeG0: '',
  afterG0: '',
  beforeArc: '',
  afterArc: '',
};

/** Movimiento rápido G0/G00, incluso pegado a otras palabras (G0X10). */
const RAPID_RE = /(?:^|\s)G0?0(?=[\sA-Z]|$)/;

/** Interpolación circular G2/G02/G3/G03. */
const ARC_RE = /(?:^|\s)G0?[23](?=[\sA-Z]|$)/;

/** Cualquier movimiento que deba existir en el programa. */
const MOTION_RE = /(?:^|\s)G0?[0-3](?=[\sA-Z]|$)/;

/**
 * Devuelve solo la parte de comando de una línea, sin comentarios `;` ni `( )`.
 * @param {string} line
 */
function commandText(line) {
  let text = String(line == null ? '' : line);
  const semicolon = text.indexOf(';');
  if (semicolon >= 0) text = text.slice(0, semicolon);
  text = text.replace(/\([^)]*\)/g, ' ');
  return text.trim().toUpperCase();
}

/** Indica si la línea contiene un G0/G00. */
function isRapid(line) {
  return RAPID_RE.test(commandText(line));
}

/** Indica si la línea contiene un G2/G02/G3/G03. */
function isArc(line) {
  return ARC_RE.test(commandText(line));
}

/** Indica si la línea contiene un movimiento G0-G3. */
function isMotion(line) {
  return MOTION_RE.test(commandText(line));
}

/** Normaliza un fragmento: sin CR, sin espacios finales y sin líneas vacías. */
function normalizeSnippet(value) {
  return String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.length > 0)
    .join('\n');
}

/** Sanitiza los cuatro fragmentos recibidos desde la interfaz. */
function sanitizeModalCodes(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    beforeG0: normalizeSnippet(source.beforeG0).slice(0, MAX_SNIPPET_LENGTH),
    afterG0: normalizeSnippet(source.afterG0).slice(0, MAX_SNIPPET_LENGTH),
    beforeArc: normalizeSnippet(source.beforeArc).slice(0, MAX_SNIPPET_LENGTH),
    afterArc: normalizeSnippet(source.afterArc).slice(0, MAX_SNIPPET_LENGTH),
  };
}

/** Convierte un fragmento en líneas listas para insertar. */
function snippetLines(value) {
  const text = normalizeSnippet(value);
  return text ? text.split('\n') : [];
}

/**
 * Inserta los fragmentos del usuario alrededor de los movimientos indicados.
 *
 * Los fragmentos se insertan una sola vez por línea, sin procesar los propios
 * fragmentos (evita recursión si contienen G0/G2/G3).
 *
 * @param {string} gcode Programa generado.
 * @param {{beforeG0?:string, afterG0?:string, beforeArc?:string, afterArc?:string}} snippets
 * @returns {string}
 */
function injectModalCodes(gcode, snippets = {}) {
  const codes = sanitizeModalCodes(snippets);
  const beforeG0 = snippetLines(codes.beforeG0);
  const afterG0 = snippetLines(codes.afterG0);
  const beforeArc = snippetLines(codes.beforeArc);
  const afterArc = snippetLines(codes.afterArc);

  const hasAny = beforeG0.length || afterG0.length || beforeArc.length || afterArc.length;
  if (!hasAny) return String(gcode == null ? '' : gcode);

  const output = [];
  const lines = String(gcode == null ? '' : gcode).replace(/\r\n?/g, '\n').split('\n');

  // El pie del programa (retorno a origen y M30) no dispara códigos modales:
  // así no se reactiva el oxígeno después del apagado final.
  let inFooter = false;

  for (const line of lines) {
    if (!inFooter && /^;\s*Fin de operaciones de mecanizado/i.test(line.trim())) {
      inFooter = true;
    }

    if (inFooter) {
      output.push(line);
      continue;
    }

    const command = commandText(line);
    const rapid = RAPID_RE.test(command);
    const arc = ARC_RE.test(command);

    if (rapid) output.push(...beforeG0);
    if (arc) output.push(...beforeArc);

    output.push(line);

    if (rapid) output.push(...afterG0);
    if (arc) output.push(...afterArc);
  }

  return output.join('\n');
}

module.exports = {
  DEFAULT_MODAL_CODES,
  MAX_SNIPPET_LENGTH,
  commandText,
  isRapid,
  isArc,
  isMotion,
  sanitizeModalCodes,
  injectModalCodes,
};
