const crypto = require('crypto');
const { Room } = require('./game');

// Sin O/0 ni I/1 para que no se confundan al dictarlos.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const MAX_IDLE_MS = 6 * 60 * 60 * 1000;
const rooms = new Map();

function generateCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
}

async function createRoom(joinBase) {
  const code = generateCode();
  const room = new Room(code, `${joinBase}/play/${code}`);
  rooms.set(code, room);
  await room.init();
  return room;
}

function getRoom(code) {
  return rooms.get(String(code || '').trim().toUpperCase()) || null;
}

setInterval(() => {
  for (const [code, room] of rooms) {
    if (room.isIdle(MAX_IDLE_MS)) {
      room.dispose();
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000).unref();

module.exports = { createRoom, getRoom };
