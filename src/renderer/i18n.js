'use strict';

/**
 * Traducción de la interfaz en el renderer.
 *
 * El proceso principal envía el diccionario del idioma activo ya resuelto por
 * IPC. Este módulo solo guarda los textos, sustituye marcadores `{nombre}` y
 * aplica las traducciones declaradas en el HTML mediante atributos:
 *
 *   data-i18n="clave"            -> textContent
 *   data-i18n-title="clave"      -> title
 *   data-i18n-placeholder="clave"-> placeholder
 *   data-i18n-aria-label="clave" -> aria-label
 *
 * Se expone como `window.I18n`.
 */

(function attachI18n() {
  const state = {
    language: 'es',
    messages: {},
    languages: [],
  };

  /**
   * Sustituye los marcadores `{nombre}` de una plantilla.
   * @param {string} template
   * @param {Object<string, unknown>} [vars]
   * @returns {string}
   */
  function format(template, vars = {}) {
    return String(template).replace(/\{(\w+)\}/g, (match, key) => (
      vars && Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match
    ));
  }

  /**
   * Traduce una clave. Si no existe devuelve la propia clave, de modo que un
   * archivo de idioma incompleto sea evidente pero no rompa la aplicación.
   * @param {string} key
   * @param {Object<string, unknown>} [vars]
   * @returns {string}
   */
  function t(key, vars) {
    const template = state.messages[key];
    if (template === undefined) return key;
    return format(template, vars);
  }

  /**
   * Actualiza el idioma activo y su diccionario.
   * @param {{language?:string, messages?:Object<string,string>, languages?:Array}} payload
   */
  function setLanguage(payload = {}) {
    if (typeof payload.language === 'string') state.language = payload.language;
    if (payload.messages && typeof payload.messages === 'object') {
      state.messages = payload.messages;
    }
    if (Array.isArray(payload.languages)) state.languages = payload.languages;
    document.documentElement.lang = state.language;
  }

  /**
   * Aplica las traducciones a los elementos marcados del documento.
   * @param {ParentNode} [root]
   */
  function apply(root = document) {
    const attributes = [
      ['data-i18n', 'textContent'],
      ['data-i18n-title', 'title'],
      ['data-i18n-placeholder', 'placeholder'],
      ['data-i18n-aria-label', 'aria-label'],
    ];

    for (const [attribute, property] of attributes) {
      for (const element of root.querySelectorAll(`[${attribute}]`)) {
        const key = element.getAttribute(attribute);
        if (!key) continue;
        element[property] = t(key);
      }
    }
  }

  window.I18n = {
    t,
    format,
    apply,
    setLanguage,
    get language() { return state.language; },
    get languages() { return state.languages; },
    get messages() { return state.messages; },
  };
}());
