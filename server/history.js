// Recuerda cuándo salió cada pregunta (también entre cenas) para no repetir:
// primero lo que nunca salió, después lo que salió hace más tiempo.
// Para empezar de cero, borrá data/history.json.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'history.json');
const SAVE_DELAY_MS = 1000;

let lastUsed = {};
try {
  lastUsed = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {};
} catch {
  lastUsed = {};
}
let saveTimer = null;

const randomItem = (items) => items[Math.floor(Math.random() * items.length)];

// entries: [{ key, ... }]
function pickFresh(entries) {
  const never = entries.filter((e) => !lastUsed[e.key]);
  if (never.length) return randomItem(never);
  const sorted = [...entries].sort((a, b) => lastUsed[a.key] - lastUsed[b.key]);
  return randomItem(sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 3))));
}

function isNew(key) {
  return !lastUsed[key];
}

function markUsed(keys) {
  const now = Date.now();
  for (const key of keys) lastUsed[key] = now;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, SAVE_DELAY_MS);
}

function save() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(lastUsed));
  } catch (err) {
    console.warn(`[historial] No pude guardar data/history.json: ${err.message}`);
  }
}

module.exports = { pickFresh, markUsed, isNew };
