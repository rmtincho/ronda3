const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const rooms = require('./rooms');
const { sendError } = require('./game');
const { getLanAddress, isLocalHost } = require('./network');
const { describeBank } = require('./questions');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const AUDIO_DIR = path.join(__dirname, '..', 'data', 'audio');
const IMAGES_DIR = path.join(__dirname, '..', 'data', 'images');
const HEARTBEAT_MS = 15000;
const lanAddress = getLanAddress();

const app = express();
app.disable('x-powered-by');
app.get('/', (req, res) => res.redirect('/tv'));
app.get('/tv', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'tv', 'index.html')));
app.get(['/play', '/play/:roomCode([A-Za-z]{4})'], (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'play', 'index.html')));
app.use('/audio', express.static(AUDIO_DIR, { fallthrough: false }));
app.use('/images', express.static(IMAGES_DIR, { fallthrough: false }));
app.use(express.static(PUBLIC_DIR, { index: false, redirect: false }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

// Si el tele se abrió con "localhost", los celulares necesitan la IP de la red.
// En un servidor de internet (Render, etc.) llega detrás de HTTPS: el proxy avisa con x-forwarded-proto.
function joinBaseFor(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!host || isLocalHost(host)) return `http://${lanAddress}:${PORT}`;
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  return `${proto === 'https' ? 'https' : 'http'}://${host}`;
}

async function handleMessage(ws, type, payload) {
  switch (type) {
    case 'tv:create': {
      ws.room?.handleDisconnect(ws);
      const room = await rooms.createRoom(ws.joinBase);
      room.attachTv(ws);
      return;
    }
    case 'tv:resume': {
      const room = rooms.getRoom(payload.roomCode);
      if (!room) return sendError(ws, 'ROOM_NOT_FOUND', 'La sala ya no existe.');
      if (ws.room !== room) ws.room?.handleDisconnect(ws);
      room.attachTv(ws);
      return;
    }
    case 'player:join': {
      const room = rooms.getRoom(payload.roomCode);
      if (!room) return sendError(ws, 'ROOM_NOT_FOUND', 'No hay ninguna sala con ese código.');
      if (ws.room && ws.room !== room) ws.room.handleDisconnect(ws);
      room.joinPlayer(ws, payload);
      return;
    }
    default:
      ws.room?.handleMessage(ws, type, payload);
  }
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.joinBase = joinBaseFor(req);
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;
    const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
    handleMessage(ws, msg.type, payload).catch((err) => console.error('[ws]', err));
  });
  ws.on('close', () => ws.room?.handleDisconnect(ws));
});

// Detecta celulares que se cayeron sin avisar (pantalla bloqueada, Wi-Fi que se corta).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  El puerto ${PORT} ya está en uso. Probá con otro: PORT=4000 npm start\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`
  🎉 Ronda3 está listo

  Tele (en esta compu):  http://localhost:${PORT}/tv
  Tele (desde la red):   http://${lanAddress}:${PORT}/tv
  Celulares:             escaneen el QR del tele o entren a http://${lanAddress}:${PORT}/play

  Banco: ${describeBank()}
  Escenas de pelis: ${process.env.TMDB_API_KEY ? 'TMDB activado' : 'solo imágenes propias (para TMDB, definí TMDB_API_KEY)'}
`);
});
