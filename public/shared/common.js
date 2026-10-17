// Utilidades compartidas por el tele y el celular: conexión, reloj, DOM y festejos.
(function () {
  'use strict';

  // Diferencia entre el reloj del servidor y el local, para que todos vean la misma cuenta regresiva.
  const clock = {
    offset: 0,
    sync(serverNow) { if (typeof serverNow === 'number') this.offset = serverNow - Date.now(); },
    now() { return Date.now() + this.offset; },
  };

  function makeStore(getStorage) {
    return {
      get(key) { try { const raw = getStorage().getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; } },
      set(key, value) { try { getStorage().setItem(key, JSON.stringify(value)); } catch { /* sin storage */ } },
      remove(key) { try { getStorage().removeItem(key); } catch { /* sin storage */ } },
    };
  }

  // WebSocket con reconexión automática (backoff hasta 5 s y reintento al volver a la pestaña).
  // En el celu la conexión puede quedar "muerta" sin cerrarse (pantalla bloqueada, Wi-Fi → datos):
  // mandamos un ping cada tanto y si el servidor no contesta, reconectamos sin esperar al sistema.
  const PING_EVERY_MS = 8000;
  const DEAD_AFTER_MS = 20000;
  const PROBE_MS = 3500;

  function connect({ onOpen, onMessage, onStatus }) {
    let ws = null;
    let attempt = 0;
    let retryTimer = 0;
    let probeTimer = 0;
    let lastHeard = 0;

    function open() {
      clearTimeout(retryTimer);
      clearTimeout(probeTimer);
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const sock = new WebSocket(`${protocol}//${location.host}/ws`);
      ws = sock;
      onStatus?.('connecting');
      sock.onopen = () => {
        if (ws !== sock) return;
        attempt = 0;
        lastHeard = Date.now();
        onStatus?.('online');
        onOpen?.();
      };
      sock.onmessage = (event) => {
        if (ws !== sock) return;
        lastHeard = Date.now();
        clearTimeout(probeTimer);
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.type === 'pong') return;
        const payload = msg.payload || {};
        clock.sync(payload.serverNow);
        onMessage?.(msg.type, payload);
      };
      sock.onclose = () => {
        if (ws !== sock) return;
        ws = null;
        onStatus?.('offline');
        retryTimer = setTimeout(open, Math.min(5000, 400 * 2 ** attempt++));
      };
    }

    // Abandona el socket actual (sin esperar a que el sistema lo cierre) y abre uno nuevo ya.
    function reopen() {
      const old = ws;
      ws = null;
      if (old) { try { old.close(); } catch { /* ya estaba cerrado */ } }
      attempt = 0;
      open();
    }

    function ping() {
      if (ws && ws.readyState === 1) ws.send('{"type":"ping"}');
    }

    // Al volver a la pantalla o a la red: si el socket parece abierto, lo probamos; si no contesta, reconectamos.
    function check() {
      if (!ws || ws.readyState > 1) return reopen();
      if (ws.readyState !== 1) return undefined;
      ping();
      clearTimeout(probeTimer);
      probeTimer = setTimeout(reopen, PROBE_MS);
      return undefined;
    }

    setInterval(() => {
      if (!ws || ws.readyState !== 1 || document.visibilityState !== 'visible') return;
      if (Date.now() - lastHeard > DEAD_AFTER_MS) return reopen();
      ping();
      return undefined;
    }, PING_EVERY_MS);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check();
    });
    window.addEventListener('online', check);
    window.addEventListener('pageshow', (e) => { if (e.persisted) check(); });

    open();
    return {
      check, // para cuando importa saber ya si la conexión está viva (por ejemplo, al responder)
      send(type, payload = {}) {
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type, payload }));
          return true;
        }
        return false;
      },
    };
  }

  const $ = (selector, root = document) => root.querySelector(selector);

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'style') el.style.cssText = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      el.append(child instanceof Node ? child : String(child));
    }
    return el;
  }

  // Muestra una pantalla y reinicia su animación de entrada.
  function showScreen(id) {
    for (const screen of document.querySelectorAll('.screen')) {
      if (screen.id === id) {
        screen.hidden = false;
        screen.classList.remove('enter');
        void screen.offsetWidth;
        screen.classList.add('enter');
      } else {
        screen.hidden = true;
      }
    }
  }

  let toastTimer = 0;
  function toast(message, ms = 3200) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  function hue(name) {
    let value = 7;
    for (const ch of String(name).toLowerCase()) value = (value * 31 + ch.codePointAt(0)) % 360;
    return value;
  }

  function initials(name) {
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
    return [...parts[0]].slice(0, 2).join('').toUpperCase();
  }

  function avatar(name, extraClass = '') {
    return h('span', { class: `avatar ${extraClass}`.trim(), style: `--h:${hue(name)}`, 'aria-hidden': 'true' }, initials(name));
  }

  const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  function formatInt(value) {
    return Math.round(value).toLocaleString('es-AR');
  }

  // Cuenta de 0 al valor final, como en los shows.
  function countUp(el, to, ms = 900, prefix = '') {
    if (!to) { el.textContent = '0'; return; }
    if (reducedMotion()) { el.textContent = prefix + formatInt(to); return; }
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / ms);
      const eased = 1 - (1 - t) ** 3;
      el.textContent = prefix + formatInt(to * eased);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function confetti({ count = 180, duration = 3600 } = {}) {
    if (reducedMotion()) return;
    const colors = ['#ff3d9a', '#33d6ff', '#ffd23f', '#7dff8a', '#9b5cff', '#ffffff'];
    const canvas = h('canvas', { class: 'confetti', 'aria-hidden': 'true' });
    document.body.append(canvas);
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    const parts = Array.from({ length: count }, () => ({
      x: canvas.width * (0.5 + (Math.random() - 0.5) * 0.3),
      y: canvas.height * 0.35,
      vx: (Math.random() - 0.5) * 22 * dpr,
      vy: (-Math.random() * 16 - 6) * dpr,
      size: (Math.random() * 9 + 6) * dpr,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.35,
      color: colors[Math.floor(Math.random() * colors.length)],
      round: Math.random() < 0.3,
    }));
    const start = performance.now();
    const frame = (now) => {
      const t = now - start;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.globalAlpha = Math.max(0, 1 - t / duration);
      for (const p of parts) {
        p.vx *= 0.985;
        p.vy = p.vy * 0.985 + 0.45 * dpr;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        if (p.round) {
          ctx.beginPath();
          ctx.arc(0, 0, p.size / 2.4, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        }
        ctx.restore();
      }
      if (t < duration) requestAnimationFrame(frame);
      else canvas.remove();
    };
    requestAnimationFrame(frame);
  }

  window.Ronda3 = {
    clock,
    connect,
    local: makeStore(() => window.localStorage),
    session: makeStore(() => window.sessionStorage),
    $,
    h,
    showScreen,
    toast,
    avatar,
    countUp,
    confetti,
    formatInt,
    reducedMotion,
  };
})();
