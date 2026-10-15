// Lectura y formato de números al estilo argentino ("6.961" = seis mil, "1,5" = uno y medio).
// Lo usan el servidor (require) y los navegadores (window.Ronda3Number).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Ronda3Number = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_ABS = 1e12;

  function parseNumber(raw) {
    if (typeof raw === 'number') return Number.isFinite(raw) && Math.abs(raw) <= MAX_ABS ? raw : null;
    let text = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, '');
    if (!text) return null;

    let multiplier = 1;
    const suffix = text.match(/^(.*\d)(k|mil)$/);
    if (suffix) {
      text = suffix[1];
      multiplier = 1000;
    }

    text = text.replace(/[^\d.,-]/g, '');
    const hasDot = text.includes('.');
    const hasComma = text.includes(',');
    if (hasDot && hasComma) {
      // El último separador es el decimal: "1.234,5" o "1,234.5".
      text = text.lastIndexOf(',') > text.lastIndexOf('.')
        ? text.replace(/\./g, '').replace(',', '.')
        : text.replace(/,/g, '');
    } else if (hasComma) {
      text = /^-?\d{1,3}(,\d{3}){2,}$/.test(text) ? text.replace(/,/g, '') : text.replace(',', '.');
    } else if (hasDot && /^-?[1-9]\d{0,2}(\.\d{3})+$/.test(text)) {
      text = text.replace(/\./g, '');
    }

    if (!/^-?\d*\.?\d+$/.test(text)) return null;
    const value = Number(text) * multiplier;
    return Number.isFinite(value) && Math.abs(value) <= MAX_ABS ? value : null;
  }

  function formatNumber(value, plain) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return String(value ?? '');
    if (plain) return String(Math.round(value * 100) / 100);
    return value.toLocaleString('es-AR', { maximumFractionDigits: 2 });
  }

  return { parseNumber, formatNumber };
});
