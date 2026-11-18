'use strict';

/**
 * Constantes compartidas por el proceso principal, el núcleo CAD/CAM y el renderer.
 * Mantiene una única fuente de verdad para operaciones, postprocesadores y valores
 * por defecto, de modo que los tests y la interfaz no puedan divergir.
 */

/** Operaciones CAM que se pueden asignar a una capa. */
const OPERATIONS = [
  'PERFIL_EXTERIOR',
  'PERFIL_INTERIOR',
  'SOBRE_LINEA',
  'CAJEADO',
  'TALADRADO',
];

const OPERATION_LABELS = {
  PERFIL_EXTERIOR: 'Perfil exterior +R',
  PERFIL_INTERIOR: 'Perfil interior −R',
  SOBRE_LINEA: 'Sobre línea',
  CAJEADO: 'Cajeado',
  TALADRADO: 'Taladrado',
};

/** Explicación larga de cada operación (se muestra como ayuda contextual). */
const OPERATION_DESCRIPTIONS = {
  PERFIL_EXTERIOR: 'Compensa el filo hacia fuera (+radio) para conservar la medida de la pieza',
  PERFIL_INTERIOR: 'Compensa el filo hacia dentro (−radio) en agujeros y ventanas interiores',
  SOBRE_LINEA: 'Corta sobre el vector: grabado, láser o plasma',
  CAJEADO: 'Pasadas concéntricas hasta vaciar la cajera',
  TALADRADO: 'Ciclo de taladrado en el centro de los círculos',
};

/** Postprocesadores disponibles. */
const POST_PROFILES = [
  'GRBL / Candle',
  'Mach3 / Mach4',
  'LinuxCNC',
  'Marlin CNC',
  'Láser / Plasma 2D',
  'Genérico ISO',
];

/** Modos de cero pieza. */
const ZERO_MODES = [
  { value: 'bottom_left', label: 'Inferior izquierda' },
  { value: 'center', label: 'Centro de la pieza' },
  { value: 'top_left', label: 'Superior izquierda' },
  { value: 'drawing_zero', label: 'Cero del dibujo' },
];

/** Paleta usada para colorear capas en el visor. */
const LAYER_PALETTE = [
  '#00ff00', '#00ffff', '#ffff00', '#ff00ff', '#ff5555',
  '#55ff55', '#5555ff', '#ffffff', '#ff8800', '#00ff88',
];

/** Parámetros CAM por defecto (equivalen a CAMParameters del original). */
const DEFAULT_PARAMS = {
  toolDiameter: 3.175,
  toolType: 'Fresa plana (Endmill)',

  safeZ: 5.0,
  retractZ: 1.5,
  stockSurfaceZ: 0.0,
  targetDepth: -3.0,
  stepdown: 1.5,

  cutFeed: 800.0,
  plungeFeed: 250.0,
  rapidFeed: 2500.0,
  spindleRpm: 12000,
  spindleDwell: 1.5,

  workZero: 'bottom_left',
  customZeroX: 0.0,
  customZeroY: 0.0,

  tabsEnabled: true,
  tabCount: 4,
  tabWidth: 4.0,
  tabHeight: 1.2,

  postProfile: 'GRBL / Candle',
  coolant: 'none',
  laserPower: 1000,
};

/** Límites de seguridad para entradas numéricas de la interfaz. */
const NUMBER_LIMITS = {
  toolDiameter: { min: 0.05, max: 100 },
  safeZ: { min: 0, max: 500 },
  retractZ: { min: -100, max: 500 },
  targetDepth: { min: -500, max: 0 },
  stepdown: { min: 0.01, max: 500 },
  cutFeed: { min: 1, max: 60000 },
  plungeFeed: { min: 1, max: 60000 },
  spindleRpm: { min: 0, max: 100000 },
  tabCount: { min: 1, max: 12 },
  tabWidth: { min: 0.5, max: 200 },
  tabHeight: { min: 0.1, max: 100 },
};

module.exports = {
  OPERATIONS,
  OPERATION_LABELS,
  OPERATION_DESCRIPTIONS,
  POST_PROFILES,
  ZERO_MODES,
  LAYER_PALETTE,
  DEFAULT_PARAMS,
  NUMBER_LIMITS,
};
