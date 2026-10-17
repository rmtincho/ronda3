// Lee el banco (data/questions.json + data/packs/*.json) y los modos (data/modes.json),
// y arma el plan de rondas de una partida. Todo se relee al empezar cada partida,
// así los cambios entran sin reiniciar el servidor.
const fs = require('fs');
const path = require('path');
const { isMatch, normalize } = require('./matching');
const { formatNumber } = require('../public/shared/number');
const history = require('./history');
const { canHaveFrame } = require('./images');

const DATA_DIR = path.join(__dirname, '..', 'data');
const MAIN_FILE = path.join(DATA_DIR, 'questions.json');
const PACKS_DIR = path.join(DATA_DIR, 'packs');
const MODES_FILE = path.join(DATA_DIR, 'modes.json');
const AFFINITY_FILE = path.join(DATA_DIR, 'afinidades.json');
const LEVELS_FILE = path.join(DATA_DIR, 'niveles.json');

const BANK_TYPES = ['songs', 'movies', 'trivia', 'estimates'];
// Géneros musicales que cuentan como "Bien argentino".
const ARGENTINE_GENRES = new Set(['rock_nacional', 'tango', 'cumbia', 'cuarteto', 'folklore']);
// En "Todo mezclado", la música (que tiene audio) y el cine salen un poco más seguido.
const TOPIC_WEIGHTS = { musica: 2, cine: 1.5 };

const DECADES = ['10s', '20s', '30s', '40s', '50s', '60s', '70s', '80s', '90s', '2000s', '2010s', '2020s'];
const DECADE_LABELS = {
  '10s': 'Años 1910', '20s': 'Años 1920', '30s': 'Años 1930', '40s': 'Años 1940', '50s': 'Años 50',
  '60s': 'Años 60', '70s': 'Años 70', '80s': 'Años 80', '90s': 'Años 90',
  '2000s': 'Años 2000', '2010s': 'Años 2010', '2020s': 'Años 2020',
};

// Dificultad de la partida: «escalera» arranca fácil y termina difícil.
const DIFFICULTIES = ['facil', 'escalera', 'dificil'];
const LEVEL_LABELS = { 1: 'Fácil', 2: 'Media', 3: 'Difícil' };
// Las canciones y pelis no tienen nivel fijo: según el nivel de la ronda cambia qué se pregunta…
const SONG_KIND_WEIGHTS = {
  1: { title: 3, artist: 4, continue: 1, decade: 0 },
  2: { title: 3, artist: 3, continue: 3, decade: 1 },
  3: { title: 3, artist: 2, continue: 4, decade: 2 },
};
const MOVIE_KIND_WEIGHTS = {
  1: { frame: 4, title: 4, character: 1, year: 0, seasons: 0 },
  2: { frame: 4, title: 3, character: 3, year: 1, seasons: 1 },
  3: { frame: 3, title: 2, character: 4, year: 2, seasons: 1 },
};
// …y cuánto se parecen las opciones falsas: el azar que se suma al puntaje de parecido
// (en fácil se mezclan más; en difícil salen las más parecidas).
const DECOY_JITTER = { 1: 5, 2: 2.5, 3: 1 };
const AUDIO_PROMPT = 'Escuchá el tele 🎵';
const IMAGE_PROMPT = 'Mirá el tele 👀';
const OPTION_IDS = ['a', 'b', 'c', 'd'];

const list = (value) => (Array.isArray(value) ? value : []);
const pick = (items) => items[Math.floor(Math.random() * items.length)];

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function weightedPick(weights) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  let roll = Math.random() * entries.reduce((sum, [, w]) => sum + w, 0);
  for (const [key, weight] of entries) {
    roll -= weight;
    if (roll < 0) return key;
  }
  return entries[entries.length - 1][0];
}

