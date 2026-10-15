// Comparación tolerante de respuestas de texto: sin mayúsculas, sin tildes,
// sin artículo inicial y con margen para errores de tipeo.

const LEADING_ARTICLES = new Set(['el', 'la', 'los', 'las', 'lo', 'un', 'una', 'the', 'a', 'an']);

// Palabras que no alcanzan solas para acertar un nombre ("Mamá" no es "Mamá Cora").
const NAME_STOPWORDS = new Set([
  'los', 'las', 'del', 'sus', 'the', 'and', 'band', 'banda', 'grupo', 'orquesta',
  'feat', 'mama', 'papa', 'senor', 'senora', 'dona', 'doc', 'mister', 'miss',
]);

function normalize(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' y ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function stripArticle(text) {
  const space = text.indexOf(' ');
  if (space > 0 && LEADING_ARTICLES.has(text.slice(0, space))) return text.slice(space + 1);
  return text;
}

function variants(text) {
  const full = normalize(text);
  if (!full) return [];
  const bare = stripArticle(full);
  return [...new Set([full, bare, full.replace(/ /g, ''), bare.replace(/ /g, '')])];
}

function allowedTypos(length) {
  if (length < 4) return 0;
  if (length < 8) return 1;
  return Math.floor(length * 0.2);
}

function levenshtein(a, b, max = Infinity) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

function containsWords(haystack, needle) {
  return ` ${haystack} `.includes(` ${needle} `);
}

// names: true acepta también el apellido o el nombre de pila solo ("Gardel", "Walter").
function isMatch(input, candidates, { names = false } = {}) {
  const inputs = variants(input);
  if (!inputs.length) return false;

  for (const candidate of candidates) {
    for (const c of variants(candidate)) {
      for (const i of inputs) {
        if (i === c) return true;
        const max = allowedTypos(Math.max(i.length, c.length));
        if (max && levenshtein(i, c, max) <= max) return true;
        // Escribió de más: "de musica ligera de soda stereo".
        if (c.length >= 4 && containsWords(i, c) && i.length <= c.length + 25) return true;
        // Escribió casi todo: "buenos aires querido".
        if (i.length >= 4 && containsWords(c, i) && i.length >= c.length * 0.7) return true;
      }
    }
    if (names) {
      const tokens = normalize(candidate).split(' ').filter((t) => t.length >= 4 && !NAME_STOPWORDS.has(t));
      for (const i of inputs) {
        if (i.length < 4) continue;
        if (tokens.some((t) => t === i || (t.length >= 6 && levenshtein(t, i, 1) <= 1))) return true;
      }
    }
  }
  return false;
}

// "Luis Fonsi y Daddy Yankee" → ["Luis Fonsi", "Daddy Yankee"]
function splitArtists(artist) {
  const full = String(artist || '').trim();
  return full
    .split(/\s*(?:,|&|\s+y\s+|\s+ft\.?\s+|\s+feat\.?\s+|\s+x\s+|\s+con\s+)\s*/i)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3 && part !== full);
}

module.exports = { normalize, isMatch, splitArtists, levenshtein };
