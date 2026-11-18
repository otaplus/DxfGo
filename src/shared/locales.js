'use strict';

/**
 * Carga de idiomas desde la carpeta `locales/`.
 *
 * Cada idioma es un archivo de texto `<código>.txt` con pares `clave=valor`.
 * Las líneas que empiezan por `#` son comentarios y las que empiezan por `+`
 * continúan el valor de la clave anterior (útil para textos de varias líneas).
 *
 * El proceso principal lee esta carpeta al arrancar y ofrece en el menú todos
 * los idiomas encontrados. El renderer recibe el diccionario ya resuelto por
 * IPC, de modo que no necesita acceso al sistema de archivos.
 */

const fs = require('fs');
const path = require('path');

/** Idioma de referencia y respaldo cuando falta una traducción. */
const DEFAULT_LANGUAGE = 'es';

/**
 * Sustituye marcadores `{nombre}` en una plantilla.
 * @param {string} template
 * @param {Object<string, unknown>} [vars]
 * @returns {string}
 */
function formatTemplate(template, vars = {}) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match
  ));
}

/**
 * Convierte el contenido de un archivo de idioma en un diccionario.
 * @param {string} text
 * @param {string} code
 * @returns {{code:string, name:string, messages:Object<string,string>}}
 */
function parseLocaleText(text, code) {
  const messages = {};
  let currentKey = null;

  const lines = String(text == null ? '' : text)
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Continuación del valor anterior.
    if (trimmed.startsWith('+') && currentKey) {
      messages[currentKey] += `\n${trimmed.slice(1)}`;
      continue;
    }

    const separator = line.indexOf('=');
    if (separator < 0) continue;

    const key = line.slice(0, separator).trim();
    if (!key) continue;

    messages[key] = line.slice(separator + 1).trim();
    currentKey = key;
  }

  return {
    code,
    name: messages['meta.name'] || code,
    messages,
  };
}

/**
 * Lee todos los archivos `.txt` de una carpeta y devuelve los idiomas válidos.
 * @param {string} dir Carpeta que contiene los archivos de idioma.
 * @returns {Array<{code:string,name:string,messages:Object<string,string>}>}
 */
function loadLocalesFromDir(dir) {
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch (error) {
    return [];
  }

  const byCode = new Map();
  for (const file of files.filter((name) => name.toLowerCase().endsWith('.txt')).sort()) {
    try {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      const code = path.basename(file, path.extname(file)).toLowerCase();
      const language = parseLocaleText(text, code);
      if (Object.keys(language.messages).length) byCode.set(code, language);
    } catch (error) {
      // Un archivo de idioma ilegible no debe impedir el arranque.
    }
  }

  const languages = Array.from(byCode.values());
  languages.sort((a, b) => {
    if (a.code === DEFAULT_LANGUAGE) return -1;
    if (b.code === DEFAULT_LANGUAGE) return 1;
    return a.name.localeCompare(b.name);
  });
  return languages;
}

/**
 * Lee la carpeta `locales/` situada dentro de `baseDir`.
 * @param {string} baseDir
 */
function loadLocales(baseDir) {
  return loadLocalesFromDir(path.join(baseDir, 'locales'));
}

// Diccionarios de respaldo cargados desde el propio proyecto. Se usan cuando
// el núcleo CAM se ejecuta sin que el proceso principal le pase los mensajes
// (por ejemplo, en pruebas unitarias).
let builtinCache = null;

/** @returns {Object<string, Object<string,string>>} */
function builtinCatalog() {
  if (!builtinCache) {
    builtinCache = {};
    const languages = loadLocales(path.join(__dirname, '..', '..'));
    for (const language of languages) builtinCache[language.code] = language.messages;
    if (!builtinCache[DEFAULT_LANGUAGE]) builtinCache[DEFAULT_LANGUAGE] = {};
  }
  return builtinCache;
}

/**
 * Devuelve el diccionario de un idioma, cargado del proyecto si es necesario.
 * @param {string} [language]
 * @returns {Object<string,string>}
 */
function builtinMessages(language = DEFAULT_LANGUAGE) {
  const catalog = builtinCatalog();
  return catalog[language] || catalog[DEFAULT_LANGUAGE] || {};
}

/**
 * Traduce una clave. Si falta en el idioma actual, usa el español.
 * @param {string} language
 * @param {string} key
 * @param {Object<string, unknown>} [vars]
 * @param {Object<string,string>} [messages] Diccionario opcional ya cargado.
 * @returns {string}
 */
function translate(language, key, vars, messages) {
  const current = messages || builtinMessages(language);
  let template = current[key];
  if (template === undefined) template = builtinMessages(DEFAULT_LANGUAGE)[key];
  if (template === undefined) return key;
  return formatTemplate(template, vars);
}

/**
 * Crea una función de traducción ligada a un idioma.
 * @param {string} [language]
 * @param {Object<string,string>} [messages]
 * @returns {(key:string, vars?:Object<string, unknown>) => string}
 */
function translator(language = DEFAULT_LANGUAGE, messages) {
  return (key, vars) => translate(language, key, vars, messages);
}

module.exports = {
  DEFAULT_LANGUAGE,
  formatTemplate,
  parseLocaleText,
  loadLocalesFromDir,
  loadLocales,
  builtinMessages,
  translate,
  translator,
};
