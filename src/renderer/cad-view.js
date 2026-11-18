'use strict';

/**
 * Visor CAD: dibuja las entidades DXF, la cuadrícula milimétrica, las cotas de
 * la pieza, el cero de trabajo y la previsualización de trayectorias.
 * Admite zoom con la rueda (anclado al puntero) y desplazamiento con arrastre.
 */

(function attachCadView() {
  const { prepareCanvas, pointerPosition, withAlpha } = window.U;

  const EMPTY_BOUNDS = {
    minX: 0, maxX: 0, minY: 0, maxY: 0, width: 0, height: 0,
  };

  class CadView {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {HTMLElement} coordsLabel
     */
    constructor(canvas, coordsLabel) {
      this.canvas = canvas;
      this.coordsLabel = coordsLabel;

      this.entities = [];
      this.bounds = { ...EMPTY_BOUNDS };
      this.visibility = {};
      this.preview = { paths: [], tabs: [] };
      this.zero = [0, 0];

      this.zoom = 1;
      this.panX = 0;
      this.panY = 0;

      this.showToolpaths = true;
      this.dragging = false;
      this.dragOrigin = { x: 0, y: 0 };

      this._bindEvents();
    }

    /** Carga las entidades y el cuadro delimitador de la pieza. */
    setData({ entities, bounds, layers, zero }) {
      this.entities = entities || [];
      this.bounds = bounds || { ...EMPTY_BOUNDS };
      this.visibility = {};
      for (const layer of layers || []) {
        this.visibility[layer.name] = layer.visible !== false;
      }
      if (zero) this.zero = zero;
      this.fit();
    }

    /** Actualiza la previsualización de trayectorias compensadas y pestañas. */
    setPreview(preview) {
      this.preview = preview || { paths: [], tabs: [] };
      if (preview && preview.zero) this.zero = preview.zero;
      this.draw();
    }

    setVisibility(visibility) {
      this.visibility = { ...visibility };
      this.draw();
    }

    setZero(zero) {
      if (Array.isArray(zero)) this.zero = zero;
      this.draw();
    }

    setShowToolpaths(value) {
      this.showToolpaths = Boolean(value);
      this.draw();
    }

    /** Restablece zoom y desplazamiento. */
    fit() {
      this.zoom = 1;
      this.panX = 0;
      this.panY = 0;
      this.draw();
    }

    /** Métricas internas de la vista actual. */
    _metrics() {
      const prepared = prepareCanvas(this.canvas);
      if (!prepared) return null;
      const { ctx, width, height } = prepared;

      const bounds = this.bounds;
      const worldWidth = Math.abs(bounds.width) > 0.001 ? bounds.width : 1;
      const worldHeight = Math.abs(bounds.height) > 0.001 ? bounds.height : 1;
      const baseScale = Math.min((width - 80) / worldWidth, (height - 80) / worldHeight) * 0.9;
      const scale = Math.max(1e-6, baseScale * this.zoom);

      const centerX = (bounds.minX + bounds.maxX) / 2;
      const centerY = (bounds.minY + bounds.maxY) / 2;
      const ox = width / 2 - centerX * scale + this.panX;
      const oy = height / 2 + centerY * scale + this.panY;

      return {
        ctx, width, height, scale, ox, oy, centerX, centerY,
      };
    }

    /** Zoom anclado a un punto de pantalla (por defecto, el centro). */
    zoomBy(factor, anchorX, anchorY) {
      const metrics = this._metrics();
      if (!metrics) return;

      const {
        width, height, scale, ox, oy, centerX, centerY,
      } = metrics;
      const ax = Number.isFinite(anchorX) ? anchorX : width / 2;
      const ay = Number.isFinite(anchorY) ? anchorY : height / 2;

      const worldX = (ax - ox) / scale;
      const worldY = -(ay - oy) / scale;

      const nextZoom = Math.min(2000, Math.max(0.01, this.zoom * factor));
      this.zoom = nextZoom;

      const nextScale = Math.max(1e-6, (scale / this.zoom) * nextZoom);
      const nextOx = ax - worldX * nextScale;
      const nextOy = ay + worldY * nextScale;

      this.panX = nextOx - width / 2 + centerX * nextScale;
      this.panY = nextOy - height / 2 - centerY * nextScale;

      this.draw();
    }

    /** Paso de cuadrícula adecuado a la escala actual. */
    _gridStep(scale) {
      let step = 10;
      if (scale > 8) step = 2;
      else if (scale < 1) step = 50;

      // Evita dibujar miles de líneas en piezas muy grandes.
      const span = Math.max(
        Math.abs(this.bounds.width) / step,
        Math.abs(this.bounds.height) / step,
      );
      let guard = 0;
      while (span > 260 && guard < 8) {
        step *= 5;
        guard += 1;
        break;
      }
      return step;
    }

    /** Dibuja la escena completa. */
    draw() {
      const metrics = this._metrics();
      if (!metrics) return;
      const {
        ctx, width, height, scale, ox, oy,
      } = metrics;

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = '#121212';
      ctx.fillRect(0, 0, width, height);

      if (!this.entities.length) return;

      this._drawGrid(ctx, width, height, scale, ox, oy);
      this._drawEntities(ctx, scale, ox, oy);
      if (this.showToolpaths) this._drawPreview(ctx, scale, ox, oy);
      this._drawBounds(ctx, scale, ox, oy);
      this._drawOrigin(ctx, scale, ox, oy);
    }

    _drawGrid(ctx, width, height, scale, ox, oy) {
      const step = this._gridStep(scale);
      const [zeroX, zeroY] = this.zero;

      const minGx = Math.floor(this.bounds.minX / step) * step - step * 2;
      const maxGx = Math.floor(this.bounds.maxX / step) * step + step * 2;
      const minGy = Math.floor(this.bounds.minY / step) * step - step * 2;
      const maxGy = Math.floor(this.bounds.maxY / step) * step + step * 2;

      ctx.lineWidth = 1;
      ctx.strokeStyle = '#1e1e1e';
      ctx.font = '10px Arial, sans-serif';
      ctx.fillStyle = '#4a4a4a';

      ctx.beginPath();
      for (let gx = minGx; gx <= maxGx; gx += step) {
        const sx = Math.round(gx * scale + ox) + 0.5;
        if (sx < 0 || sx > width) continue;
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, height);
      }
      for (let gy = minGy; gy <= maxGy; gy += step) {
        const sy = Math.round(-gy * scale + oy) + 0.5;
        if (sy < 0 || sy > height) continue;
        ctx.moveTo(0, sy);
        ctx.lineTo(width, sy);
      }
      ctx.stroke();

      // Etiquetas de ejes.
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      for (let gx = minGx; gx <= maxGx; gx += step) {
        const sx = gx * scale + ox;
        if (sx < 18 || sx > width - 12) continue;
        ctx.fillText(String(Math.round(gx - zeroX)), sx, height - 8);
      }
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      for (let gy = minGy; gy <= maxGy; gy += step) {
        const sy = -gy * scale + oy;
        if (sy < 10 || sy > height - 10) continue;
        ctx.fillText(String(Math.round(gy - zeroY)), 8, sy);
      }
    }

    _drawEntities(ctx, scale, ox, oy) {
      ctx.lineWidth = 1.6;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      for (const entity of this.entities) {
        if (this.visibility[entity.layer] === false) continue;
        const points = entity.points;
        if (!points || points.length < 2) continue;

        ctx.beginPath();
        for (let i = 0; i < points.length; i += 1) {
          const sx = points[i][0] * scale + ox;
          const sy = -points[i][1] * scale + oy;
          if (i === 0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        }
        ctx.strokeStyle = entity.color || '#00ff00';
        ctx.stroke();
      }
    }

    _drawPreview(ctx, scale, ox, oy) {
      const { paths, tabs } = this.preview;

      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = withAlpha('#00d8ff', 0.85);
      for (const path of paths || []) {
        const points = path.points;
        if (!points || points.length < 2) continue;
        ctx.beginPath();
        for (let i = 0; i < points.length; i += 1) {
          const sx = points[i][0] * scale + ox;
          const sy = -points[i][1] * scale + oy;
          if (i === 0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        }
        ctx.stroke();
      }
      ctx.restore();

      ctx.fillStyle = '#ff9900';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      for (const [tx, ty] of tabs || []) {
        const sx = tx * scale + ox;
        const sy = -ty * scale + oy;
        ctx.beginPath();
        ctx.arc(sx, sy, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }

    _drawBounds(ctx, scale, ox, oy) {
      const bounds = this.bounds;
      const x1 = bounds.minX * scale + ox;
      const x2 = bounds.maxX * scale + ox;
      const y1 = -bounds.minY * scale + oy;
      const y2 = -bounds.maxY * scale + oy;

      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#3d3d3d';
      ctx.lineWidth = 1;
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
      ctx.restore();

      ctx.fillStyle = '#8a8a8a';
      ctx.font = '11px Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(
        window.I18n.t('cad.width', { value: bounds.width.toFixed(2) }),
        (x1 + x2) / 2,
        y1 + 8,
      );

      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        window.I18n.t('cad.height', { value: bounds.height.toFixed(2) }),
        x2 + 10,
        (y1 + y2) / 2,
      );
    }

    _drawOrigin(ctx, scale, ox, oy) {
      const [zeroX, zeroY] = this.zero;
      const x = zeroX * scale + ox;
      const y = -zeroY * scale + oy;

      // Ejes X (rojo) e Y (verde).
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ff3333';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 35, y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x + 35, y);
      ctx.lineTo(x + 28, y - 4);
      ctx.moveTo(x + 35, y);
      ctx.lineTo(x + 28, y + 4);
      ctx.stroke();

      ctx.strokeStyle = '#33ff33';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y - 35);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, y - 35);
      ctx.lineTo(x - 4, y - 28);
      ctx.moveTo(x, y - 35);
      ctx.lineTo(x + 4, y - 28);
      ctx.stroke();

      ctx.font = 'bold 11px "Segoe UI", Arial, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ff3333';
      ctx.fillText('X', x + 40, y);
      ctx.fillStyle = '#33ff33';
      ctx.fillText('Y', x + 6, y - 40);

      // Cero pieza.
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffff00';
      ctx.fill();
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = '#ffff00';
      ctx.font = '11px "Segoe UI", Arial, sans-serif';
      ctx.fillText(window.I18n.t('cad.zeroLabel'), x + 12, y + 14);
    }

    /** Convierte coordenadas de pantalla a milímetros respecto al cero pieza. */
    _toWorld(screenX, screenY) {
      const metrics = this._metrics();
      if (!metrics) return null;
      const { scale, ox, oy } = metrics;
      const [zeroX, zeroY] = this.zero;
      return {
        x: (screenX - ox) / scale - zeroX,
        y: -(screenY - oy) / scale - zeroY,
      };
    }

    _bindEvents() {
      const canvas = this.canvas;

      canvas.addEventListener('wheel', (event) => {
        event.preventDefault();
        if (!this.entities.length) return;
        const pos = pointerPosition(canvas, event);
        this.zoomBy(event.deltaY < 0 ? 1.15 : 1 / 1.15, pos.x, pos.y);
      }, { passive: false });

      canvas.addEventListener('mousedown', (event) => {
        if (event.button !== 0 && event.button !== 1) return;
        this.dragging = true;
        this.dragOrigin = pointerPosition(canvas, event);
        canvas.classList.add('panning');
      });

      window.addEventListener('mousemove', (event) => {
        if (this.dragging) {
          const pos = pointerPosition(canvas, event);
          this.panX += pos.x - this.dragOrigin.x;
          this.panY += pos.y - this.dragOrigin.y;
          this.dragOrigin = pos;
          this.draw();
          return;
        }
        if (!this.entities.length) return;
        const rect = canvas.getBoundingClientRect();
        const inside = event.clientX >= rect.left && event.clientX <= rect.right
          && event.clientY >= rect.top && event.clientY <= rect.bottom;
        if (!inside) return;
        const pos = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        const world = this._toWorld(pos.x, pos.y);
        if (world && this.coordsLabel) {
          this.coordsLabel.textContent = `X: ${world.x.toFixed(3)} mm | Y: ${world.y.toFixed(3)} mm`;
        }
      });

      window.addEventListener('mouseup', () => {
        if (!this.dragging) return;
        this.dragging = false;
        canvas.classList.remove('panning');
      });

      canvas.addEventListener('dblclick', () => this.fit());
    }
  }

  window.CadView = CadView;
}());
