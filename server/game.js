// Estado real de una sala y su máquina de estados:
// lobby → intro → (listening) → question → reveal → … → over
const crypto = require('crypto');
const QRCode = require('qrcode');
const { buildPlan, describeCatalog } = require('./questions');
const { resolveAudio } = require('./audio');
const { resolveFrame } = require('./images');
const { scoreAnswers, streakBonus } = require('./scoring');
const { normalize } = require('./matching');
const { parseNumber, formatNumber } = require('../public/shared/number');

const ROUND_MS = Number(process.env.RONDA3_ROUND_MS) || 20000;
const INTRO_MS = Number(process.env.RONDA3_INTRO_MS) || 3000;
const REVEAL_MS = Number(process.env.RONDA3_REVEAL_MS) || 12000;
const MEDIA_LOOKUP_WAIT_MS = 2500;
const MEDIA_READY_TIMEOUT_MS = 5000;
const EARLY_CLOSE_MS = 900;
const ANSWER_GRACE_MS = 300;
const MAX_PLAYERS = 16;
const MAX_NAME = 16;
const MAX_TEXT = 80;
const DEFAULT_ROUNDS = 10;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const withTimeout = (promise, ms, fallback) => Promise.race([promise, sleep(ms).then(() => fallback)]);

function send(ws, type, payload = {}) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type, payload }));
}

