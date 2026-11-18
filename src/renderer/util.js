'use strict';

/**
 * Utilidades de interfaz: acceso al DOM, formato numérico, avisos y modal.
 * Se expone como `window.U`.
 */

(function attachUtil() {
  const U = {};

  /** Atajo de document.getElementById. */
  U.$ = (id) => document.getElementById(id);

  /** Crea un elemento con clase y texto opcionales. */
  U.el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  };

  /** Formatea un número con decimales fijos; devuelve '—' si no es válido. */
  U.fmt = (value, digits = 3) => {
    const num = Number(value);
    return Number.isFinite(num) ? num.toFixed(digits) : '—';
  };

  /** Retrasa la ejecución hasta que pase `wait` ms sin nuevas llamadas. */
  U.debounce = (fn, wait = 120) => {
    let timer = null;
    const wrapped = (...args) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn(...args);
      }, wait);
    };
    wrapped.cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    return wrapped;
  };

  /** Muestra un aviso flotante. */
  U.toast = (message, type = 'info', duration = 4200) => {
    const stack = U.$('toasts');
    if (!stack) return;
    const node = U.el('div', `toast ${type}`, message);
    node.addEventListener('click', () => node.remove());
    stack.appendChild(node);
    setTimeout(() => {
      node.classList.add('leaving');
      setTimeout(() => node.remove(), 220);
    }, duration);
  };

  /** Abre el diálogo modal con texto plano. */
  U.showModal = (title, body, options = {}) => {
    const backdrop = U.$('modal');
    if (!backdrop) return;
    U.$('modalTitle').textContent = title;
    const bodyNode = U.$('modalBody');
    bodyNode.textContent = body;
    bodyNode.classList.toggle('mono', Boolean(options.mono));
    backdrop.classList.remove('hidden');
  };

  /** Cierra el diálogo modal. */
  U.hideModal = () => {
    const backdrop = U.$('modal');
    if (backdrop) backdrop.classList.add('hidden');
  };

  /**
   * Prepara un canvas para dibujar con densidad de píxeles correcta.
   * @returns {{ctx: CanvasRenderingContext2D, width: number, height: number}|null}
   */
  U.prepareCanvas = (canvas) => {
    const rect = canvas.getBoundingClientRect();
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    if (width < 10 || height < 10) return null;

    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, width, height };
  };

  /** Posición del puntero relativa al canvas. */
  U.pointerPosition = (canvas, event) => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  /** Convierte #rrggbb + alfa a rgba(). */
  U.withAlpha = (hex, alpha) => {
    const value = String(hex).replace('#', '');
    if (value.length !== 6) return hex;
    const r = parseInt(value.slice(0, 2), 16);
    const g = parseInt(value.slice(2, 4), 16);
    const b = parseInt(value.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };

  window.U = U;
}());
