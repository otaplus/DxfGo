'use strict';

/**
 * Motor CAM: generación de trayectorias seguras y programa G completo.
 *
 * Traducción de cad_cam_core/cam_engine.py. Mantiene las mismas reglas:
 *  - todo traslado rápido ocurre a Z Seguro,
 *  - interiores antes que el exterior (Inside-First),
 *  - pasadas múltiples en Z sin superar el stepdown,
 *  - penetración a avance controlado,
 *  - pestañas de sujeción modulando Z en la última pasada.
 */

const { GeometryProcessor } = require('./geometry');
const { PostProcessor } = require('./postprocessor');
const { DEFAULT_PARAMS } = require('./constants');

/** Un movimiento de herramienta. */
class ToolpathSegment {
  constructor(cmdType, x, y, z, f, isTab = false) {
    this.cmdType = cmdType; // 'G0' | 'G1'
    this.x = x;
    this.y = y;
    this.z = z;
    this.f = f;
    this.isTab = isTab;
  }
}

/** Parámetros de mecanizado. */
class CAMParameters {
  constructor(overrides = {}) {
    Object.assign(this, DEFAULT_PARAMS, overrides);
  }

  toJSON() {
    return { ...this };
  }
}

/** Motor de generación de código G. */
class CAMEngine {
  constructor(params = new CAMParameters()) {
    this.params = params;
    this.geomProcessor = new GeometryProcessor();
    this.postprocessor = new PostProcessor(this.params.postProfile);
    this.toolpaths = [];
    this.stats = {};
  }

  /**
   * Desplazamiento del cero pieza según la configuración.
   * @param {object} bounds
   * @returns {[number, number]}
   */
  getZeroOffset(bounds) {
    const mode = this.params.workZero;
    const {
      minX, maxX, minY, maxY,
    } = bounds;

    switch (mode) {
      case 'center':
        return [(minX + maxX) / 2.0, (minY + maxY) / 2.0];
      case 'top_left':
        return [minX, maxY];
      case 'bottom_left':
        return [minX, minY];
      case 'custom':
        return [this.params.customZeroX, this.params.customZeroY];
      default: // drawing_zero
        return [0.0, 0.0];
    }
  }

  /**
   * Profundidades de cada pasada, repartidas uniformemente sin superar el stepdown.
   * @returns {number[]}
   */
  calculateZPasses() {
    const totalDepth = Math.abs(this.params.targetDepth - this.params.stockSurfaceZ);
    if (totalDepth <= 0.001 || this.params.stepdown <= 0.001) {
      return [this.params.targetDepth];
    }

    const numPasses = Math.max(1, Math.ceil(totalDepth / this.params.stepdown));
    const actualStep = totalDepth / numPasses;

    const passes = [];
    for (let i = 1; i <= numPasses; i += 1) {
      const z = this.params.stockSurfaceZ - actualStep * i;
      passes.push(Math.round(z * 10000) / 10000);
    }
    return passes;
  }

