'use strict';

/**
 * Corredor de pruebas mínimo (sin dependencias externas).
 * Las suites se registran con `test(name, fn)` y se ejecutan al final.
 */

const tests = [];

/** Registra una prueba. */
function test(name, fn) {
  tests.push({ name, fn });
}

/** Compara dos números con tolerancia. */
function approx(actual, expected, tolerance = 1e-6, message = '') {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    throw new Error(
      `${message || 'valor fuera de tolerancia'}: se esperaba ${expected} ±${tolerance}, se obtuvo ${actual}`,
    );
  }
}

/** Comprueba que una condición se cumple. */
function ok(condition, message = 'condición falsa') {
  if (!condition) throw new Error(message);
}

/** Comprueba que el texto contiene un fragmento. */
function includes(haystack, needle, message = '') {
  if (!String(haystack).includes(needle)) {
    throw new Error(`${message || 'texto no encontrado'}: se esperaba encontrar "${needle}"`);
  }
}

/** Comprueba que el texto NO contiene un fragmento. */
function excludes(haystack, needle, message = '') {
  if (String(haystack).includes(needle)) {
    throw new Error(`${message || 'texto inesperado'}: no debería contener "${needle}"`);
  }
}

/** Ejecuta todas las pruebas registradas. */
async function runAll(title = 'Pruebas') {
  let passed = 0;
  const failures = [];
  const started = Date.now();

  for (const { name, fn } of tests) {
    const begin = Date.now();
    try {
      await fn();
      passed += 1;
      console.log(`  ✓ ${name} (${Date.now() - begin} ms)`);
    } catch (error) {
      failures.push({ name, error });
      console.log(`  ✗ ${name}`);
      console.log(`      ${String(error.message || error).split('\n')[0]}`);
    }
  }

  console.log('');
  console.log(`${title}: ${passed} correctas, ${failures.length} fallidas (${Date.now() - started} ms)`);

  if (failures.length) {
    console.log('');
    for (const failure of failures) {
      console.log(`FALLO: ${failure.name}`);
      console.log(String(failure.error.stack || failure.error).split('\n').slice(0, 8).join('\n'));
      console.log('');
    }
    return 1;
  }
  return 0;
}

module.exports = {
  test, runAll, approx, ok, includes, excludes,
};
