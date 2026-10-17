(() => {
  'use strict';
  const { clock, connect, $, h, showScreen, toast, local, avatar, countUp, confetti, formatInt } = Ronda3;
  const { parseNumber, formatNumber } = Ronda3Number;

  const LETTERS = ['A', 'B', 'C', 'D'];
  const pathCode = (location.pathname.match(/\/play\/([A-Za-z]{4})\/?$/) || [])[1];
  const storageKey = (code) => `ronda3:player:${code}`;
  const LAST_NAME_KEY = 'ronda3:lastName';

  const state = {
    code: pathCode ? pathCode.toUpperCase() : '',
    name: '',
    token: '',
    joined: false,
    joining: false,
    phase: 'join',
    players: [],
    question: null,
    sending: false,
    score: 0,
  };
  let timerFrame = 0;
  let wakeLock = null;

  // Si ya entraste antes a esta sala desde este celular, volvés solo.
  const saved = state.code ? local.get(storageKey(state.code)) : null;
  if (saved?.name) {
    state.name = saved.name;
    state.token = saved.token || '';
  }
  // En una sala nueva, el nombre de la última vez ya viene puesto: solo falta el código.
  const lastName = state.name || local.get(LAST_NAME_KEY) || '';

  // ---------- Conexión ----------
  const socket = connect({
    onOpen() {
      if (state.code && state.name) join();
    },
    onStatus(status) { $('#status').dataset.state = status; },
    onMessage(type, payload) { handlers[type]?.(payload); },
  });

  function join() {
    state.joining = true;
    socket.send('player:join', { roomCode: state.code, name: state.name, token: state.token || undefined });
  }

  const handlers = {
    'player:welcome'(p) {
      state.joined = true;
      state.joining = false;
      state.name = p.name;
      state.token = p.token;
      state.score = p.score;
      local.set(storageKey(state.code), { name: p.name, token: p.token });
      local.set(LAST_NAME_KEY, p.name);
      renderMe();
      keepAwake();
      if (p.reconnected) toast(`¡Volviste, ${p.name}! Seguís con ${formatInt(p.score)} puntos.`);
    },
    'room:state'(p) {
      state.players = p.players || [];
      if (p.you) state.score = p.you.score;
      renderMe();
      switch (p.phase) {
        case 'lobby': return showWait();
        case 'intro': return showIntro(p.intro);
        case 'listening': return showListen(p.intro);
        case 'question':
          if (p.you?.answered) {
            state.question = p.question;
            return showSent(p.you.answer);
          }
          return showQuestion(p.question);
        case 'reveal': return showResult(p.reveal);
        case 'over': return showOver(p.final);
        default: return undefined;
      }
    },
    'players:update'(p) {
      state.players = p.players || [];
      const me = state.players.find((x) => x.name === state.name);
      if (me) state.score = me.score;
      renderMe();
      if (state.phase === 'wait') renderWaitPlayers();
    },
    'round:intro': (p) => showIntro(p),
    'round:listen': () => showListen(),
    'round:start': (p) => showQuestion(p),
    'answer:ack': (p) => showSent(p.value),
    'round:reveal': (p) => showResult(p),
    'game:over': (p) => showOver(p),
    error(p) {
      switch (p.code) {
        case 'ROOM_NOT_FOUND':
          local.remove(storageKey(state.code));
          state.token = '';
          return showJoin(p.message, !pathCode);
        case 'NAME_TAKEN':
        case 'INVALID_NAME':
        case 'ROOM_FULL':
          if (!state.joined) return showJoin(p.message);
          return toast(p.message);
        case 'ALREADY_ANSWERED':
          return showSent('');
        case 'SESSION_REPLACED':
          state.joined = false;
          return showJoin(p.message);
        case 'INVALID_ANSWER':
          setSending(false);
          return toast(p.message);
        default:
          setSending(false);
          return toast(p.message || 'Algo salió mal.');
      }
    },
  };

  // ---------- Entrar ----------
  function showJoin(message, askCode = !state.code) {
    state.phase = 'join';
    state.joining = false;
    setResult(null);
    setCategory(null);
    showScreen('screen-join');
    $('#codeField').hidden = !askCode;
    $('#codeInput').value = state.code;
    $('#nameInput').value = state.name || lastName;
    const error = $('#joinError');
    error.textContent = message || '';
    if (message) {
      error.classList.remove('shake');
      void error.offsetWidth;
      error.classList.add('shake');
    }
  }

  $('#codeInput').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  });

  $('#joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = ($('#codeField').hidden ? state.code : $('#codeInput').value).trim().toUpperCase();
    const name = $('#nameInput').value.replace(/\s+/g, ' ').trim();
    if (code.length !== 4) return showJoin('El código tiene 4 letras. Lo ves en el tele.', true);
    if (!name) return showJoin('Poné tu nombre así te reconocen en el tele.', $('#codeField').hidden === false);
    if (code !== state.code) {
      state.code = code;
      state.token = local.get(storageKey(code))?.token || '';
      history.replaceState(null, '', `/play/${code}`);
    }
    if (name.toLowerCase() !== (local.get(storageKey(code))?.name || '').toLowerCase()) state.token = '';
    state.name = name;
    $('#joinError').textContent = '';
    if (!socket.send('player:join', { roomCode: code, name, token: state.token || undefined })) {
      showJoin('Sin conexión con el servidor. ¿Estás en la misma Wi-Fi?');
    }
  });

  // ---------- Esperando ----------
  function showWait() {
    state.phase = 'wait';
    setResult(null);
    setCategory(null);
    show('screen-wait');
    $('#waitAvatar').replaceChildren(avatar(state.name));
    $('#waitTitle').textContent = `¡Adentro, ${state.name}!`;
    $('#waitText').textContent = 'Mirá el tele: la partida arranca en cualquier momento.';
    renderWaitPlayers();
  }

  function renderWaitPlayers() {
    $('#waitPlayers').replaceChildren(...state.players.map((p) =>
      h('li', { class: p.connected ? '' : 'offline' }, avatar(p.name), p.name)));
  }

  // ---------- Intro / escuchar ----------
  function showIntro(intro) {
    if (!intro) return;
    state.phase = 'intro';
    setResult(null);
    setCategory(intro.category);
    show('screen-intro');
    $('#introRound').textContent = `RONDA ${intro.index} / ${intro.total}`;
    $('#introCat').textContent = intro.genreLabel;
    $('#introLabel').textContent = intro.label;
    navigator.vibrate?.(40);
  }

  function showListen(intro) {
    state.phase = 'listen';
    setResult(null);
    if (intro) setCategory(intro.category);
    show('screen-listen');
  }

  // ---------- Pregunta ----------
  function showQuestion(q) {
    if (!q) return;
    state.phase = 'question';
    state.question = q;
    setResult(null);
    setCategory(q.category);
    showScreen('screen-question');

    $('#qCat').textContent = q.genreLabel;
    $('#qRound').textContent = `${q.index}/${q.total}`;
    $('#qLabel').textContent = q.label;
    const prompt = $('#qPrompt');
    prompt.textContent = q.prompt;
    prompt.className = `p-prompt${q.promptStyle ? ` is-${q.promptStyle}` : ''}`;

    const form = $('#answerForm');
    const grid = $('#choiceGrid');
    if (q.inputType === 'choice') {
      form.hidden = true;
      grid.hidden = false;
      grid.replaceChildren(...q.options.map((o, i) => h('button', {
        type: 'button',
        class: `choice opt opt-${i}`,
        onclick: (e) => { e.currentTarget.classList.add('picked'); submit(o.id); },
      }, h('span', { class: 'opt-shape' }, LETTERS[i]), h('span', null, o.text))));
    } else {
      grid.hidden = true;
      form.hidden = false;
      const input = $('#answerInput');
      input.value = '';
      const isNumber = q.inputType === 'number';
      input.setAttribute('inputmode', isNumber ? 'decimal' : 'text');
      input.placeholder = isNumber ? (q.unit ? `Un número, en ${q.unit}` : 'Un número') : 'Escribí tu respuesta';
      $('#numberPreview').textContent = '';
      setTimeout(() => input.focus(), 60);
    }
    setSending(false);
    startTimer(q);
    navigator.vibrate?.(60);
  }

  $('#answerInput').addEventListener('input', (e) => {
    const q = state.question;
    const preview = $('#numberPreview');
    if (!q || q.inputType !== 'number') return;
    const raw = e.target.value.trim();
    if (!raw) { preview.textContent = ''; return; }
    const value = parseNumber(raw);
    preview.classList.toggle('bad', value === null);
    preview.textContent = value === null ? 'Eso no parece un número' : `= ${formatNumber(value)}${q.unit ? ` ${q.unit}` : ''}`;
  });

  $('#answerForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = state.question;
    const raw = $('#answerInput').value.trim();
    if (!raw) return toast('Escribí algo primero 🙂');
    if (q.inputType === 'number' && parseNumber(raw) === null) return toast('Ingresá un número, por ejemplo 1.500');
    submit(raw);
  });

  function submit(value) {
    if (state.sending || !state.question) return;
    setSending(true);
    if (!socket.send('player:answer', { roundId: state.question.roundId, value })) {
      setSending(false);
      toast('Sin conexión… reintentá en un segundo.');
    }
  }

  function setSending(sending) {
    state.sending = sending;
    $('#answerBtn').disabled = sending;
    for (const btn of document.querySelectorAll('#choiceGrid button')) btn.disabled = sending;
  }

  function startTimer(q) {
    cancelAnimationFrame(timerFrame);
    const frame = () => {
      const left = Math.max(0, q.endsAt - clock.now());
      const ratio = left / q.durationMs;
      for (const bar of document.querySelectorAll('.js-timer')) {
        bar.style.transform = `scaleX(${ratio})`;
        bar.parentElement.classList.toggle('hurry', left > 0 && left <= 5000);
      }
      if (left > 0 && (state.phase === 'question' || state.phase === 'sent')) timerFrame = requestAnimationFrame(frame);
    };
    frame();
  }

  // ---------- Enviada ----------
  function showSent(value) {
    state.phase = 'sent';
    setSending(false);
    show('screen-sent');
    $('#sentValue').textContent = value || '';
    navigator.vibrate?.(30);
    if (state.question) startTimer(state.question);
  }

  // ---------- Resultado ----------
  function showResult(r) {
    if (!r) return;
    cancelAnimationFrame(timerFrame);
    state.phase = 'result';
    setCategory(r.category);
    const mine = r.results.find((x) => x.name === state.name);
    const rank = r.ranking.find((x) => x.name === state.name);

    let emoji = '⏰';
    let title = '¡Se te pasó el tiempo!';
    let mood = 'bad';
    if (mine?.answered) {
      if (mine.correct) {
        mood = 'ok';
        emoji = mine.closest ? '🎯' : '🎉';
        title = mine.closest ? '¡El más cerca!' : '¡Correcto!';
      } else if (mine.points > 0) {
        mood = 'near';
        emoji = '📏';
        title = '¡Cerca!';
      } else {
        emoji = r.inputType === 'number' ? '🙈' : '❌';
        title = r.inputType === 'number' ? '¡Muy lejos!' : '¡Nooo!';
      }
    }
    setResult(mood);
    show('screen-result');
    $('#resEmoji').textContent = emoji;
    $('#resTitle').textContent = title;
    countUp($('#resPoints'), mine?.total || 0, 800, '+');

    const streak = $('#resStreak');
    streak.hidden = !mine?.streakBonus;
    if (mine?.streakBonus) streak.textContent = `🔥 Racha de ${mine.streak}: +${formatInt(mine.streakBonus)} de bonus`;

    $('#resAnswer').textContent = r.inputType === 'number' && r.unit ? `${r.correctAnswer} ${r.unit}` : r.correctAnswer;
    $('#resRank').textContent = rank
      ? `Vas ${rank.rank}º de ${r.ranking.length} · ${formatInt(rank.score)} pts`
      : '';
    if (rank) state.score = rank.score;
    renderMe();

    if (mood === 'ok') {
      navigator.vibrate?.([60, 40, 120]);
      confetti({ count: 90, duration: 2400 });
    } else if (mood === 'bad') {
      navigator.vibrate?.(200);
    }
  }

  // ---------- Final ----------
  function showOver(f) {
    if (!f) return;
    state.phase = 'over';
    setResult(null);
    setCategory(null);
    show('screen-over');
    const mine = f.ranking.find((x) => x.name === state.name);
    const place = mine?.rank || f.ranking.length;
    $('#overMedal').textContent = place === 1 ? '🏆' : place === 2 ? '🥈' : place === 3 ? '🥉' : '🍷';
    $('#overTitle').textContent = place === 1 ? '¡Ganaste!' : `Terminaste ${place}º`;
    $('#overScore').textContent = `${formatInt(mine?.score || 0)} puntos`;
    $('#overRanking').replaceChildren(...f.ranking.slice(0, 5).map((p) =>
      h('li', { class: p.name === state.name ? 'me' : '' },
        h('span', { class: 'rk' }, p.rank), avatar(p.name), h('span', { class: 'nm' }, p.name), h('span', { class: 'sc' }, formatInt(p.score)))));
    if (place === 1) confetti();
  }

  // ---------- Utilidades ----------
  function renderMe() {
    const me = $('#me');
    me.hidden = !state.joined;
    if (!state.joined) return;
    $('#meAvatar').replaceChildren(avatar(state.name));
    $('#meName').textContent = state.name;
    $('#meScore').textContent = formatInt(state.score);
  }

  function setCategory(category) {
    document.body.dataset.cat = category || 'none';
  }

  function setResult(mood) {
    if (mood) document.body.dataset.result = mood;
    else delete document.body.dataset.result;
  }

  // ---------- Teclado ----------
  // Mientras se escribe, la pantalla se compacta y el formulario sube debajo de la pregunta,
  // así el teclado del celular no tapa el campo ni el botón.
  const touchScreen = window.matchMedia?.('(pointer: coarse)').matches;

  function keepFormVisible() {
    const form = document.activeElement?.closest?.('form');
    if (!form) return;
    const viewport = window.visualViewport;
    const visibleBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
    const overflow = form.getBoundingClientRect().bottom - visibleBottom;
    if (overflow > 0) window.scrollBy({ top: overflow + 12, behavior: 'smooth' });
  }

  document.addEventListener('focusin', (e) => {
    if (!touchScreen || !e.target.matches('input')) return;
    document.body.classList.add('typing');
    setTimeout(keepFormVisible, 350);
  });
  document.addEventListener('focusout', (e) => {
    if (!e.target.matches('input')) return;
    setTimeout(() => {
      if (!document.activeElement?.matches?.('input')) document.body.classList.remove('typing');
    }, 120);
  });
  window.visualViewport?.addEventListener('resize', () => {
    if (document.body.classList.contains('typing')) keepFormVisible();
  });

  // Pantallas sin campo de texto: cierra el teclado si estaba abierto.
  function show(id) {
    if (document.activeElement?.matches?.('input')) document.activeElement.blur();
    document.body.classList.remove('typing');
    showScreen(id);
    window.scrollTo(0, 0);
  }

  // Evita que el celular se duerma en medio de la partida (solo en contextos seguros).
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch { /* no disponible */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.joined) keepAwake();
  });

  // ---------- Arranque ----------
  if (state.code && state.name) {
    show('screen-wait');
    $('#waitAvatar').replaceChildren(avatar(state.name));
    $('#waitTitle').textContent = 'Entrando…';
    $('#waitText').textContent = 'Recuperando tu lugar en la sala.';
  } else {
    showJoin('', !state.code);
  }
})();