// ---------- Lectura de archivos ----------

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${path.relative(DATA_DIR, file)}: ${err.message}`);
  }
}

function packFiles() {
  if (!fs.existsSync(PACKS_DIR)) return [];
  return fs.readdirSync(PACKS_DIR).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(PACKS_DIR, f));
}

function loadBank() {
  const bank = { songs: [], movies: [], trivia: [], estimates: [] };
  const seen = new Set();
  for (const file of [MAIN_FILE, ...packFiles()]) {
    const raw = readJson(file);
    for (const type of BANK_TYPES) {
      for (const item of list(raw[type])) {
        if (!item || !item.id) continue;
        const key = `${type}:${item.id}`;
        if (seen.has(key)) {
          console.warn(`[preguntas] id repetido "${item.id}" en ${path.basename(file)}; se ignora.`);
          continue;
        }
        seen.add(key);
        bank[type].push(item);
      }
    }
  }
  bank.songs = bank.songs.filter((s) => s.answer);
  bank.movies = bank.movies.filter((m) => m.answer);
  bank.trivia = bank.trivia.filter((t) => t.question && t.answer && list(t.decoys).length);
  bank.estimates = bank.estimates.filter((e) => e.question && Number.isFinite(Number(e.answer)));
  return bank;
}

function loadConfig() {
  const raw = readJson(MODES_FILE);
  return { topics: raw.topics || {}, subtopics: raw.subtopics || {}, modes: list(raw.modes) };
}

// id → nivel (1 fácil, 3 difícil). Lo que no figura es de nivel medio.
function loadLevels() {
  const levels = new Map();
  if (!fs.existsSync(LEVELS_FILE)) return levels;
  const raw = readJson(LEVELS_FILE);
  for (const id of list(raw.faciles)) levels.set(id, 1);
  for (const id of list(raw.dificiles)) levels.set(id, 3);
  return levels;
}

// Escenas musicales, otros temas de cada artista y grupos de pelis parecidas (ver data/afinidades.json).
function loadAffinity() {
  const raw = fs.existsSync(AFFINITY_FILE) ? readJson(AFFINITY_FILE) : {};
  const scenesOf = new Map();
  const sceneEras = new Map();
  for (const [id, scene] of Object.entries(raw.escenas || {})) {
    sceneEras.set(id, list(scene.decadas).map((d) => DECADES.indexOf(d)).filter((i) => i >= 0));
    for (const artist of list(scene.artistas)) {
      const key = normalize(artist);
      if (!scenesOf.has(key)) scenesOf.set(key, new Set());
      scenesOf.get(key).add(id);
    }
  }
  const groupsOf = new Map();
  for (const [group, ids] of Object.entries(raw.grupos || {})) {
    for (const id of list(ids)) {
      if (!groupsOf.has(id)) groupsOf.set(id, new Set());
      groupsOf.get(id).add(group);
    }
  }
  return {
    scenesOf,
    sceneEras,
    sceneArtists: Object.values(raw.escenas || {}).flatMap((s) => list(s.artistas)),
    titlesOf: Object.entries(raw.temas || {}).map(([artist, titles]) => ({ artist, titles: list(titles) })),
    groupsOf,
  };
}

// ---------- Etiquetas y filtros ----------

function decadeOfYear(year) {
  if (!year) return null;
  const decade = year < 2000 ? `${String(year).slice(2, 3)}0s` : `${Math.floor(year / 10) * 10}s`;
  return DECADES.includes(decade) ? decade : null;
}

function decadeOf(item) {
  return DECADES.includes(item.decade) ? item.decade : decadeOfYear(Number(item.year));
}

// Nivel fijo de una pregunta; las canciones y pelis sin nivel propio (null) se adaptan al de la ronda.
function entryLevel(type, item, levels) {
  const own = Number(item.level);
  if ([1, 2, 3].includes(own)) return own;
  if (type === 'song' || type === 'movie') return null;
  return levels.get(item.id) || 2;
}

// Época de una pregunta, solo para no repetir la misma década en rondas seguidas
// (por ejemplo, que en Mundiales no salgan tres de Qatar 2022 al hilo).
function entryEra(type, item) {
  const decade = decadeOf(item) || list(item.tags).find((t) => DECADES.includes(t));
  if (decade) return decade;
  if (type !== 'trivia' && type !== 'estimate') return null;
  const year = String(item.question).match(/\b(19\d\d|20\d\d)\b/);
  return year ? decadeOfYear(Number(year[1])) : null;
}

// Cada pregunta posible es una "entrada" con tema, subtema, nivel, época y etiquetas para los modos.
function bankEntries(bank, levels = new Map()) {
  const entries = [];
  const add = (type, item, topic, subtopic, extraTags = []) => {
    const tags = new Set(['all', topic, subtopic, decadeOf(item), ...list(item.tags), ...extraTags].filter(Boolean));
    entries.push({
      type, item, topic, subtopic: subtopic || null, tags, key: `${type}:${item.id}`,
      level: entryLevel(type, item, levels), era: entryEra(type, item),
    });
  };
  for (const s of bank.songs) add('song', s, 'musica', s.genre || 'pop_hits', ARGENTINE_GENRES.has(s.genre) ? ['argentina'] : []);
  for (const m of bank.movies) add('movie', m, 'cine', m.kind === 'series' ? 'series' : 'peliculas');
  for (const t of bank.trivia) add('trivia', t, t.topic || 'cultura', t.subtopic);
  for (const e of bank.estimates) add('estimate', e, e.topic || 'cultura', e.subtopic, ['estimaciones']);
  return entries;
}

// Un modo incluye una entrada si tiene alguna etiqueta de `include` y todas las de `require`.
function matchesFilter(tags, filter) {
  const include = list(filter.include);
  return (!include.length || include.some((t) => tags.has(t))) && list(filter.require).every((t) => tags.has(t));
}

function resolveSelection(selection, config) {
  const custom = list(selection?.topics).filter((t) => config.topics[t]);
  if (custom.length) {
    return { name: custom.map((t) => config.topics[t].label).join(' + '), emoji: '🎛️', include: custom };
  }
  const mode = config.modes.find((m) => m.id === selection?.mode) || config.modes[0] || { name: 'Todo mezclado', include: ['all'] };
  return { name: mode.name, emoji: mode.emoji || '', include: list(mode.include), require: list(mode.require) };
}

function makeContext(bank, config, affinity = loadAffinity()) {
  const topicLabel = (id) => {
    const topic = config.topics[id];
    return topic ? `${topic.emoji} ${topic.label}` : id;
  };
  return {
    bank,
    config,
    affinity,
    artists: artistProfiles(bank.songs, affinity),
    level: 2,
    topicLabel,
    subLabel: (topic, sub) => config.subtopics[sub] || topicLabel(topic),
  };
}

// Para el lobby del tele: temas y modos con cuántas preguntas tiene cada uno.
function describeCatalog() {
  const config = loadConfig();
  const entries = bankEntries(loadBank(), loadLevels());
  return {
    topics: Object.entries(config.topics).map(([id, t]) => ({
      id, label: t.label, emoji: t.emoji, count: entries.filter((e) => e.topic === id).length,
    })),
    modes: config.modes.map((m) => ({
      id: m.id, name: m.name, emoji: m.emoji, description: m.description || '',
      count: entries.filter((e) => matchesFilter(e.tags, m)).length,
    })),
  };
}

function describeBank() {
  try {
    const bank = loadBank();
    const config = loadConfig();
    return `${bank.songs.length} canciones, ${bank.movies.length} pelis/series, ${bank.trivia.length} preguntas generales, `
      + `${bank.estimates.length} estimaciones · ${config.modes.length} modos`;
  } catch (err) {
    return `⚠️  No pude leer el banco de preguntas: ${err.message}`;
  }
}

// ---------- Opciones ----------

function choiceOptions(correctText, otherTexts) {
  const texts = shuffle([correctText, ...otherTexts.slice(0, 3)]);
  return {
    options: texts.map((text, i) => ({ id: OPTION_IDS[i], text })),
    correctOptionId: OPTION_IDS[texts.indexOf(correctText)],
  };
}

// Tres opciones falsas creíbles: primero las fijas del JSON, después las de `ranked` (ya ordenadas
// por parecido), las de `nearby` (mismo género o tipo) y por último las de `others`. Se descartan
// las que también serían correctas (por ejemplo, Calamaro en un tema de Los Abuelos, o un alias del título).
function pickDecoys(accepted, { fixed = [], ranked = [], nearby = [], others = [], names = false }) {
  const seen = new Set(accepted.map(normalize));
  const decoys = [];
  const consider = (text) => {
    if (decoys.length >= 3) return;
    const key = normalize(text);
    if (!key || seen.has(key) || isMatch(text, accepted, { names })) return;
    seen.add(key);
    decoys.push(text);
  };
  list(fixed).forEach(consider);
  ranked.forEach(consider);
  shuffle(nearby).forEach(consider);
  shuffle(others).forEach(consider);
  return decoys;
}

// Ordena candidatos { text, score } del más al menos parecido, con un poco de azar según el nivel.
function rankByScore(candidates, level) {
  const jitter = DECOY_JITTER[level] ?? DECOY_JITTER[2];
  return candidates
    .map((c) => ({ text: c.text, roll: c.score + Math.random() * jitter }))
    .sort((a, b) => b.roll - a.roll)
    .map((c) => c.text);
}

const shares = (a, b) => [...a].some((x) => b.has(x));

// Distancia en décadas entre dos conjuntos de épocas (índices de DECADES); sin datos, una y media.
function eraGap(a, b) {
  if (!a.size || !b.size) return 1.5;
  let best = Infinity;
  for (const x of a) for (const y of b) best = Math.min(best, Math.abs(x - y));
  return best;
}

// «Charly García» no puede ser opción falsa de «Charly García y Luis Alberto Spinetta», ni al revés.
function overlapsName(text, accepted) {
  const a = ` ${normalize(text)} `;
  return accepted.some((name) => {
    const b = ` ${normalize(name)} `;
    return b.trim() && (a.includes(b) || b.includes(a));
  });
}

// Perfil de cada artista conocido (del banco o de las escenas): géneros, épocas y escenas.
function artistProfiles(songs, affinity) {
  const profiles = new Map();
  const get = (name) => {
    const key = normalize(name);
    if (!profiles.has(key)) profiles.set(key, { name, genres: new Set(), eras: new Set(), scenes: affinity.scenesOf.get(key) || new Set() });
    return profiles.get(key);
  };
  for (const s of songs) {
    if (!s.artist) continue;
    const profile = get(s.artist);
    profile.genres.add(s.genre);
    const decade = decadeOf(s);
    if (decade) profile.eras.add(DECADES.indexOf(decade));
  }
  for (const name of affinity.sceneArtists) {
    const profile = get(name);
    if (profile.eras.size) continue;
    for (const scene of profile.scenes) for (const era of affinity.sceneEras.get(scene) || []) profile.eras.add(era);
  }
  return profiles;
}

function songProfile(song, ctx) {
  const artist = ctx.artists.get(normalize(song.artist || ''));
  const decade = decadeOf(song);
  return {
    artistKey: normalize(song.artist || ''),
    scenes: song.scene ? new Set([song.scene]) : artist?.scenes || new Set(),
    eras: decade ? new Set([DECADES.indexOf(decade)]) : artist?.eras || new Set(),
  };
}

// Parecido musical: misma escena (movida y época) pesa más que mismo género; lejos en el tiempo, resta.
function musicScore(me, song, other, otherGenres) {
  return (shares(me.scenes, other.scenes) ? 4 : 0)
    + (otherGenres.has(song.genre) ? 2 : 0)
    - 0.7 * Math.min(4, eraGap(me.eras, other.eras));
}

function decadeChoices(correct) {
  const index = DECADES.indexOf(correct);
  const start = Math.min(Math.max(0, index - Math.floor(Math.random() * 4)), DECADES.length - 4);
  const labels = DECADES.slice(start, start + 4).map((d) => DECADE_LABELS[d]);
  return choiceOptions(DECADE_LABELS[correct], labels.filter((l) => l !== DECADE_LABELS[correct]));
}

function baseSpec(entry, ctx, kind) {
  return {
    category: entry.topic,
    categoryLabel: ctx.topicLabel(entry.topic),
    genre: entry.subtopic,
    genreLabel: ctx.subLabel(entry.topic, entry.subtopic),
    kind,
    level: ctx.level,
    levelLabel: LEVEL_LABELS[ctx.level],
    historyKey: entry.key,
    audioSong: null,
    audioUse: null,
  };
}

// ---------- Canciones ----------

function hasContinue(song) {
  const c = song.continue;
  return !!(c && c.previousLine && c.line && list(c.decoys).length >= 1);
}

function songKinds(song, level = 2) {
  const kindWeights = (base) => {
    const weights = {
      title: base.title,
      artist: song.artist ? base.artist : 0,
      continue: hasContinue(song) ? base.continue : 0,
      decade: decadeOf(song) ? base.decade : 0,
    };
    for (const kind of list(song.skipKinds)) weights[kind] = 0;
    return weights;
  };
  const weights = kindWeights(SONG_KIND_WEIGHTS[level] || SONG_KIND_WEIGHTS[2]);
  return Object.values(weights).some((w) => w > 0) ? weights : kindWeights(SONG_KIND_WEIGHTS[2]);
}

// Opciones de «¿Quién la canta?»: artistas de la misma movida y época, aunque no tengan temas en el banco.
function artistDecoys(song, ctx) {
  const accepted = [song.artist, ...list(song.artistAliases)];
  const me = songProfile(song, ctx);
  const candidates = [...ctx.artists.values()]
    .filter((p) => !overlapsName(p.name, accepted))
    .map((p) => ({ text: p.name, score: musicScore(me, song, p, p.genres) }));
  return pickDecoys(accepted, { fixed: song.artistDecoys, ranked: rankByScore(candidates, ctx.level), names: true });
}

// Opciones de «¿Nombre de la canción?»: temas de artistas parecidos (misma movida y época),
// nunca del mismo artista: con su voz sonando, cuatro temas suyos no se distinguen por el estilo.
function titleDecoys(song, ctx) {
  const accepted = [song.answer, ...list(song.aliases)];
  const me = songProfile(song, ctx);
  const sameArtist = (name) => overlapsName(name, [song.artist || '', ...list(song.artistAliases)]);
  // Títulos que este artista también canta, aunque figuren a nombre de otro (covers): tampoco sirven de opción falsa.
  const ownTitles = new Set([
    ...ctx.bank.songs.filter((s) => s.artist && sameArtist(s.artist)).map((s) => normalize(s.answer)),
    ...ctx.affinity.titlesOf.filter(({ artist }) => sameArtist(artist)).flatMap(({ titles }) => titles.map(normalize)),
  ]);
  const candidates = [];
  const add = (title, artistName) => {
    const artistKey = normalize(artistName || '');
    if (!artistKey || sameArtist(artistName) || ownTitles.has(normalize(title))) return;
    const profile = ctx.artists.get(artistKey) || { scenes: new Set(), eras: new Set(), genres: new Set() };
    candidates.push({ text: title, score: musicScore(me, song, profile, profile.genres) });
  };
  for (const s of ctx.bank.songs) if (s.id !== song.id) add(s.answer, s.artist);
  for (const { artist, titles } of ctx.affinity.titlesOf) for (const title of titles) add(title, artist);
  return pickDecoys(accepted, { fixed: song.titleDecoys, ranked: rankByScore(candidates, ctx.level) });
}

function songSpec(song, kind, entry, ctx) {
  const when = song.year || DECADE_LABELS[decadeOf(song)] || '';
  const titleAndArtist = `«${song.answer}» — ${song.artist || ''}`.replace(/ — $/, '');
  const base = {
    ...baseSpec(entry, ctx, kind),
    audioSong: song.noAudio ? null : song,
    audioUse: 'question',
  };

  switch (kind) {
    case 'artist':
      return {
        ...base,
        ...choiceOptions(song.artist, artistDecoys(song, ctx)),
        label: '¿Quién la canta?',
        inputType: 'choice',
        audioPrompt: AUDIO_PROMPT,
        textPrompt: `«${song.answer}»`,
        correctAnswer: song.artist,
        subtitle: [`«${song.answer}»`, when].filter(Boolean).join(' · '),
      };
    case 'continue': {
      const c = song.continue;
      const lyric = `«${c.previousLine}…»`;
      const listen = c.cutAt != null
        ? { cutAt: Number(c.cutAt), playFrom: Number(c.playFrom ?? song.audioStart ?? 0) }
        : null;
      return {
        ...base,
        ...choiceOptions(c.line, shuffle(list(c.decoys))),
        label: '¿Cómo sigue?',
        inputType: 'choice',
        audioPrompt: lyric,
        textPrompt: lyric,
        promptStyle: 'lyric',
        correctAnswer: c.line,
        subtitle: titleAndArtist,
        listen,
        // Sin punto de corte, el tema suena recién en la revelación.
        audioUse: listen ? 'listen' : 'reveal',
      };
    }
    case 'decade':
      return {
        ...base,
        ...decadeChoices(decadeOf(song)),
        label: '¿De qué década es?',
        inputType: 'choice',
        audioPrompt: AUDIO_PROMPT,
        textPrompt: titleAndArtist,
        correctAnswer: DECADE_LABELS[decadeOf(song)],
        subtitle: [titleAndArtist, song.year].filter(Boolean).join(' · '),
      };
    default:
      return {
        ...base,
        ...choiceOptions(song.answer, titleDecoys(song, ctx)),
        label: '¿Nombre de la canción?',
        inputType: 'choice',
        audioPrompt: AUDIO_PROMPT,
        textPrompt: song.hint || `Un tema de ${song.artist}`,
        promptStyle: song.hint ? 'hint' : null,
        correctAnswer: song.answer,
        subtitle: [song.artist, when].filter(Boolean).join(' · '),
      };
  }
}

// ---------- Pelis y series ----------

function validCharacters(movie) {
  return list(movie.characters).filter((c) => c && c.prompt && c.answer);
}

function movieKinds(movie, level = 2) {
  const kindWeights = (base) => ({
    frame: canHaveFrame(movie) ? base.frame : 0,
    title: movie.hint ? base.title : 0,
    character: validCharacters(movie).length ? base.character : 0,
    year: Number(movie.year) ? base.year : 0,
    seasons: Number(movie.seasons) ? base.seasons : 0,
  });
  const weights = kindWeights(MOVIE_KIND_WEIGHTS[level] || MOVIE_KIND_WEIGHTS[2]);
  return Object.values(weights).some((w) => w > 0) ? weights : kindWeights(MOVIE_KIND_WEIGHTS[2]);
}

// Parecido entre pelis o series: mismo grupo (animación, policiales argentinos, sitcoms…),
// mismo tipo, ambas argentinas y años cercanos.
function movieScore(movie, other, affinity) {
  const isArg = (m) => list(m.tags).includes('argentina');
  const groups = (m) => affinity.groupsOf.get(m.id) || new Set();
  return (shares(groups(movie), groups(other)) ? 5 : 0)
    + ((movie.kind === 'series') === (other.kind === 'series') ? 2 : -3)
    + (isArg(movie) === isArg(other) ? 1.5 : 0)
    - 0.5 * Math.min(4, Math.abs((Number(movie.year) || 2000) - (Number(other.year) || 2000)) / 8);
}

function movieSpec(movie, kind, entry, ctx) {
  const isSeries = movie.kind === 'series';
  const others = ctx.bank.movies.filter((m) => m.id !== movie.id);
  const ranked = (toTexts) => rankByScore(
    others.flatMap((m) => toTexts(m).map((text) => ({ text, score: movieScore(movie, m, ctx.affinity) }))),
    ctx.level,
  );
  const title = `«${movie.answer}»`;
  const what = isSeries ? 'Serie' : 'Película';
  const base = baseSpec(entry, ctx, kind);

  switch (kind) {
    case 'character': {
      const character = pick(validCharacters(movie));
      // Primero otros personajes de la misma historia: son las opciones falsas más tramposas.
      // Después, personajes de historias parecidas.
      const decoys = pickDecoys([character.answer, ...list(character.aliases)], {
        fixed: [...list(character.decoys), ...shuffle(validCharacters(movie).filter((c) => c !== character)).map((c) => c.answer)],
        ranked: ranked((m) => validCharacters(m).map((c) => c.answer)),
        names: true,
      });
      return {
        ...base,
        ...choiceOptions(character.answer, decoys),
        label: '¿Nombre del personaje?',
        inputType: 'choice',
        textPrompt: character.prompt,
        correctAnswer: character.answer,
        subtitle: `${what} · ${title}`,
      };
    }
    case 'year':
      return {
        ...base,
        label: '¿En qué año se estrenó?',
        inputType: 'number',
        numeric: { answer: Number(movie.year), tolerance: 10, unit: null, plain: true },
        textPrompt: title,
        correctAnswer: String(movie.year),
        subtitle: what,
      };
    case 'seasons': {
      const seasons = Number(movie.seasons);
      return {
        ...base,
        label: '¿Cuántas temporadas tiene?',
        inputType: 'number',
        numeric: { answer: seasons, tolerance: Math.max(2, Math.ceil(seasons * 0.5)), unit: 'temporadas', plain: true },
        textPrompt: title,
        correctAnswer: String(seasons),
        subtitle: `${what} · ${movie.year}`,
      };
    }
    default: {
      // Título (con pista escrita) o frame (con una escena en el tele; si no carga, va la pista).
      // Opciones falsas: las más parecidas (mismo grupo y tipo, época cercana).
      const decoys = pickDecoys([movie.answer, ...list(movie.aliases)], {
        fixed: movie.titleDecoys,
        ranked: ranked((m) => [m.answer]),
      });
      const hint = movie.hint || `${what} de ${movie.year}`;
      return {
        ...base,
        ...choiceOptions(movie.answer, decoys),
        label: kind === 'frame'
          ? (isSeries ? '¿De qué serie es esta escena?' : '¿De qué peli es esta escena?')
          : (isSeries ? '¿Nombre de la serie?' : '¿Nombre de la peli?'),
        inputType: 'choice',
        imageMovie: kind === 'frame' ? movie : null,
        imagePrompt: IMAGE_PROMPT,
        textPrompt: hint,
        promptStyle: /^[«"“]/.test(hint) ? 'quote' : 'hint',
        correctAnswer: movie.answer,
        subtitle: [what, movie.year].filter(Boolean).join(' · '),
      };
    }
  }
}

// ---------- Preguntas generales y estimaciones ----------

function triviaSpec(item, entry, ctx) {
  const topic = ctx.config.topics[entry.topic] || {};
  return {
    ...baseSpec(entry, ctx, 'trivia'),
    ...choiceOptions(item.answer, shuffle(list(item.decoys))),
    label: item.label || topic.questionLabel || 'Pregunta',
    inputType: 'choice',
    textPrompt: item.question,
    correctAnswer: item.answer,
    subtitle: item.note || '',
  };
}

function estimateSpec(item, entry, ctx) {
  const answer = Number(item.answer);
  const plain = item.format === 'plain';
  return {
    ...baseSpec(entry, ctx, 'estimate'),
    label: item.label || 'Estimación',
    inputType: 'number',
    numeric: {
      answer,
      tolerance: Number(item.tolerance) > 0 ? Number(item.tolerance) : Math.abs(answer) * 0.5 || 1,
      unit: item.unit || null,
      plain,
    },
    textPrompt: item.question,
    correctAnswer: formatNumber(answer, plain),
    subtitle: item.note || '',
  };
}

function buildSpec(entry, ctx) {
  switch (entry.type) {
    case 'song': return songSpec(entry.item, weightedPick(songKinds(entry.item, ctx.level)), entry, ctx);
    case 'movie': return movieSpec(entry.item, weightedPick(movieKinds(entry.item, ctx.level)), entry, ctx);
    case 'trivia': return triviaSpec(entry.item, entry, ctx);
    default: return estimateSpec(entry.item, entry, ctx);
  }
}

// ---------- Plan de partida ----------

// Nivel buscado para cada ronda. En escalera: el primer tercio fácil, el segundo medio y el resto difícil.
function targetLevel(difficulty, index, count) {
  if (difficulty === 'facil') return 1;
  if (difficulty === 'dificil') return 3;
  return 1 + Math.min(2, Math.floor((3 * index) / Math.max(1, count)));
}

// Aplica el primer filtro que deja alguna pregunta que nunca salió; si todas ya salieron alguna vez,
// el primero que deja algo. Así preferir un nivel o una época no hace repetir preguntas entre cenas.
function narrow(candidates, filters) {
  const options = filters.map((f) => candidates.filter(f)).filter((o) => o.length);
  return options.find((o) => o.some((e) => history.isNew(e.key))) || options[0] || candidates;
}

// selection: { mode: 'rock', difficulty: 'escalera' } o { topics: ['historia', 'geografia'] }
function buildPlan(count, selection) {
  const config = loadConfig();
  const bank = loadBank();
  const ctx = makeContext(bank, config);
  const filter = resolveSelection(selection, config);
  const difficulty = DIFFICULTIES.includes(selection?.difficulty) ? selection.difficulty : 'escalera';
  const pool = bankEntries(bank, loadLevels()).filter((e) => matchesFilter(e.tags, filter)
    && (e.type !== 'movie' || Object.values(movieKinds(e.item)).some((w) => w > 0)));

  const used = new Set();
  const plan = [];
  const recentEras = [];
  let lastTopic = null;
  let lastSubtopic = null;

  for (let i = 0; i < count; i++) {
    const remaining = pool.filter((e) => !used.has(e.key));
    if (!remaining.length) break;
    const level = targetLevel(difficulty, i, count);

    // Tema distinto al de la ronda anterior (si hay más de uno), con peso por tema.
    const topics = [...new Set(remaining.map((e) => e.topic))];
    const topicOptions = topics.length > 1 ? topics.filter((t) => t !== lastTopic) : topics;
    const topic = weightedPick(Object.fromEntries(topicOptions.map((t) => [t, TOPIC_WEIGHTS[t] || 1])));

    // Dentro del tema, subtema sorteado parejo y distinto al anterior.
    let candidates = remaining.filter((e) => e.topic === topic);
    const subtopics = [...new Set(candidates.map((e) => e.subtopic))];
    if (subtopics.length > 1) {
      const subtopic = pick(subtopics.filter((s) => s !== lastSubtopic));
      candidates = candidates.filter((e) => e.subtopic === subtopic);
    }

    // Del nivel de la ronda (o lo más cercano), y de una época que no haya salido en las dos rondas anteriores.
    candidates = narrow(candidates, [
      (e) => e.level === null || e.level === level,
      (e) => Math.abs(e.level - level) === 1,
    ]);
    const eras = shuffle([...new Set(candidates.map((e) => e.era))])
      .sort((a, b) => recentEras.includes(a) - recentEras.includes(b));
    candidates = narrow(candidates, eras.map((era) => (e) => e.era === era));

    const entry = history.pickFresh(candidates);
    used.add(entry.key);
    plan.push(buildSpec(entry, { ...ctx, level: entry.level ?? level }));
    lastTopic = topic;
    lastSubtopic = entry.subtopic;
    recentEras.unshift(entry.era);
    recentEras.length = Math.min(recentEras.length, 2);
  }

  history.markUsed(plan.map((spec) => spec.historyKey));
  return { plan, modeName: filter.name, modeEmoji: filter.emoji, difficulty };
}

module.exports = { buildPlan, describeBank, describeCatalog, DIFFICULTIES };
