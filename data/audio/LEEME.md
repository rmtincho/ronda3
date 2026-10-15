# Audio propio

Poné acá tus archivos (mp3, m4a, ogg) y referencialos desde `data/questions.json`:

```json
{ "id": "s1", "answer": "De música ligera", "artist": "Soda Stereo",
  "audio": "s1.mp3", "audioStart": 12,
  "continue": { "previousLine": "...", "line": "...", "decoys": ["..."], "playFrom": 38, "cutAt": 47.5 } }
```

- `audioStart`: segundo desde el que suena en "¿Nombre de la canción?", "¿Quién la canta?" y "¿De qué década es?".
- `continue.playFrom` / `continue.cutAt`: para "¿Cómo sigue?", el tele reproduce desde `playFrom` y corta en `cutAt`, justo antes de la línea. En la revelación sigue desde ahí.

Si una canción no tiene `audio`, se busca automáticamente el fragmento de 30 s en iTunes (requiere internet).
Estos archivos no se suben al repo (ver `.gitignore`).
