'use strict';

/**
 * Punto de entrada de las pruebas: `npm test`.
 */

const { runAll } = require('./harness');

console.log('CAD-CAM 2D CNC · pruebas automatizadas');
console.log('');

require('./core.test');
require('./main.test');
require('./renderer.test');

runAll('Resultado').then((code) => {
  process.exit(code);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
