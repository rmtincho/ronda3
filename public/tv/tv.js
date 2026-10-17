(() => {
  'use strict';
  const { clock, connect, $, h, showScreen, toast, session, avatar, countUp, confetti, formatInt } = Ronda3;

  const ROOM_KEY = 'ronda3:tv-room';
  const ROUNDS_KEY = 'ronda3:tv-rounds';
  const SELECTION_KEY = 'ronda3:tv-selection';
  const DIFFICULTY_KEY = 'ronda3:tv-difficulty';
  const CUSTOM_MODE = 'custom';
  const LETTERS = ['A', 'B', 'C', 'D'];
  const ROULETTE_LABELS = [
    '🎸 Rock nacional', '🤘 Rock internacional', '🪗 Tango', '🪕 Folklore', '💃 Cumbia', '🎹 Cuarteto', '📻 Hits y comerciales',
    '🎬 Películas', '📺 Series', '🏆 Mundiales', '🏟️ Copa Libertadores', '⭐ Champions League', '🏀 NBA', '🏛️ Historia', '🌎 Geografía', '🎨 Arte y literatura', '🔬 Ciencia y naturaleza',
  ];
  const ROULETTE_SPIN_MS = 1700;

  const state = {
    roomCode: session.get(ROOM_KEY),
    joinUrl: '',
    rounds: session.get(ROUNDS_KEY) || 10,
    difficulty: session.get(DIFFICULTY_KEY) || 'escalera',
    selection: session.get(SELECTION_KEY) || { mode: 'todo', topics: [] },
    catalog: null,
    modeName: '',
    phase: 'loading',
    players: [],
    knownPlayers: new Set(),
    audioEnabled: true,
    question: null,
    answeredNames: new Set(),
    prevRanks: new Map(),
    resuming: false,
  };
  let timerFrame = 0;
  let nextFrame = 0;
  let introToken = 0;

  // ---------- Efectos de sonido sintetizados (sin archivos) ----------
  const sfx = (() => {
    let ctx = null;
    function audioContext() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
      }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    }
    function tone(freq, { at = 0, dur = 0.12, type = 'sine', gain = 0.07, slide = 0 } = {}) {
      if (!state.audioEnabled) return;
      const c = audioContext();
      if (!c || c.state !== 'running') return;
      const t = c.currentTime + at;
      const osc = c.createOscillator();
      const amp = c.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      if (slide) osc.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
      amp.gain.setValueAtTime(0.0001, t);
      amp.gain.exponentialRampToValueAtTime(gain, t + 0.012);
      amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(amp).connect(c.destination);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    }
    return {
      unlock: audioContext,
      tick: () => tone(1500, { dur: 0.03, type: 'square', gain: 0.025 }),
      land: () => { tone(523, { dur: 0.16, type: 'triangle' }); tone(784, { at: 0.09, dur: 0.3, type: 'triangle' }); },
      hurry: () => tone(880, { dur: 0.09, type: 'triangle', gain: 0.06 }),
      blip: () => tone(1046, { dur: 0.08, type: 'sine', gain: 0.05, slide: 1.5 }),
      reveal: () => [523, 659, 784, 1046].forEach((f, i) => tone(f, { at: i * 0.07, dur: 0.32, type: 'triangle', gain: 0.06 })),
      fanfare: () => [392, 392, 392, 523, 659, 784, 1046].forEach((f, i) => tone(f, { at: i * 0.13, dur: i === 6 ? 0.9 : 0.16, type: 'sawtooth', gain: 0.035 })),
    };
  })();

  // ---------- Audio de las canciones ----------
  const audioCtl = (() => {
    const el = new Audio();
    el.preload = 'auto';
    let prepared = null;
    let failedRound = null;
    let stopTimer = 0;
    let fadeTimer = 0;
    let blockedRetry = null;

    const abs = (url) => new URL(url, location.href).href;
    const clearTimers = () => { clearTimeout(stopTimer); clearInterval(fadeTimer); };

    el.addEventListener('error', () => {
      if (state.phase === 'question' && state.question) markFailed(state.question.roundId);
    });

    document.addEventListener('pointerdown', () => {
      if (!blockedRetry) return;
      const retry = blockedRetry;
      blockedRetry = null;
      $('#audioBlocked').hidden = true;
      retry();
    });

    function markFailed(roundId) {
      if (!roundId) return;
      failedRound = roundId;
      if (state.phase === 'question' && state.question?.roundId === roundId) renderPrompt();
    }

    function prepare({ roundId, url, start }) {
      clearTimers();
      el.pause();
      failedRound = null;
      prepared = { roundId, url: abs(url), start: start || 0 };
      if (!state.audioEnabled) {
        socket.send('tv:audioReady', { roundId, ok: false });
        return;
      }
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        el.removeEventListener('canplay', onReady);
        el.removeEventListener('error', onError);
        clearTimeout(timeout);
        socket.send('tv:audioReady', { roundId, ok });
      };
      const onReady = () => finish(true);
      const onError = () => finish(false);
      el.addEventListener('canplay', onReady);
      el.addEventListener('error', onError);
      const timeout = setTimeout(() => finish(el.readyState >= 2), 4500);
      el.src = prepared.url;
      el.load();
    }

    function play(from, durationSec, roundId) {
      clearTimers();
      el.volume = 1;
      const phaseAtCall = state.phase;
      const go = () => {
        try { el.currentTime = from || 0; } catch { /* todavía no se puede buscar */ }
        el.play().then(() => {
          $('#audioBlocked').hidden = true;
          if (durationSec) stopTimer = setTimeout(() => el.pause(), durationSec * 1000);
        }).catch((err) => {
          if (err && err.name === 'NotAllowedError') {
            $('#audioBlocked').hidden = false;
            blockedRetry = () => { if (state.phase === phaseAtCall) play(from, durationSec, roundId); };
          }
          markFailed(roundId);
        });
      };
      if (el.readyState >= 1) go();
      else el.addEventListener('loadedmetadata', go, { once: true });
    }

    function playQuestion(roundId) {
      if (!state.audioEnabled || !prepared || prepared.roundId !== roundId) return markFailed(roundId);
      play(prepared.start, null, roundId);
    }

    function playClip(roundId, start, cut) {
      if (!state.audioEnabled || !prepared || prepared.roundId !== roundId) return;
      play(start, Math.max(0.5, cut - start), null);
    }

    function reveal(audio) {
      if (!audio || !state.audioEnabled) return fadeOut(800);
      const url = abs(audio.url);
      const keepPlaying = el.src === url && audio.from == null && !el.paused;
      if (!keepPlaying) {
        if (el.src !== url) {
          el.src = url;
          el.load();
        }
        play(audio.from ?? prepared?.start ?? 0, null, null);
      }
      clearTimeout(stopTimer);
      stopTimer = setTimeout(() => fadeOut(1800), 9000);
    }

    function fadeOut(ms = 600) {
      clearTimers();
      if (el.paused) return;
      const steps = Math.max(1, Math.round(ms / 50));
      const delta = el.volume / steps;
      fadeTimer = setInterval(() => {
        const next = el.volume - delta;
        if (next <= 0.02) {
          clearInterval(fadeTimer);
          el.pause();
          el.volume = 1;
        } else {
          el.volume = next;
        }
      }, 50);
    }

    function stop() {
      clearTimers();
      el.pause();
    }

    return { prepare, playQuestion, playClip, reveal, fadeOut, stop, failedFor: (id) => failedRound === id };
  })();

  // ---------- Conexión ----------
  const socket = connect({
    onOpen() {
      if (state.roomCode) {
        state.resuming = true;
        socket.send('tv:resume', { roomCode: state.roomCode });
      } else {
        socket.send('tv:create');
      }
    },
    onStatus(status) { $('#status').dataset.state = status; },
    onMessage(type, payload) { handlers[type]?.(payload); },
  });

  const handlers = {
    'room:created': applyRoom,
    'room:state'(p) {
      state.resuming = false;
      applyRoom(p);
      if (p.catalog) {
        state.catalog = p.catalog;
        renderModes();
      }
      state.players = p.players || [];
      state.audioEnabled = p.audioEnabled !== false;
      renderAudioToggle();
      switch (p.phase) {
        case 'lobby': return showLobby();
        case 'intro': return showIntro(p.intro, true);
        case 'listening': return showListen(p.intro);
        case 'question': return showQuestion(p.question, p.progress);
        case 'reveal': return showReveal(p.reveal);
        case 'over': return showOver(p.final);
        default: return undefined;
      }
    },
    'players:update'(p) {
      state.players = p.players || [];
      renderPlayers();
      if (state.phase === 'question') renderAnswered();
    },
    'round:intro'(p) {
      audioCtl.fadeOut(500);
      showIntro(p, false);
    },
    'round:prepare'(p) {
      if (p.imageUrl) prepareImage(p);
      else audioCtl.prepare(p);
    },
    notice: (p) => toast(p.message, 5000),
    'round:listen'(p) {
      showListen();
      audioCtl.playClip(p.roundId, p.start, p.cut);
    },
    'round:start'(p) {
      showQuestion(p, null);
      if (p.mode === 'audio') audioCtl.playQuestion(p.roundId);
    },
    'round:progress'(p) {
      const fresh = (p.names || []).filter((n) => !state.answeredNames.has(n));
      state.answeredNames = new Set(p.names || []);
      if (fresh.length) sfx.blip();
      renderAnswered(p, fresh);
    },
    'round:reveal'(p) {
      showReveal(p);
      audioCtl.reveal(p.audio);
    },
    'game:over'(p) {
      audioCtl.fadeOut(1500);
      showOver(p);
    },
    error(p) {
      if (p.code === 'ROOM_NOT_FOUND' && state.resuming) {
        state.resuming = false;
        state.roomCode = null;
        session.remove(ROOM_KEY);
        socket.send('tv:create');
        return;
      }
      toast(p.message || 'Algo salió mal.');
    },
  };

  // ---------- Sala ----------
  function applyRoom(p) {
    if (p.roomCode && p.roomCode !== state.roomCode) {
      state.roomCode = p.roomCode;
      session.set(ROOM_KEY, p.roomCode);
    }
    if (p.joinUrl) {
      state.joinUrl = p.joinUrl;
      $('#joinUrl').textContent = p.joinUrl.replace(/^https?:\/\//, '');
      // Online no hace falta estar en la misma Wi-Fi.
      $('#joinStep1').textContent = p.joinUrl.startsWith('https:') ? 'Abrí la cámara del celu' : 'Conectate a la Wi-Fi de la casa';
    }
    if (p.qrDataUrl) $('#qr').src = p.qrDataUrl;
    if (state.roomCode) {
      $('#roomCode').replaceChildren(...[...state.roomCode].map((ch) => h('span', null, ch)));
      $('#barCode').textContent = state.roomCode;
    }
  }

  function setPhase(phase) {
    state.phase = phase;
    $('#barJoin').hidden = phase === 'lobby' || phase === 'loading';
    if (phase !== 'reveal') cancelAnimationFrame(nextFrame);
    if (phase !== 'question') cancelAnimationFrame(timerFrame);
  }

  function setCategory(category) {
    document.body.dataset.cat = category || 'none';
  }

  function setRoundBar(info) {
    if (info?.modeName) state.modeName = info.modeName;
    const mode = state.modeName ? ` · ${state.modeName}` : '';
    $('#barRound').textContent = info ? `Ronda ${info.index} de ${info.total}${mode}` : '';
  }

  // ---------- Escenas de pelis ----------
  // Precarga la imagen y avisa al servidor (mismo mensaje que el audio).
  function prepareImage({ roundId, imageUrl }) {
    const img = new Image();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      socket.send('tv:audioReady', { roundId, ok });
    };
    const timeout = setTimeout(() => finish(img.complete && img.naturalWidth > 0), 4500);
    img.onload = () => finish(true);
    img.onerror = () => finish(false);
    img.src = imageUrl;
  }

  // ---------- Lobby ----------
  function showLobby() {
    setPhase('lobby');
    setCategory(null);
    state.modeName = '';
    setRoundBar(null);
    state.prevRanks = new Map();
    showScreen('screen-lobby');
    renderPlayers();
  }

  function renderPlayers() {
    const list = $('#lobbyPlayers');
    const connected = state.players.filter((p) => p.connected);
    list.replaceChildren(...state.players.map((p) => {
      const isNew = !state.knownPlayers.has(p.name);
      return h('li', { class: `${p.connected ? '' : 'offline'} ${isNew ? 'pop' : ''}`.trim() }, avatar(p.name), p.name);
    }));
    for (const p of state.players) state.knownPlayers.add(p.name);
    $('#playerCount').textContent = connected.length;
    $('#lobbyEmpty').hidden = state.players.length > 0;
    updateStartButton();
  }

  for (const btn of document.querySelectorAll('#roundsPicker button')) {
    btn.classList.toggle('on', Number(btn.dataset.rounds) === state.rounds);
    btn.addEventListener('click', () => {
      state.rounds = Number(btn.dataset.rounds);
      session.set(ROUNDS_KEY, state.rounds);
      for (const b of document.querySelectorAll('#roundsPicker button')) b.classList.toggle('on', b === btn);
    });
  }

  for (const btn of document.querySelectorAll('#levelPicker button')) {
    btn.classList.toggle('on', btn.dataset.difficulty === state.difficulty);
    btn.addEventListener('click', () => {
      state.difficulty = btn.dataset.difficulty;
      session.set(DIFFICULTY_KEY, state.difficulty);
      for (const b of document.querySelectorAll('#levelPicker button')) b.classList.toggle('on', b === btn);
    });
  }

  $('#startBtn').addEventListener('click', () => {
    sfx.unlock();
    const { mode, topics } = state.selection;
    const base = { rounds: state.rounds, difficulty: state.difficulty };
    socket.send('tv:start', mode === CUSTOM_MODE ? { ...base, topics } : { ...base, mode });
  });

  // ---------- Modos de juego ----------
  function renderModes() {
    const catalog = state.catalog;
    if (!catalog) return;
    const selection = state.selection;
    if (selection.mode !== CUSTOM_MODE && !catalog.modes.some((m) => m.id === selection.mode)) {
      selection.mode = catalog.modes[0]?.id || 'todo';
    }
    const card = (id, emoji, name, count) => h('button', {
      class: `mode-card ${selection.mode === id ? 'on' : ''}`.trim(),
      title: name,
      disabled: count === 0,
      onclick: () => {
        selection.mode = id;
        saveSelection();
        renderModes();
      },
    }, h('span', { class: 'mode-emoji' }, emoji), h('span', { class: 'mode-name' }, name));

    $('#modeGrid').replaceChildren(
      ...catalog.modes.map((m) => card(m.id, m.emoji, m.name, m.count)),
      card(CUSTOM_MODE, '🎛️', 'Personalizado', null),
    );

    const chips = $('#topicChips');
    chips.hidden = selection.mode !== CUSTOM_MODE;
    chips.replaceChildren(...catalog.topics.map((t) => h('button', {
      class: `topic-chip ${selection.topics.includes(t.id) ? 'on' : ''}`.trim(),
      onclick: () => {
        selection.topics = selection.topics.includes(t.id)
          ? selection.topics.filter((x) => x !== t.id)
          : [...selection.topics, t.id];
        saveSelection();
        renderModes();
      },
    }, `${t.emoji} ${t.label}`)));
    updateStartButton();
  }

  function saveSelection() {
    session.set(SELECTION_KEY, state.selection);
  }

  function updateStartButton() {
    const hasPlayers = state.players.some((p) => p.connected);
    const customEmpty = state.selection.mode === CUSTOM_MODE && !state.selection.topics.length;
    const btn = $('#startBtn');
    btn.disabled = !hasPlayers || customEmpty;
    btn.textContent = customEmpty ? 'Elegí al menos un tema' : '¡Arrancar!';
  }

  // ---------- Nivel de la ronda ----------
  const LEVEL_STARS = { 1: '★☆☆', 2: '★★☆', 3: '★★★' };
  function setLevelBadge(el, info) {
    el.hidden = !info?.level;
    if (!info?.level) return;
    el.dataset.level = info.level;
    el.textContent = `${LEVEL_STARS[info.level]} ${info.levelLabel || ''}`.trim();
  }

  // ---------- Ruleta ----------
  function showIntro(intro, instant) {
    if (!intro) return;
    setPhase('intro');
    setRoundBar(intro);
    setCategory(null);
    showScreen('screen-intro');
    const token = ++introToken;
    const screen = $('#screen-intro');
    const track = $('#rouletteTrack');
    const label = $('#introLabel');
    $('#introRound').textContent = `RONDA ${intro.index} / ${intro.total}`;
    label.textContent = intro.label;
    setLevelBadge($('#introLevel'), intro);
    label.classList.remove('show');
    screen.classList.remove('landed');

    // La ruleta gira con los temas del modo elegido (si hay variedad), si no con todos.
    const labels = (intro.rouletteLabels || []).length > 1 ? intro.rouletteLabels : ROULETTE_LABELS;
    const pool = labels.filter((l) => l !== intro.genreLabel);
    const items = instant ? [] : Array.from({ length: 18 }, () => pool[Math.floor(Math.random() * pool.length)]);
    items.push(intro.genreLabel);
    track.replaceChildren(...items.map((text) => h('div', { class: 'roulette-item' }, text)));
    track.style.transition = 'none';
    track.style.transform = 'translateY(0)';

    const land = () => {
      if (token !== introToken) return;
      screen.classList.add('landed');
      setCategory(intro.category);
      label.classList.add('show');
      sfx.land();
    };
    if (instant || Ronda3.reducedMotion()) {
      track.replaceChildren(h('div', { class: 'roulette-item' }, intro.genreLabel));
      return land();
    }

    requestAnimationFrame(() => {
      const itemHeight = track.firstElementChild.offsetHeight;
      track.style.transition = `transform ${ROULETTE_SPIN_MS}ms cubic-bezier(.12,.75,.18,1)`;
      track.style.transform = `translateY(${-itemHeight * (items.length - 1)}px)`;
    });
    // Clics de ruleta que se van espaciando
    let delay = 0;
    for (let i = 0, gap = 45; delay < ROULETTE_SPIN_MS - 150; i++, gap *= 1.16) {
      delay += gap;
      setTimeout(() => { if (token === introToken) sfx.tick(); }, delay);
    }
    setTimeout(land, ROULETTE_SPIN_MS + 50);
  }

  // ---------- Escuchar ----------
  function showListen(intro) {
    setPhase('listening');
    if (intro) {
      setRoundBar(intro);
      setCategory(intro.category);
    }
    showScreen('screen-listen');
  }

  // ---------- Pregunta ----------
  function showQuestion(q, progress) {
    if (!q) return;
    state.question = q;
    state.answeredNames = new Set(progress?.names || []);
    setPhase('question');
    setCategory(q.category);
    setRoundBar(q);
    showScreen('screen-question');

    $('#qCat').textContent = q.genreLabel;
    $('#qLabel').textContent = q.label;
    setLevelBadge($('#qLevel'), q);
    renderPrompt();

    const options = $('#qOptions');
    options.hidden = !q.options;
    options.replaceChildren(...(q.options || []).map((o, i) => optionTile(o, i)));

    $('#qUnit').textContent = q.inputType === 'number'
      ? (q.unit ? `Respondan con un número, en ${q.unit}` : 'Respondan con un número')
      : '';
    renderAnswered(progress);
    startTimer(q);
  }

  function optionTile(option, i) {
    return h('li', { class: `opt opt-${i}` }, h('span', { class: 'opt-shape' }, LETTERS[i]), h('span', null, option.text));
  }

  function renderPrompt() {
    const q = state.question;
    if (!q) return;
    const audioMode = q.mode === 'audio' && state.audioEnabled && !audioCtl.failedFor(q.roundId);
    const imageMode = q.mode === 'image' && !!q.imageUrl && state.imageFailed !== q.roundId;
    let text;
    let style;
    if (audioMode) {
      text = 'Suban el volumen y escuchen 🎧';
      style = 'audio';
    } else if (imageMode) {
      text = '¿De dónde es esta escena? 🎬';
      style = 'image';
    } else if (q.mode === 'text') {
      text = q.prompt;
      style = q.promptStyle;
    } else {
      // Falló el audio o la imagen: va la pista escrita.
      text = q.fallbackPrompt;
      style = q.fallbackStyle;
    }
    const el = $('#qPrompt');
    el.textContent = text || '';
    el.className = 'q-prompt';
    if (style) el.classList.add(`is-${style}`);
    if ((text || '').length > 150) el.classList.add('xlong');
    else if ((text || '').length > 90) el.classList.add('long');
    $('#qViz').hidden = !audioMode;

    const frame = $('#qFrame');
    const img = $('#qImage');
    frame.hidden = !imageMode;
    $('#qCard').classList.toggle('has-frame', imageMode);
    if (imageMode && img.getAttribute('src') !== q.imageUrl) {
      img.onerror = () => {
        state.imageFailed = q.roundId;
        renderPrompt();
      };
      img.src = q.imageUrl;
    }
  }

  function renderAnswered(progress, fresh = []) {
    const row = $('#answeredRow');
    const visible = state.players.filter((p) => p.connected || state.answeredNames.has(p.name));
    row.replaceChildren(...visible.map((p) => {
      const done = state.answeredNames.has(p.name);
      const cls = `slot ${done ? 'done' : ''} ${fresh.includes(p.name) ? 'pop' : ''}`.trim();
      return h('span', { class: cls }, avatar(p.name), p.name);
    }));
    const total = progress?.total ?? visible.length;
    const answered = progress?.answered ?? state.answeredNames.size;
    $('#answeredCount').textContent = `${answered}/${total} respondieron`;
  }

  function startTimer(q) {
    cancelAnimationFrame(timerFrame);
    const bar = $('#timerBar');
    const timer = $('#timer');
    const circumference = 2 * Math.PI * 52;
    bar.style.strokeDasharray = circumference;
    let lastSecond = null;
    const frame = () => {
      const left = Math.max(0, q.endsAt - clock.now());
      bar.style.strokeDashoffset = circumference * (1 - left / q.durationMs);
      const seconds = Math.ceil(left / 1000);
      if (seconds !== lastSecond) {
        if (lastSecond !== null && seconds <= 5 && seconds > 0) sfx.hurry();
        lastSecond = seconds;
        $('#timerNum').textContent = seconds;
      }
      timer.classList.toggle('hurry', left > 0 && left <= 5000);
      if (left > 0 && state.phase === 'question') timerFrame = requestAnimationFrame(frame);
    };
    frame();
  }

  // ---------- Revelación ----------
  function showReveal(r) {
    if (!r) return;
    setPhase('reveal');
    setCategory(r.category);
    setRoundBar(r);
    showScreen('screen-reveal');
    sfx.reveal();

    $('#rCat').textContent = r.genreLabel;
    $('#rLabel').textContent = r.label;
    const answer = r.inputType === 'number' && r.unit ? `${r.correctAnswer} ${r.unit}` : r.correctAnswer;
    const answerEl = $('#rAnswer');
    answerEl.textContent = answer;
    answerEl.classList.toggle('long', answer.length > 40);
    $('#rSubtitle').textContent = r.subtitle || '';
    const revealImage = $('#rImage');
    revealImage.hidden = !r.imageUrl;
    if (r.imageUrl) revealImage.src = r.imageUrl;

    const options = $('#rOptions');
    options.hidden = !r.options;
    options.replaceChildren(...(r.options || []).map((o, i) => {
      const tile = optionTile(o, i);
      tile.classList.add(o.id === r.correctOptionId ? 'right' : 'wrong');
      return tile;
    }));

    const unit = r.inputType === 'number' && r.unit ? ` ${r.unit}` : '';
    $('#rResults').replaceChildren(...r.results.map((x, i) => {
      const status = x.correct ? 'ok' : x.answered && x.points > 0 ? 'near' : 'bad';
      const pts = h('b', { class: 'pts' }, '0');
      setTimeout(() => countUp(pts, x.total, 900, '+'), 450 + i * 90);
      return h('li', { class: `res ${status}`, style: `--i:${i}` },
        avatar(x.name),
        h('span', { class: 'res-name' }, x.name),
        h('span', { class: 'res-value' }, x.answered ? `${x.value}${unit}` : 'no respondió'),
        x.closest ? h('span', { class: 'flame' }, '🎯') : null,
        x.streakBonus ? h('span', { class: 'flame' }, `🔥${x.streak}`) : null,
        pts);
    }));
    if (!r.results.length) $('#rResults').append(h('li', { class: 'res bad' }, 'Nadie jugó esta ronda'));

    renderRanking($('#rRanking'), r.ranking.slice(0, 8), true);
    $('#nextBtn').textContent = r.isLast ? 'Ver el final 🏆' : 'Siguiente ▶';
    startNextCountdown(r);
  }

  function renderRanking(list, ranking, withDelta) {
    list.replaceChildren(...ranking.map((p, i) => {
      const prev = state.prevRanks.get(p.name);
      const move = prev == null ? '' : prev > p.rank ? 'up' : prev < p.rank ? 'down' : '';
      return h('li', { class: 'rank-row', style: `--i:${i}` },
        h('span', { class: 'rank-pos' }, p.rank),
        avatar(p.name),
        h('span', { class: 'rank-name' }, p.name),
        move ? h('span', { class: `move ${move}` }, move === 'up' ? '▲' : '▼') : null,
        p.streak >= 2 ? h('span', { class: 'flame' }, `🔥${p.streak}`) : null,
        withDelta && p.delta ? h('span', { class: 'rank-delta' }, `+${formatInt(p.delta)}`) : null,
        h('span', { class: 'rank-score' }, formatInt(p.score)));
    }));
    if (withDelta) state.prevRanks = new Map(ranking.map((p) => [p.name, p.rank]));
  }

  function startNextCountdown(r) {
    cancelAnimationFrame(nextFrame);
    const total = Math.max(1, r.nextAt - clock.now());
    const frame = () => {
      const left = Math.max(0, r.nextAt - clock.now());
      $('#nextBar').style.transform = `scaleX(${left / total})`;
      $('#nextText').textContent = `${r.isLast ? 'El final' : 'La próxima'} en ${Math.ceil(left / 1000)} s`;
      if (left > 0 && state.phase === 'reveal') nextFrame = requestAnimationFrame(frame);
    };
    frame();
  }

  $('#nextBtn').addEventListener('click', () => socket.send('tv:next'));

  // ---------- Final ----------
  function showOver(f) {
    if (!f) return;
    setPhase('over');
    setCategory(null);
    setRoundBar(null);
    showScreen('screen-over');

    const top = f.ranking.slice(0, 3);
    const order = [top[1], top[0], top[2]].filter(Boolean);
    $('#podium').replaceChildren(...order.map((p) => {
      const place = p === top[0] ? 1 : p === top[1] ? 2 : 3;
      return h('div', { class: `podium-col p${place}` },
        avatar(p.name),
        h('span', { class: 'podium-name' }, p.name),
        h('span', { class: 'podium-score' }, `${formatInt(p.score)} pts`),
        h('div', { class: 'podium-block' }, place));
    }));

    const award = $('#award');
    award.hidden = !f.bestStreak;
    if (f.bestStreak) award.textContent = `🔥 Racha de oro: ${f.bestStreak.name}, ${f.bestStreak.value} seguidas`;

    renderRanking($('#finalRanking'), f.ranking.slice(3), false);
    state.prevRanks = new Map();
    setTimeout(() => { if (state.phase === 'over') { confetti(); sfx.fanfare(); } }, 1500);
  }

  $('#againBtn').addEventListener('click', () => socket.send('tv:restart'));

  // ---------- Controles ----------
  function renderAudioToggle() {
    const btn = $('#audioToggle');
    btn.textContent = state.audioEnabled ? '🔊' : '🔇';
    btn.title = state.audioEnabled ? 'Silenciar' : 'Activar sonido';
  }

  $('#audioToggle').addEventListener('click', () => {
    state.audioEnabled = !state.audioEnabled;
    socket.send('tv:setAudio', { enabled: state.audioEnabled });
    if (!state.audioEnabled) audioCtl.stop();
    else sfx.unlock();
    renderAudioToggle();
    if (state.phase === 'question') renderPrompt();
  });

  $('#fullscreenBtn').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  });

  document.addEventListener('pointerdown', () => sfx.unlock(), { once: true });
})();