  /**
   * Genera el programa G completo.
   * @param {Array<object>} rawEntities Entidades DXF normalizadas.
   * @param {object} bounds Cuadro delimitador.
   * @param {Object<string, {visible:boolean, operation:string}>} layerConfigs
   * @returns {string}
   */
  generateGcode(rawEntities, bounds, layerConfigs = {}) {
    this.postprocessor = new PostProcessor(this.params.postProfile);
    const [zeroX, zeroY] = this.getZeroOffset(bounds);
    this.toolpaths = [];

    // 1. Filtrar por capas visibles.
    const activeEntities = [];
    for (const entity of rawEntities) {
      const cfg = layerConfigs[entity.layer] || { visible: true, operation: 'PERFIL_EXTERIOR' };
      if (cfg.visible !== false) activeEntities.push(entity);
    }

    if (!activeEntities.length) {
      this.stats = {};
      return '; Error: No hay entidades activas o capas visibles para mecanizar.\n';
    }

    // 2. Encadenar perfiles continuos.
    let contours = this.geomProcessor.chainEntities(activeEntities);

    // 3. Jerarquía de anidado (Inside-First).
    contours = this.geomProcessor.analyzeNestingHierarchy(contours);

    // 4. Orden seguro.
    const orderedContours = this.geomProcessor.sortContoursSafely(contours, [0.0, 0.0]);

    // 5. Pasadas en Z.
    const zPasses = this.calculateZPasses();
    const tabThresholdZ = this.params.targetDepth + this.params.tabHeight;

    const gcodeLines = [];

    const headerParams = {
      program_name: 'CORTE_SEGURO_2D',
      safe_z: this.params.safeZ,
      tool_diameter: this.params.toolDiameter,
      target_depth: this.params.targetDepth,
      cut_feed: this.params.cutFeed,
      plunge_feed: this.params.plungeFeed,
      spindle_rpm: this.params.spindleRpm,
      spindle_dwell: this.params.spindleDwell,
      coolant: this.params.coolant,
    };
    gcodeLines.push(...this.postprocessor.getHeader(headerParams));

    const isLaser = String(this.params.postProfile).includes('Láser')
      || String(this.params.postProfile).includes('Plasma');

    const fixed3 = (value) => Number(value).toFixed(3);

    // 6. Procesar cada contorno.
    for (let contourIndex = 0; contourIndex < orderedContours.length; contourIndex += 1) {
      const contour = orderedContours[contourIndex];
      const cfg = layerConfigs[contour.layer] || { operation: 'PERFIL_EXTERIOR' };
      const operation = cfg.operation || 'PERFIL_EXTERIOR';

      gcodeLines.push('');
      gcodeLines.push('; ------------------------------------------');
      gcodeLines.push(`; Contorno ${contourIndex + 1}/${orderedContours.length} - Capa: '${contour.layer}'`);
      gcodeLines.push(`; Operación: ${operation} | Nivel Anidado: ${contour.nestingLevel}`);
      gcodeLines.push('; ------------------------------------------');

      // Taladrado: ciclo de penetración en el centro.
      if (operation === 'TALADRADO') {
        const center = contour.circleCenter || contour.points[0];
        const cx = center[0] - zeroX;
        const cy = center[1] - zeroY;

        gcodeLines.push(`G0 Z${fixed3(this.params.safeZ)}`);
        gcodeLines.push(`G0 X${fixed3(cx)} Y${fixed3(cy)}`);
        this.toolpaths.push(
          new ToolpathSegment('G0', cx, cy, this.params.safeZ, this.params.rapidFeed),
        );

        gcodeLines.push(`G0 Z${fixed3(this.params.retractZ)}`);
        for (const passZ of zPasses) {
          gcodeLines.push(`G1 Z${fixed3(passZ)} F${Number(this.params.plungeFeed).toFixed(1)}`);
          gcodeLines.push(`G0 Z${fixed3(this.params.retractZ)}`);
        }
        gcodeLines.push(`G0 Z${fixed3(this.params.safeZ)}`);
        this.toolpaths.push(
          new ToolpathSegment('G1', cx, cy, this.params.targetDepth, this.params.plungeFeed),
        );
        this.toolpaths.push(
          new ToolpathSegment('G0', cx, cy, this.params.safeZ, this.params.rapidFeed),
        );
        continue;
      }

      // Trayectorias con compensación de radio.
      const offsetPaths = this.geomProcessor.computeOffset(
        contour,
        this.params.toolDiameter,
        operation,
      );

      for (const rawPath of offsetPaths) {
        if (rawPath.length < 2) continue;

        const adjusted = rawPath.map((p) => [p[0] - zeroX, p[1] - zeroY]);
        const startX = adjusted[0][0];
        const startY = adjusted[0][1];

        // Pestañas solo en el contorno exterior cerrado.
        let tabs = [];
        if (this.params.tabsEnabled && contour.isClosed && contour.nestingLevel === 0) {
          tabs = this.geomProcessor.generateTabs(
            adjusted,
            this.params.tabCount,
            this.params.tabWidth,
          );
        }

        // 1. Ir al punto inicial a Z Seguro.
        gcodeLines.push(`G0 Z${fixed3(this.params.safeZ)} ; Asegurar altura libre`);
        gcodeLines.push(`G0 X${fixed3(startX)} Y${fixed3(startY)} ; Posicionamiento XY`);
        this.toolpaths.push(
          new ToolpathSegment('G0', startX, startY, this.params.safeZ, this.params.rapidFeed),
        );

        if (isLaser) {
          // Modo láser / plasma: encendido, recorrido y apagado.
          gcodeLines.push(`M3 S${this.params.laserPower} ; Encender antorcha / láser`);
          for (const p of adjusted.slice(1)) {
            gcodeLines.push(`G1 X${fixed3(p[0])} Y${fixed3(p[1])} F${Number(this.params.cutFeed).toFixed(1)}`);
            this.toolpaths.push(
              new ToolpathSegment('G1', p[0], p[1], 0.0, this.params.cutFeed),
            );
          }
          gcodeLines.push('M5 ; Apagar antorcha / láser');
        } else {
          // Fresado con pasadas en Z.
          gcodeLines.push(`G0 Z${fixed3(this.params.retractZ)} ; Aproximación rápida`);
          this.toolpaths.push(
            new ToolpathSegment('G0', startX, startY, this.params.retractZ, this.params.rapidFeed),
          );

          for (let passIndex = 0; passIndex < zPasses.length; passIndex += 1) {
            const passZ = zPasses[passIndex];
            gcodeLines.push(`; Pasada ${passIndex + 1}/${zPasses.length} a Z = ${fixed3(passZ)} mm`);

            gcodeLines.push(
              `G1 Z${fixed3(passZ)} F${Number(this.params.plungeFeed).toFixed(1)} ; Penetración controlada`,
            );
            this.toolpaths.push(
              new ToolpathSegment('G1', startX, startY, passZ, this.params.plungeFeed),
            );

            const hasTabs = Boolean(tabs.length) && passZ <= tabThresholdZ;

            if (!hasTabs) {
              for (const p of adjusted.slice(1)) {
                gcodeLines.push(`G1 X${fixed3(p[0])} Y${fixed3(p[1])} F${Number(this.params.cutFeed).toFixed(1)}`);
                this.toolpaths.push(
                  new ToolpathSegment('G1', p[0], p[1], passZ, this.params.cutFeed),
                );
              }
            } else {
              let cumulative = 0;
              for (let i = 0; i < adjusted.length - 1; i += 1) {
                const p1 = adjusted[i];
                const p2 = adjusted[i + 1];
                const segmentLength = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
                if (segmentLength < 0.0001) continue;

                const inTab = tabs.some(([tabStart, tabEnd]) => !(
                  cumulative + segmentLength < tabStart || cumulative > tabEnd
                ));

                if (inTab) {
                  gcodeLines.push(
                    `G1 Z${fixed3(tabThresholdZ)} F${Number(this.params.cutFeed).toFixed(1)} ; Pestaña (Tab)`,
                  );
                  gcodeLines.push(`G1 X${fixed3(p2[0])} Y${fixed3(p2[1])} F${Number(this.params.cutFeed).toFixed(1)}`);
                  gcodeLines.push(
                    `G1 Z${fixed3(passZ)} F${Number(this.params.plungeFeed).toFixed(1)} ; Retorno a corte`,
                  );
                  this.toolpaths.push(
                    new ToolpathSegment('G1', p2[0], p2[1], tabThresholdZ, this.params.cutFeed, true),
                  );
                  this.toolpaths.push(
                    new ToolpathSegment('G1', p2[0], p2[1], passZ, this.params.plungeFeed),
                  );
                } else {
                  gcodeLines.push(`G1 X${fixed3(p2[0])} Y${fixed3(p2[1])} F${Number(this.params.cutFeed).toFixed(1)}`);
                  this.toolpaths.push(
                    new ToolpathSegment('G1', p2[0], p2[1], passZ, this.params.cutFeed),
                  );
                }

                cumulative += segmentLength;
              }
            }
          }
        }

        // Retracción obligatoria al terminar el contorno.
        gcodeLines.push(`G0 Z${fixed3(this.params.safeZ)} ; Retracción segura`);
        const last = adjusted[adjusted.length - 1];
        this.toolpaths.push(
          new ToolpathSegment('G0', last[0], last[1], this.params.safeZ, this.params.rapidFeed),
        );
      }
    }

    gcodeLines.push(...this.postprocessor.getFooter(headerParams));

    this._calculateStatistics();

    return gcodeLines.join('\n');
  }

