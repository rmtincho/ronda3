// Busca un frame (escena sin título) de una peli o serie para "¿De qué peli es esta escena?".
// Primero archivos propios en data/images/; si no, escenas de TMDB (requiere TMDB_API_KEY).
const fs = require('fs');
const path = require('path');
const { normalize } = require('./matching');

const IMAGES_DIR = path.join(__dirname, '..', 'data', 'images');
const TMDB_KEY = process.env.TMDB_API_KEY || '';
const LOOKUP_TIMEOUT_MS = 5000;
const IMAGE_BASE = 'https://image.tmdb.org/t/p/w1280';
const MAX_BACKDROPS = 12;
const RETRY_FAILED_AFTER_MS = 5 * 60 * 1000;

const cache = new Map(); // clave → Promise<string[]> (URLs posibles)

const list = (value) => (Array.isArray(value) ? value : value ? [value] : []);

function localImages(movie) {
  return list(movie.image)
    .map((img) => {
      if (/^https?:\/\//i.test(img)) return img;
      const file = path.basename(img);
      if (fs.existsSync(path.join(IMAGES_DIR, file))) return `/images/${encodeURIComponent(file)}`;
      console.warn(`[imágenes] No encuentro data/images/${file} ("${movie.answer}").`);
      return null;
    })
    .filter(Boolean);
}

function canHaveFrame(movie) {
  return !movie.noImage && (list(movie.image).length > 0 || !!TMDB_KEY);
}

// Devuelve { url } o null. Cada vez elige una escena al azar entre las disponibles.
async function resolveFrame(movie) {
  if (movie.noImage) return null;
  const own = localImages(movie);
  if (own.length) return { url: own[Math.floor(Math.random() * own.length)] };
  if (!TMDB_KEY) return null;

  const type = movie.kind === 'series' ? 'tv' : 'movie';
  const key = movie.tmdbId ? `${type}:${movie.tmdbId}` : `${type}:${normalize(movie.answer)}:${movie.year || ''}`;
  if (!cache.has(key)) {
    const lookup = lookupTmdb(movie, type).catch((err) => {
      console.warn(`[imágenes] TMDB no respondió para "${movie.answer}": ${err.message}`);
      return [];
    });
    cache.set(key, lookup);
    lookup.then((urls) => {
      if (!urls.length) setTimeout(() => cache.delete(key), RETRY_FAILED_AFTER_MS).unref();
    });
  }
  const urls = await cache.get(key);
  return urls.length ? { url: urls[Math.floor(Math.random() * urls.length)] } : null;
}

async function tmdb(pathname, params = {}) {
  const url = new URL(`https://api.themoviedb.org/3${pathname}`);
  const headers = {};
  // Acepta tanto la "API Key" (v3) como el "Read Access Token" (v4, empieza con eyJ).
  if (TMDB_KEY.startsWith('eyJ')) headers.Authorization = `Bearer ${TMDB_KEY}`;
  else url.searchParams.set('api_key', TMDB_KEY);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, v);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function findTmdbId(movie, type) {
  if (movie.tmdbId) return movie.tmdbId;
  const yearParam = type === 'tv' ? 'first_air_date_year' : 'year';
  const titles = [movie.answer, ...list(movie.aliases)];
  for (const title of titles) {
    for (const withYear of [true, false]) {
      const data = await tmdb(`/search/${type}`, {
        query: title, language: 'es-AR', [yearParam]: withYear ? movie.year : null,
      });
      const hit = (data.results || [])[0];
      if (hit) return hit.id;
    }
  }
  return null;
}

async function lookupTmdb(movie, type) {
  const id = await findTmdbId(movie, type);
  if (!id) return [];
  // include_image_language=null: solo escenas sin texto (sin el título escrito encima).
  const data = await tmdb(`/${type}/${id}/images`, { include_image_language: 'null' });
  return (data.backdrops || [])
    .filter((b) => !b.iso_639_1)
    .sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0))
    .slice(0, MAX_BACKDROPS)
    .map((b) => `${IMAGE_BASE}${b.file_path}`);
}

module.exports = { resolveFrame, canHaveFrame };
