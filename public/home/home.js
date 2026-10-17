(() => {
  'use strict';
  const $ = (sel) => document.querySelector(sel);
  const host = location.host;

  // ---------- Instalar ----------
  const blocks = document.querySelectorAll('#install [data-mode]');
  Ronda3App.onChange((mode) => {
    blocks.forEach((el) => { el.hidden = el.dataset.mode !== mode; });
  });
  $('#installBtn').addEventListener('click', () => Ronda3App.install());

  $('#siteUrl').textContent = host;
  $('#tvLink').textContent = `${host}/tv`;

  // ---------- Entrar con código ----------
  const input = $('#codeInput');
  input.addEventListener('input', () => {
    input.value = input.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    $('#codeError').textContent = '';
  });
  $('#codeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = input.value.trim().toUpperCase();
    if (code.length !== 4) {
      $('#codeError').textContent = 'El código tiene 4 letras. Lo ves en el tele.';
      return;
    }
    location.href = `/play/${code}`;
  });
})();