  /** Métricas de distancia, tiempo estimado y profundidad. */
  _calculateStatistics() {
    let totalRapidDistance = 0;
    let totalCutDistance = 0;
    let totalPlungeDistance = 0;

    let previous = null;
    for (const segment of this.toolpaths) {
      if (previous) {
        const dx = segment.x - previous.x;
        const dy = segment.y - previous.y;
        const dz = segment.z - previous.z;
        const distanceXY = Math.hypot(dx, dy);
        const distanceZ = Math.abs(dz);

        if (segment.cmdType === 'G0') {
          totalRapidDistance += Math.sqrt(distanceXY ** 2 + distanceZ ** 2);
        } else if (segment.cmdType === 'G1') {
          totalCutDistance += distanceXY;
          totalPlungeDistance += distanceZ;
        }
      }
      previous = segment;
    }

    const timeRapid = this.params.rapidFeed > 0
      ? totalRapidDistance / (this.params.rapidFeed / 60.0) : 0;
    const timeCut = this.params.cutFeed > 0
      ? totalCutDistance / (this.params.cutFeed / 60.0) : 0;
    const timePlunge = this.params.plungeFeed > 0
      ? totalPlungeDistance / (this.params.plungeFeed / 60.0) : 0;
    const timeTotal = timeRapid + timeCut + timePlunge + this.params.spindleDwell;

    this.stats = {
      totalCommands: this.toolpaths.length,
      rapidDistance: Math.round(totalRapidDistance * 100) / 100,
      cutDistance: Math.round(totalCutDistance * 100) / 100,
      plungeDistance: Math.round(totalPlungeDistance * 100) / 100,
      totalDistance: Math.round((totalRapidDistance + totalCutDistance + totalPlungeDistance) * 100) / 100,
      timeRapidSec: Math.round(timeRapid * 10) / 10,
      timeCutSec: Math.round(timeCut * 10) / 10,
      timeTotalSec: Math.round(timeTotal * 10) / 10,
      timeTotalMin: Math.round((timeTotal / 60.0) * 100) / 100,
      zMin: this.params.targetDepth,
      safeZ: this.params.safeZ,
      numPasses: this.calculateZPasses().length,
    };
  }

