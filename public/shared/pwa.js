// Instalación como app (PWA): registra el service worker y avisa qué forma de instalar tiene este celular.
(() => {
  'use strict';

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => { /* sin app, se juega igual */ });
    });
  }

  const ua = navigator.userAgent;
  const isIos = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const isTv = /SMART-TV|SmartTV|Tizen|Web0S|BRAVIA|AFT[A-Z]|Android TV|GoogleTV|CrKey/.test(ua);
  const isMobile = !isTv && (isIos || /Android|Mobile/.test(ua));
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  let deferred = null;
  let installedNow = false;
  const listeners = new Set();
  const notify = () => listeners.forEach((fn) => fn(api.mode()));

  // Chrome/Edge/Samsung en Android avisan cuando se puede instalar con un toque.
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    installedNow = true;
    notify();
  });

  const api = {
    // 'installed' | 'prompt' (botón) | 'ios' (Compartir → Agregar) | 'android' (menú ⋮) | 'desktop' (compu o Smart TV)
    mode() {
      if (installedNow || isStandalone()) return 'installed';
      if (!isMobile) return 'desktop'; // en la compu o el tele se arma la partida, no se instala
      if (deferred) return 'prompt';
      if (isIos) return 'ios';
      return 'android';
    },
    onChange(fn) { listeners.add(fn); fn(api.mode()); },
    async install() {
      if (!deferred) return false;
      const prompt = deferred;
      deferred = null;
      prompt.prompt();
      const { outcome } = await prompt.userChoice;
      if (outcome === 'accepted') installedNow = true;
      notify();
      return outcome === 'accepted';
    },
  };

  window.Ronda3App = api;
})();