function sendError(ws, code, message) {
  send(ws, 'error', { code, message });
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function cleanName(raw) {
  return String(raw ?? '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

class Room {
  constructor(code, joinUrl) {
    this.code = code;
    this.joinUrl = joinUrl;
    this.qrDataUrl = null;
    this.tvs = new Set();
    this.players = new Map(); // clave normalizada del nombre → jugador
    this.phase = 'lobby';
    this.plan = [];
    this.round = null;
    this.intro = null;
    this.listen = null;
    this.question = null;
    this.questionTv = null;
    this.reveal = null;
    this.final = null;
    this.timer = null;
    this.audioEnabled = true;
    this.modeName = '';
    this.rouletteLabels = [];
    this.lastActivity = Date.now();
  }

  async init() {
    this.qrDataUrl = await QRCode.toDataURL(this.joinUrl, {
      margin: 1,
      width: 420,
      color: { dark: '#1a0b2e', light: '#ffffff' },
    });
  }

  // ---------- Conexiones ----------

  attachTv(ws) {
    ws.room = this;
    ws.role = 'tv';
    this.tvs.add(ws);
    this.touch();
    send(ws, 'room:created', { roomCode: this.code, joinUrl: this.joinUrl, qrDataUrl: this.qrDataUrl });
    this.sendState(ws);
  }

  joinPlayer(ws, { name: rawName, token }) {
    const name = cleanName(rawName);
    const key = normalize(name);
    if (!key) return sendError(ws, 'INVALID_NAME', 'Poné un nombre (hasta 16 letras).');

    let player = this.players.get(key);
    let reconnected = false;
    if (player) {
      const sameDevice = !!token && token === player.token;
      if (player.connected && player.ws !== ws && !sameDevice) {
        return sendError(ws, 'NAME_TAKEN', `Ya hay alguien jugando como "${player.name}". Si sos vos, esperá unos segundos y probá de nuevo.`);
      }
      if (player.ws && player.ws !== ws) {
        const old = player.ws;
        old.room = null;
        old.playerKey = null;
        sendError(old, 'SESSION_REPLACED', 'Entraste desde otra pestaña o dispositivo.');
        old.close();
      }
      reconnected = true;
    } else {
      if (this.players.size >= MAX_PLAYERS) return sendError(ws, 'ROOM_FULL', 'La sala está llena.');
      player = {
        key, name, token: crypto.randomUUID(),
        score: 0, streak: 0, bestStreak: 0, lastDelta: 0,
        ws: null, connected: false, joinedAt: Date.now(),
      };
      this.players.set(key, player);
    }

    if (ws.room === this && ws.role === 'player' && ws.playerKey !== key) this.handleDisconnect(ws);
    ws.room = this;
    ws.role = 'player';
    ws.playerKey = key;
    player.ws = ws;
    player.connected = true;
    this.touch();

    send(ws, 'player:welcome', {
      name: player.name, token: player.token, score: player.score, streak: player.streak, reconnected,
    });
    this.sendState(ws);
    this.broadcastPlayers();
  }

  handleDisconnect(ws) {
    if (ws.role === 'tv') {
      this.tvs.delete(ws);
    } else if (ws.role === 'player') {
      const player = this.players.get(ws.playerKey);
      if (player && player.ws === ws) {
        player.ws = null;
        player.connected = false;
        this.broadcastPlayers();
        this.maybeCloseEarly();
      }
    }
    ws.room = null;
    ws.role = null;
    ws.playerKey = null;
    this.touch();
  }

  handleMessage(ws, type, payload) {
    this.touch();
    if (ws.role === 'tv') {
      switch (type) {
        case 'tv:start': return this.startGame(ws, payload);
        case 'tv:next': if (this.phase === 'reveal') this.nextRound(); return;
        case 'tv:restart': return this.restart();
        case 'tv:audioReady': return this.onAudioReady(payload);
        case 'tv:setAudio': this.audioEnabled = payload.enabled !== false; return;
        default: return;
      }
    }
    if (ws.role === 'player' && type === 'player:answer') this.submitAnswer(ws, payload);
  }

  // ---------- Envíos ----------

  toTvs(type, payload) {
    for (const ws of this.tvs) send(ws, type, payload);
  }

  broadcast(type, payload, tvPayload = payload) {
    this.toTvs(type, tvPayload);
    for (const player of this.players.values()) send(player.ws, type, payload);
  }

  broadcastPlayers() {
    this.broadcast('players:update', { players: this.ranking() });
  }

  broadcastState() {
    for (const ws of this.tvs) this.sendState(ws);
    for (const player of this.players.values()) if (player.ws) this.sendState(player.ws);
  }

  sendState(ws) {
    const isTv = ws.role === 'tv';
    const state = {
      role: ws.role,
      roomCode: this.code,
      joinUrl: this.joinUrl,
      phase: this.phase,
      players: this.ranking(),
      audioEnabled: this.audioEnabled,
      serverNow: Date.now(),
    };
    if (isTv) {
      state.qrDataUrl = this.qrDataUrl;
      if (this.phase === 'lobby' || this.phase === 'over') {
        try {
          state.catalog = describeCatalog();
        } catch (err) {
          state.catalog = null;
          sendError(ws, 'QUESTIONS_INVALID', `No pude leer las preguntas: ${err.message}`);
        }
      }
    }
    if (this.phase === 'intro' || this.phase === 'listening') state.intro = this.intro;
    if (this.phase === 'listening') state.listen = this.listen;
    if (this.phase === 'question') {
      state.question = isTv ? this.questionTv : this.question;
      state.progress = this.progress();
    }
    if (this.phase === 'reveal') state.reveal = this.reveal;
    if (this.phase === 'over') state.final = this.final;

    const player = isTv ? null : this.players.get(ws.playerKey);
    if (player) {
      state.you = { name: player.name, score: player.score, streak: player.streak };
      const answer = this.phase === 'question' ? this.round.answers.get(player.key) : null;
      state.you.answered = !!answer;
      state.you.answer = answer ? this.displayValue(this.round.spec, answer.value) : null;
    }
    send(ws, 'room:state', state);
  }

  // ---------- Partida ----------

  // payload: { rounds, mode, difficulty } o { rounds, topics: [...], difficulty } para una combinación personalizada.
  startGame(ws, { rounds, mode, topics, difficulty } = {}) {
    if (this.phase !== 'lobby' && this.phase !== 'over') return;
    if (!this.connectedPlayers().length) return sendError(ws, 'NO_PLAYERS', 'Esperá a que se sume al menos un jugador.');

    const wanted = clampInt(rounds, 3, 30, DEFAULT_ROUNDS);
    let result;
    try {
      result = buildPlan(wanted, { mode, topics: Array.isArray(topics) ? topics : [], difficulty });
    } catch (err) {
      console.error('[preguntas]', err);
      return sendError(ws, 'QUESTIONS_INVALID', `No pude leer las preguntas: ${err.message}`);
    }
    const { plan } = result;
    if (!plan.length) return sendError(ws, 'NO_QUESTIONS', 'Este modo no tiene preguntas. Probá con otro.');
    if (plan.length < wanted) {
      send(ws, 'notice', { message: `«${result.modeName}» tiene ${plan.length} preguntas: la partida va a ser de ${plan.length} rondas.` });
    }

    if (this.phase === 'over') this.resetScores();
    for (const spec of plan) {
      if (spec.audioSong) spec.audioPromise = resolveAudio(spec.audioSong).catch(() => null);
      if (spec.imageMovie) spec.imagePromise = resolveFrame(spec.imageMovie).catch(() => null);
    }
    this.modeName = `${result.modeEmoji || ''} ${result.modeName}`.trim();
    this.rouletteLabels = [...new Set(plan.map((s) => s.genreLabel))];
    this.plan = plan;
    this.round = null;
    this.final = null;
    this.nextRound();
  }

  async nextRound() {
    this.clearTimer();
    const index = this.round ? this.round.index + 1 : 0;
    if (index >= this.plan.length) return this.endGame();

    const spec = this.plan[index];
    const round = {
      id: crypto.randomBytes(4).toString('hex'),
      index,
      spec,
      answers: new Map(),
      audio: null,
      audioUse: null,
      image: null,
      readyResolver: null,
      startedAt: 0,
      endsAt: 0,
      closing: false,
    };
    this.round = round;
    this.phase = 'intro';
    this.listen = this.question = this.questionTv = this.reveal = null;
    const introEndsAt = Date.now() + INTRO_MS;
    this.intro = {
      roundId: round.id,
      index: index + 1,
      total: this.plan.length,
      category: spec.category,
      categoryLabel: spec.categoryLabel,
      genre: spec.genre,
      genreLabel: spec.genreLabel,
      label: spec.label,
      kind: spec.kind,
      level: spec.level,
      levelLabel: spec.levelLabel,
      modeName: this.modeName,
      rouletteLabels: this.rouletteLabels,
    };
    this.broadcast('round:intro', this.intro);

    if (spec.audioSong && this.audioEnabled && this.tvs.size) {
      const audio = await withTimeout(spec.audioPromise || Promise.resolve(null), MEDIA_LOOKUP_WAIT_MS, null);
      if (this.round !== round) return;
      if (audio) {
        round.audio = audio;
        round.audioUse = spec.audioUse;
        if (round.audioUse === 'question' || round.audioUse === 'listen') {
          const start = round.audioUse === 'listen' ? spec.listen.playFrom : audio.start;
          const ok = await this.prepareTvMedia(round, { url: audio.url, start });
          if (this.round !== round) return;
          if (!ok) {
            round.audio = null;
            round.audioUse = null;
          }
        }
      }
    }

    if (spec.imageMovie && this.tvs.size) {
      const image = await withTimeout(spec.imagePromise || Promise.resolve(null), MEDIA_LOOKUP_WAIT_MS, null);
      if (this.round !== round) return;
      if (image && await this.prepareTvMedia(round, { imageUrl: image.url })) round.image = image;
      if (this.round !== round) return;
    }

    await sleep(introEndsAt - Date.now());
    if (this.round !== round) return;

    if (round.audioUse === 'listen') {
      const { playFrom, cutAt } = spec.listen;
      const durationMs = Math.max(1000, (cutAt - playFrom) * 1000);
      this.phase = 'listening';
      this.listen = { roundId: round.id, durationMs };
      this.broadcast('round:listen', this.listen, { ...this.listen, start: playFrom, cut: cutAt });
      await sleep(durationMs + 400);
      if (this.round !== round) return;
    }

    this.startQuestion(round);
  }

  // El tele precarga el audio ({ url, start }) o la imagen ({ imageUrl }) y avisa con tv:audioReady.
  prepareTvMedia(round, media) {
    return new Promise((resolve) => {
      const finish = (ok) => {
        clearTimeout(timeout);
        round.readyResolver = null;
        resolve(ok);
      };
      const timeout = setTimeout(() => finish(false), MEDIA_READY_TIMEOUT_MS);
      round.readyResolver = finish;
      this.toTvs('round:prepare', { roundId: round.id, ...media });
    });
  }

  onAudioReady({ roundId, ok }) {
    if (this.round && this.round.id === roundId && this.round.readyResolver) this.round.readyResolver(!!ok);
  }

  startQuestion(round) {
    const spec = round.spec;
    const now = Date.now();
    round.startedAt = now;
    round.endsAt = now + ROUND_MS;
    const mode = round.image ? 'image' : round.audioUse === 'question' ? 'audio' : 'text';
    const prompts = { audio: spec.audioPrompt, image: spec.imagePrompt, text: spec.textPrompt };

    this.phase = 'question';
    this.question = {
      ...this.intro,
      prompt: prompts[mode],
      promptStyle: mode === 'text' ? spec.promptStyle || null : mode,
      inputType: spec.inputType,
      options: spec.options || null,
      unit: spec.numeric?.unit || null,
      mode,
      endsAt: round.endsAt,
      durationMs: ROUND_MS,
    };
    // El tele recibe además la pista de texto por si el audio falla o se silencia.
    this.questionTv = {
      ...this.question,
      fallbackPrompt: spec.textPrompt,
      fallbackStyle: spec.promptStyle || null,
      imageUrl: round.image?.url || null,
    };
    this.broadcast('round:start', { ...this.question, serverNow: now }, { ...this.questionTv, serverNow: now });
    this.toTvs('round:progress', this.progress());
    this.timer = setTimeout(() => this.closeRound(round), ROUND_MS);
  }

  submitAnswer(ws, { roundId, value }) {
    const player = this.players.get(ws.playerKey);
    if (!player) return;
    const round = this.round;
    if (this.phase !== 'question' || !round || round.id !== roundId) {
      return sendError(ws, 'ROUND_CLOSED', 'La ronda ya cerró.');
    }
    if (round.answers.has(player.key)) return sendError(ws, 'ALREADY_ANSWERED', 'Ya respondiste esta ronda.');
    const at = Date.now();
    if (at > round.endsAt + ANSWER_GRACE_MS) return sendError(ws, 'ROUND_CLOSED', 'Se terminó el tiempo.');

    const parsed = this.parseAnswer(round.spec, value);
    if (parsed === null) {
      return sendError(ws, 'INVALID_ANSWER', round.spec.inputType === 'number' ? 'Ingresá un número.' : 'La respuesta está vacía.');
    }
    round.answers.set(player.key, { value: parsed, at: Math.min(at, round.endsAt) });
    send(ws, 'answer:ack', { roundId, value: this.displayValue(round.spec, parsed) });
    this.toTvs('round:progress', this.progress());
    this.maybeCloseEarly();
  }

  parseAnswer(spec, value) {
    if (spec.inputType === 'number') return parseNumber(value);
    if (spec.inputType === 'choice') return spec.options.some((o) => o.id === value) ? value : null;
    const text = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    return text || null;
  }

  displayValue(spec, value) {
    if (spec.inputType === 'choice') return spec.options.find((o) => o.id === value)?.text ?? '';
    if (spec.inputType === 'number') return formatNumber(value, spec.numeric.plain);
    return value;
  }

  progress() {
    const round = this.round;
    if (!round) return { answered: 0, total: 0, names: [] };
    const total = [...this.players.values()].filter((p) => p.connected || round.answers.has(p.key)).length;
    // Solo quién respondió, nunca qué respondió.
    const names = [...round.answers.keys()].map((key) => this.players.get(key)?.name).filter(Boolean);
    return { answered: round.answers.size, total, names };
  }

  // Si todos los conectados ya respondieron, no tiene sentido esperar el reloj.
  maybeCloseEarly() {
    const round = this.round;
    if (this.phase !== 'question' || !round || round.closing) return;
    const connected = this.connectedPlayers();
    if (!connected.length || !connected.every((p) => round.answers.has(p.key))) return;
    round.closing = true;
    this.clearTimer();
    this.timer = setTimeout(() => this.closeRound(round), EARLY_CLOSE_MS);
  }

  closeRound(round) {
    if (this.round !== round || this.phase !== 'question') return;
    this.clearTimer();
    const spec = round.spec;

    const entries = [...this.players.values()].map((p) => ({ key: p.key, answer: round.answers.get(p.key) || null }));
    const scored = scoreAnswers(spec, entries, { endsAt: round.endsAt, durationMs: ROUND_MS });
    const results = scored.map((s) => {
      const player = this.players.get(s.key);
      const answer = round.answers.get(s.key);
      player.streak = s.correct ? player.streak + 1 : 0;
      player.bestStreak = Math.max(player.bestStreak, player.streak);
      const bonus = s.correct ? streakBonus(player.streak) : 0;
      const total = s.points + bonus;
      player.score += total;
      player.lastDelta = total;
      return {
        name: player.name,
        answered: !!answer,
        value: answer ? this.displayValue(spec, answer.value) : null,
        correct: s.correct,
        closest: !!s.closest,
        points: s.points,
        streakBonus: bonus,
        total,
        streak: player.streak,
        timeMs: answer ? answer.at - round.startedAt : null,
        diff: s.diff ?? null,
      };
    });
    results.sort((a, b) => b.total - a.total || (a.timeMs ?? Infinity) - (b.timeMs ?? Infinity));

    let revealAudio = null;
    if (round.audio && this.audioEnabled) {
      const from = round.audioUse === 'listen' ? spec.listen.cutAt
        : round.audioUse === 'question' ? null // ya está sonando: que siga
        : round.audio.start;
      revealAudio = { url: round.audio.url, from };
    }

    this.phase = 'reveal';
    this.reveal = {
      roundId: round.id,
      index: round.index + 1,
      total: this.plan.length,
      category: spec.category,
      categoryLabel: spec.categoryLabel,
      genre: spec.genre,
      genreLabel: spec.genreLabel,
      label: spec.label,
      kind: spec.kind,
      inputType: spec.inputType,
      options: spec.options || null,
      correctOptionId: spec.correctOptionId || null,
      correctAnswer: spec.correctAnswer,
      unit: spec.numeric?.unit || null,
      subtitle: spec.subtitle || '',
      results,
      ranking: this.ranking(),
      isLast: round.index >= this.plan.length - 1,
      nextAt: Date.now() + REVEAL_MS,
      audio: revealAudio,
      imageUrl: round.image?.url || null,
    };
    this.broadcast('round:reveal', this.reveal);
    this.timer = setTimeout(() => this.nextRound(), REVEAL_MS);
  }

  endGame() {
    this.clearTimer();
    this.phase = 'over';
    this.round = null;
    const best = [...this.players.values()].reduce((top, p) => (p.bestStreak > (top?.bestStreak || 0) ? p : top), null);
    this.final = {
      ranking: this.ranking(),
      bestStreak: best && best.bestStreak >= 2 ? { name: best.name, value: best.bestStreak } : null,
      rounds: this.plan.length,
    };
    this.broadcast('game:over', this.final);
  }

  restart() {
    this.clearTimer();
    this.round = null;
    this.plan = [];
    this.phase = 'lobby';
    this.intro = this.listen = this.question = this.questionTv = this.reveal = this.final = null;
    this.resetScores();
    this.broadcastState();
  }

  resetScores() {
    for (const p of this.players.values()) {
      p.score = 0;
      p.streak = 0;
      p.bestStreak = 0;
      p.lastDelta = 0;
    }
  }

  // ---------- Utilidades ----------

  connectedPlayers() {
    return [...this.players.values()].filter((p) => p.connected);
  }

  ranking() {
    const sorted = [...this.players.values()].sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt);
    let rank = 0;
    let previous = null;
    return sorted.map((p, i) => {
      if (p.score !== previous) {
        rank = i + 1;
        previous = p.score;
      }
      return { rank, name: p.name, score: p.score, delta: p.lastDelta, streak: p.streak, connected: p.connected };
    });
  }

  clearTimer() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  touch() {
    this.lastActivity = Date.now();
  }

  isIdle(maxIdleMs) {
    return !this.tvs.size && !this.connectedPlayers().length && Date.now() - this.lastActivity > maxIdleMs;
  }

  dispose() {
    this.clearTimer();
    this.round = null;
  }
}

module.exports = { Room, send, sendError };
