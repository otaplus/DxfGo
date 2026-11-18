'use strict';

/**
 * Simulador CNC 2D / 2.5D: reproduce las trayectorias generadas con la misma
 * codificación de color que el simulador original.
 *
 *   - traslados rápidos G0 ......... rojo punteado
 *   - pestañas ..................... naranja
 *   - recorridos sobre la superficie cian
 *   - corte en material ............ verde, con el ancho de la fresa
 */

(function attachSimView() {
  const { prepareCanvas } = window.U;

  class SimView {
    constructor(elements) {
      this.canvas = elements.canvas;
      this.codeList = elements.codeList;
      this.hint = elements.hint;
      this.telemetry = elements.telemetry;
      this.progress = elements.progress;
      this.speedInput = elements.speed;
      this.onStateChange = elements.onStateChange || (() => {});

      this.commands = [];
      this.blockLines = [];
      this.totalTime = 0;

      this.stepIndex = 0;
      this.currentTime = 0;
      this.running = false;
      this.paused = false;
      this.timer = null;

      this.zoom = 1;
      this.panX = 0;
      this.panY = 0;
      this.toolDiameter = 3.175;
      this.surfaceZ = 0;

      this.rowNodes = [];
      this.dragging = false;
      this.dragOrigin = { x: 0, y: 0 };

      this._bindEvents();
    }

    /** Carga un programa generado. */
    setData({ commands, totalTime, blockLines }, toolDiameter, surfaceZ) {
      this._clearTimer();
      this.commands = commands || [];
      this.blockLines = blockLines || [];
      this.totalTime = totalTime || 0;
      this.stepIndex = 0;
      this.currentTime = 0;
      this.running = false;
      this.paused = false;
      this.zoom = 1;
      this.panX = 0;
      this.panY = 0;
      if (Number.isFinite(toolDiameter)) this.toolDiameter = toolDiameter;
      if (Number.isFinite(surfaceZ)) this.surfaceZ = surfaceZ;

      this._renderCodeList();
      this._setProgress(0);
      this.hint.classList.toggle('hidden', this.commands.length > 0);
      this._emitState();
      this.draw();
      this.updateTelemetry();
    }

    /** Vacía el simulador. */
    clear() {
      this.setData({ commands: [], totalTime: 0, blockLines: [] });
    }

    setToolDiameter(value) {
      if (Number.isFinite(value)) {
        this.toolDiameter = value;
        this.draw();
      }
    }

    _emitState() {
      this.onStateChange({ running: this.running, paused: this.paused, hasData: this.commands.length > 0 });
    }

    _clearTimer() {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    }

    // ------------------------------- Controles ------------------------------

    play() {
      if (!this.commands.length) return;
      if (this.running && this.paused) {
        this.paused = false;
        this._emitState();
        this._loop();
        return;
      }
      if (this.stepIndex >= this.commands.length) {
        this.stepIndex = 0;
        this.currentTime = 0;
      }
      this.running = true;
      this.paused = false;
      this._emitState();
      this._loop();
    }

    pause() {
      if (!this.running) return;
      this.paused = true;
      this._clearTimer();
      this._emitState();
    }

    stop() {
      this._clearTimer();
      this.running = false;
      this.paused = false;
      this.stepIndex = 0;
      this.currentTime = 0;
      this._setProgress(0);
      this._emitState();
      this.draw();
      this.updateTelemetry();
      this._highlight();
    }

    step() {
      if (!this.commands.length) return;
      this.paused = true;
      this.running = true;
      this._clearTimer();
      this._advance();
      this._emitState();
    }

    reset() {
      this.stop();
    }

    /** Salta a un porcentaje del programa arrastrando la barra. */
    scrub(percent) {
      if (!this.commands.length) return;
      const pct = Math.min(100, Math.max(0, Number(percent) || 0)) / 100;
      this.stepIndex = Math.min(
        this.commands.length - 1,
        Math.floor(pct * this.commands.length),
      );
      this.currentTime = this._timeUntil(this.stepIndex);
      this.draw();
      this.updateTelemetry();
      this._highlight();
    }

    /** Salta a un bloque concreto de la lista de código. */
    seek(index) {
      if (!this.commands.length) return;
      const target = Math.min(this.commands.length - 1, Math.max(0, index));
      this.stepIndex = target;
      this.currentTime = this._timeUntil(target);
      this._setProgress((target / this.commands.length) * 100);
      this.draw();
      this.updateTelemetry();
      this._highlight();
    }

    _timeUntil(index) {
      let total = 0;
      for (let i = 0; i < index && i < this.commands.length; i += 1) total += this.commands[i].time;
      return total;
    }

    _advance() {
      if (this.stepIndex >= this.commands.length) {
        this._clearTimer();
        this.running = false;
        this.paused = false;
        this._emitState();
        this.telemetry.textContent = window.I18n.t('sim.finished', {
          time: this.totalTime.toFixed(1),
        });
        return;
      }

      const command = this.commands[this.stepIndex];
      this.currentTime += command.time;
      this.stepIndex += 1;
      this._setProgress((this.stepIndex / this.commands.length) * 100);
      this.draw();
      this.updateTelemetry();
      this._highlight();
    }

    _loop() {
      if (!this.running || this.paused) return;
      this._clearTimer();

      if (this.stepIndex >= this.commands.length) {
        this._advance();
        return;
      }

      this._advance();
      if (!this.running) return;

      const speed = Math.max(1, Math.min(50, Number(this.speedInput.value) || 5));
      const delay = Math.max(5, Math.floor(150 / speed));
      this.timer = setTimeout(() => this._loop(), delay);
    }

    _setProgress(percent) {
      if (this.progress) this.progress.value = String(percent);
    }

    // ------------------------------ Telemetría ------------------------------

    updateTelemetry() {
      if (!this.telemetry) return;
      const t = window.I18n.t;
      if (this.stepIndex > 0 && this.commands[this.stepIndex - 1]) {
        const command = this.commands[this.stepIndex - 1];
        this.telemetry.textContent = t('sim.telemetry', {
          x: command.x.toFixed(3),
          y: command.y.toFixed(3),
          z: command.z.toFixed(3),
          step: this.stepIndex,
          total: this.commands.length,
          time: this.currentTime.toFixed(1),
          totalTime: this.totalTime.toFixed(1),
        });
      } else {
        this.telemetry.textContent = t('sim.telemetry', {
          x: '0.000',
          y: '0.000',
          z: '0.000',
          step: 0,
          total: this.commands.length,
          time: '0.0',
          totalTime: this.totalTime.toFixed(1),
        });
      }
    }

    _renderCodeList() {
      this.codeList.textContent = '';
      this.rowNodes = [];
      const fragment = document.createDocumentFragment();

      for (let i = 0; i < this.blockLines.length; i += 1) {
        const row = document.createElement('div');
        row.className = 'code-line';
        row.textContent = this.blockLines[i];
        row.addEventListener('click', () => this.seek(i));
        fragment.appendChild(row);
        this.rowNodes.push(row);
      }
      this.codeList.appendChild(fragment);
    }

    _highlight() {
      if (!this.rowNodes.length) return;
      const activeIndex = this.stepIndex - 1;
      const lastActive = this.codeList.querySelector('.code-line.active');

      for (const row of this.rowNodes) row.classList.remove('active');
      if (activeIndex >= 0 && activeIndex < this.rowNodes.length) {
        const row = this.rowNodes[activeIndex];
        row.classList.add('active');
        if (row !== lastActive) row.scrollIntoView({ block: 'nearest' });
      }
    }

    // -------------------------------- Dibujo --------------------------------

    /** Calcula la transformación mundo -> pantalla para el tamaño actual. */
    _computeView(width, height) {
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const command of this.commands) {
        minX = Math.min(minX, command.x, command.prevX);
        maxX = Math.max(maxX, command.x, command.prevX);
        minY = Math.min(minY, command.y, command.prevY);
        maxY = Math.max(maxY, command.y, command.prevY);
      }
      if (!Number.isFinite(minX)) return null;

      const worldWidth = Math.max(1, maxX - minX);
      const worldHeight = Math.max(1, maxY - minY);
      const baseScale = Math.min(
        (width - 80) / worldWidth,
        (height - 80) / worldHeight,
      ) * 0.9;
      const scale = Math.max(1e-6, baseScale * this.zoom);

      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;

      return {
        scale,
        worldWidth,
        worldHeight,
        centerX,
        centerY,
        minX,
        maxX,
        minY,
        maxY,
        ox: width / 2 - centerX * scale + this.panX,
        oy: height / 2 + centerY * scale + this.panY,
      };
    }

    draw() {
      const prepared = prepareCanvas(this.canvas);
      if (!prepared) return;
      const { ctx, width, height } = prepared;

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#121212';
      ctx.fillRect(0, 0, width, height);

      if (!this.commands.length) return;

      const view = this._computeView(width, height);
      if (!view) return;
      const {
        scale, ox, oy, worldWidth, worldHeight, minX, maxX, minY, maxY,
      } = view;

      const toScreen = (x, y) => [x * scale + ox, -y * scale + oy];

      // Cuadrícula.
      const gridStep = this._gridStep(scale, worldWidth, worldHeight);
      ctx.strokeStyle = '#1c1c1c';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let gx = Math.floor(minX / gridStep) * gridStep; gx <= maxX + gridStep; gx += gridStep) {
        const [sx] = toScreen(gx, 0);
        if (sx < 0 || sx > width) continue;
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, height);
      }
      for (let gy = Math.floor(minY / gridStep) * gridStep; gy <= maxY + gridStep; gy += gridStep) {
        const [, sy] = toScreen(0, gy);
        if (sy < 0 || sy > height) continue;
        ctx.moveTo(0, sy);
        ctx.lineTo(width, sy);
      }
      ctx.stroke();

      // Origen de pieza.
      const [zx, zy] = toScreen(0, 0);
      ctx.beginPath();
      ctx.arc(zx, zy, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#ffff00';
      ctx.fill();
      ctx.strokeStyle = '#000000';
      ctx.stroke();

      // Trayectorias de fondo.
      ctx.lineWidth = 1;
      for (const command of this.commands) {
        const [x1, y1] = toScreen(command.prevX, command.prevY);
        const [x2, y2] = toScreen(command.x, command.y);
        if (command.cmd === 'G0') {
          ctx.save();
          ctx.setLineDash([2, 2]);
          ctx.strokeStyle = '#4a2222';
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
          ctx.restore();
        } else {
          ctx.strokeStyle = '#1b4d2e';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
        }
      }

      // Trayectorias ejecutadas.
      const executed = this.commands.slice(0, this.stepIndex);
      const toolRadiusPx = Math.max(2, (this.toolDiameter / 2) * scale);

      for (const command of executed) {
        const [x1, y1] = toScreen(command.prevX, command.prevY);
        const [x2, y2] = toScreen(command.x, command.y);

        if (command.cmd === 'G0') {
          ctx.save();
          ctx.setLineDash([4, 3]);
          ctx.strokeStyle = '#ff3333';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
          ctx.restore();
        } else if (command.isTab) {
          ctx.strokeStyle = '#ff9900';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
        } else if (command.z >= this.surfaceZ - 0.001) {
          ctx.strokeStyle = '#00d8ff';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
        } else {
          ctx.strokeStyle = '#00ff66';
          ctx.lineWidth = Math.max(2, toolRadiusPx * 1.5);
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
        }
      }

      // Herramienta actual.
      if (executed.length) {
        const current = executed[executed.length - 1];
        const [tx, ty] = toScreen(current.x, current.y);
        const toolColor = current.z < -0.001 ? '#00ff66' : '#ff3333';

        ctx.beginPath();
        ctx.arc(tx, ty, Math.max(2, toolRadiusPx), 0, Math.PI * 2);
        ctx.strokeStyle = toolColor;
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(tx, ty, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 11px "Cascadia Mono", Consolas, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`Z: ${current.z.toFixed(2)}`, tx + 8, ty - 6);
      }
    }

    _gridStep(scale, worldWidth, worldHeight) {
      let step = 10;
      if (scale > 8) step = 2;
      else if (scale < 1) step = 50;

      let guard = 0;
      while (Math.max(worldWidth / step, worldHeight / step) > 260 && guard < 8) {
        step *= 5;
        guard += 1;
      }
      return step;
    }

    // -------------------------------- Eventos -------------------------------

    _bindEvents() {
      const canvas = this.canvas;

      canvas.addEventListener('wheel', (event) => {
        event.preventDefault();
        if (!this.commands.length) return;

        const prepared = prepareCanvas(canvas);
        if (!prepared) return;
        const { width, height } = prepared;
        const view = this._computeView(width, height);
        if (!view) return;

        const rect = canvas.getBoundingClientRect();
        const posX = event.clientX - rect.left;
        const posY = event.clientY - rect.top;

        const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
        const worldX = (posX - view.ox) / view.scale;
        const worldY = -(posY - view.oy) / view.scale;

        const nextScale = Math.max(1e-6, view.scale * factor);
        this.zoom = Math.min(2000, Math.max(0.01, (nextScale / view.scale) * this.zoom));

        const nextOx = posX - worldX * nextScale;
        const nextOy = posY + worldY * nextScale;

        this.panX = nextOx - width / 2 + view.centerX * nextScale;
        this.panY = nextOy - height / 2 - view.centerY * nextScale;

        this.draw();
      }, { passive: false });

      canvas.addEventListener('mousedown', (event) => {
        if (event.button !== 0 && event.button !== 1) return;
        this.dragging = true;
        this.dragOrigin = { x: event.clientX, y: event.clientY };
        canvas.classList.add('panning');
      });

      window.addEventListener('mousemove', (event) => {
        if (!this.dragging) return;
        this.panX += event.clientX - this.dragOrigin.x;
        this.panY += event.clientY - this.dragOrigin.y;
        this.dragOrigin = { x: event.clientX, y: event.clientY };
        this.draw();
      });

      window.addEventListener('mouseup', () => {
        if (!this.dragging) return;
        this.dragging = false;
        canvas.classList.remove('panning');
      });

      if (this.progress) {
        this.progress.addEventListener('input', () => this.scrub(this.progress.value));
      }
    }
  }

  window.SimView = SimView;
}());
