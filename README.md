# Ronda3 🎉

Juego de preguntas para la cena. El tele muestra la mesa y cada uno juega desde su celular, entrando por el navegador. Si quieren, la pueden instalar como app desde la portada (`/`), así la próxima vez solo ponen el código de 4 letras.

Todo se responde con opciones **A, B, C, D**. Lo único que se escribe son cifras: estimaciones, años y temporadas.

**Temas:** 🎵 Música · 🎬 Cine y series · ⚽ Deportes · 🏛️ Historia · 🌎 Geografía · 🎨 Arte y literatura · 🔬 Ciencia y naturaleza.

**Modos:** Todo mezclado, Solo música, Rock, Rock nacional, Rock de los 80, Bien argentino, Música argentina, Tango, Folklore, Cumbia y cuarteto, Cine y series, Música y cine, Mundiales, Deportes, Cultura general, Cifras y estimaciones… y **Personalizado**, para combinar temas a gusto.

## Arrancar

Requisitos: Node.js 18 o más nuevo.

```bash
npm install
npm start
```

Para usar otro puerto: `PORT=4000 npm start` (en PowerShell: `$env:PORT=4000; npm start`).

## Abrir el tele

En la compu conectada al tele, abrí **http://localhost:3000/tv** y poné pantalla completa con el botón ⛶ o con F11. En el lobby elegís el modo y la cantidad de rondas.

## Unirse desde el celular

> **Instalar como app:** en la portada (`/`) hay un botón para instalar Ronda3 (Android) o las instrucciones para agregarla a la pantalla de inicio (iPhone). Necesita HTTPS, así que funciona con el servidor en Render, no por IP en la red de la casa. La app recuerda el nombre: en la próxima partida alcanza con poner el código.

1. Conectá el celular a la **misma Wi-Fi** que la compu.
2. Escaneá el QR del tele, o entrá a la dirección que aparece en pantalla (por ejemplo `http://192.168.0.12:3000/play/ABCD`).
3. Poné tu nombre y listo.

Si a alguien se le corta, vuelve a entrar con el mismo nombre y recupera su puntaje.

> **Windows:** la primera vez, el firewall pregunta si Node puede usar la red. Aceptá para **redes privadas**; si no, los celulares no se conectan.

## Música y escenas de pelis

- **Canciones:** el tele reproduce el fragmento de 30 s de iTunes (necesita internet), o tus propios archivos en `data/audio/` (ver `data/audio/LEEME.md`).
- **"¿De qué peli es esta escena?":** el tele muestra un frame sin título. Para que funcione hacen falta imágenes propias en `data/images/` o una clave gratuita de TMDB (ver `data/images/LEEME.md`):

  ```bash
  TMDB_API_KEY=tu_clave npm start          # Git Bash / macOS / Linux
  $env:TMDB_API_KEY="tu_clave"; npm start  # PowerShell
  ```

- Si no hay audio o imagen, la ronda se juega con una pista escrita.

## Editar preguntas y modos

| Archivo | Qué tiene |
|---|---|
| `data/questions.json` | Canciones, pelis y series, estimaciones |
| `data/packs/*.json` | Preguntas por tema (deportes, historia, geografía, arte, ciencia, música, cine). Cualquier `.json` nuevo en esta carpeta se suma solo |
| `data/modes.json` | Temas, subtemas y modos del lobby |

Todo se vuelve a leer al empezar cada partida, así que no hace falta reiniciar el servidor.

```json
{ "id": "hi1", "topic": "historia", "tags": ["argentina"], "question": "¿En qué año fue la Revolución de Mayo?",
  "answer": "1810", "decoys": ["1816", "1806", "1853"] }
```

- **Modos:** cada modo junta las preguntas que tienen alguna de sus etiquetas `include` y todas las de `require`. Las etiquetas salen del tema, el subtema, la década y `tags`. Por ejemplo, "Rock de los 80" es `include: ["rock_nacional", "rock_internacional"]` con `require: ["80s"]`.
- **Opciones falsas:** en canciones, artistas, pelis y personajes se arman solas con otras entradas del banco. Si querés fijarlas, usá `titleDecoys`, `artistDecoys` o `decoys`.
- **No repetir:** el servidor recuerda qué salió en `data/history.json` (también entre cenas) y prioriza lo que nunca salió o lo que salió hace más tiempo. Para empezar de cero, borrá ese archivo.

## Puntaje

| | |
|---|---|
| Acierto con opciones | 500 a 1000 puntos según la velocidad |
| Cifras | Hasta 1000 puntos según la precisión, +200 al más cercano |
| Racha (2 o más aciertos seguidos) | +100, +200… hasta +500 |

## Variables de entorno

| Variable | Para qué |
|---|---|
| `PORT` | Puerto del servidor (3000 por defecto) |
| `PUBLIC_HOST` | IP o nombre que va en el QR, si la detección automática elige mal la red |
| `TMDB_API_KEY` | Activa las escenas de pelis y series desde TMDB |
| `ITUNES_COUNTRY` | Tienda de iTunes donde buscar los fragmentos (`AR` por defecto) |
| `RONDA3_OFFLINE=1` | No buscar audio en internet |
