// Busca el audio de cada canción: primero un archivo propio en data/audio/,
// si no, el fragmento de 30 s de la API pública de iTunes. Si nada funciona, la ronda va con texto.
const fs = require('fs');
const path = require('path');
const { normalize, splitArtists } = require('./matching');

const AUDIO_DIR = path.join(__dirname, '..', 'data', 'audio');
const COUNTRIES = [...new Set([(process.env.ITUNES_COUNTRY || 'AR').toUpperCase(), 'US'])];
const LOOKUP_TIMEOUT_MS = 4000;
const RETRY_FAILED_AFTER_MS = 5 * 60 * 1000;
const OFFLINE = process.env.RONDA3_OFFLINE === '1';

const cache = new Map(); // clave → Promise<{ url, source } | null>

// Devuelve { url, start, source } o null.
function resolveAudio(song) {
  if (song.audio) return Promise.resolve(fromSongFile(song));
  if (song.noAudio || OFFLINE) return Promise.resolve(null);

  const key = song.itunesId ? `id:${song.itunesId}` : `q:${normalize(song.artist)}|${normalize(song.answer)}`;
  if (!cache.has(key)) {
    const lookup = lookupItunes(song).catch((err) => {
      console.warn(`[audio] iTunes no respondió para "${song.answer}": ${err.message}`);
      return null;
    });
    cache.set(key, lookup);
    lookup.then((found) => {
      if (!found) setTimeout(() => cache.delete(key), RETRY_FAILED_AFTER_MS).unref();
    });
  }
  return cache.get(key).then((found) => found && { ...found, start: Number(song.audioStart) || 0 });
}

function fromSongFile(song) {
  const start = Number(song.audioStart) || 0;
  if (/^https?:\/\//i.test(song.audio)) return { url: song.audio, start, source: 'url' };
  const file = path.basename(song.audio);
  if (!fs.existsSync(path.join(AUDIO_DIR, file))) {
    console.warn(`[audio] No encuentro data/audio/${file} (canción "${song.answer}").`);
    return null;
  }
  return { url: `/audio/${encodeURIComponent(file)}`, start, source: 'local' };
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function lookupItunes(song) {
  if (song.itunesId) {
    const data = await fetchJson(`https://itunes.apple.com/lookup?id=${encodeURIComponent(song.itunesId)}&entity=song`);
    const track = (data.results || []).find((r) => r.previewUrl);
    return track ? { url: track.previewUrl, source: 'itunes' } : null;
  }
  const term = `${song.artist || ''} ${song.answer}`.trim();
  for (const country of COUNTRIES) {
    const params = new URLSearchParams({ term, media: 'music', entity: 'song', limit: '15', country });
    const data = await fetchJson(`https://itunes.apple.com/search?${params}`);
    const best = pickBestTrack(data.results || [], song);
    if (best) return { url: best.previewUrl, source: 'itunes' };
  }
  return null;
}

function pickBestTrack(results, song) {
  const title = normalize(song.answer);
  const artists = [song.artist, ...splitArtists(song.artist)].map(normalize).filter(Boolean);
  let best = null;
  let bestScore = 0;
  for (const track of results) {
    if (!track.previewUrl) continue;
    const name = normalize(track.trackName);
    const artist = normalize(track.artistName);
    let score;
    if (name === title) score = 3;
    else if (name.startsWith(title) || name.includes(title)) score = 2;
    else continue;
    if (artists.some((a) => artist.includes(a) || a.includes(artist))) score += 3;
    if (/karaoke|tribute|tributo|cover|originally performed|made famous/i.test(`${track.trackName} ${track.artistName} ${track.collectionName || ''}`)) score -= 3;
    if (score > bestScore) {
      best = track;
      bestScore = score;
    }
  }
  return bestScore >= 3 ? best : null;
}

module.exports = { resolveAudio };