  /**
   * Convierte las trayectorias en comandos de simulación con tiempos.
   * @param {string} gcodeText Programa G ya generado.
   */
  buildSimulation(gcodeText) {
    const commands = [];
    let previousX = 0.0;
    let previousY = 0.0;
    let previousZ = this.params.safeZ;
    let totalTime = 0.0;

    for (let index = 0; index < this.toolpaths.length; index += 1) {
      const segment = this.toolpaths[index];
      const distanceXY = Math.hypot(segment.x - previousX, segment.y - previousY);
      const distanceZ = segment.z - previousZ;
      const distanceTotal = Math.sqrt(distanceXY ** 2 + distanceZ ** 2);

      const feed = segment.f > 0 ? segment.f : 500.0;
      const time = distanceTotal > 0 ? distanceTotal / (feed / 60.0) : 0.0;
      totalTime += time;

      commands.push({
        index,
        cmd: segment.cmdType,
        x: segment.x,
        y: segment.y,
        z: segment.z,
        prevX: previousX,
        prevY: previousY,
        prevZ: previousZ,
        f: feed,
        dist: distanceTotal,
        time,
        isTab: segment.isTab,
      });

      previousX = segment.x;
      previousY = segment.y;
      previousZ = segment.z;
    }

    const blockLines = String(gcodeText || '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith(';'));

    return { commands, totalTime, blockLines };
  }
}

module.exports = {
  CAMEngine,
  CAMParameters,
  ToolpathSegment,
};
