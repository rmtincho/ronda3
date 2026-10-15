# Escenas de pelis y series

Para la pregunta "¿De qué peli es esta escena?", el tele muestra un frame sin título.

**Opción 1: tus propias imágenes.** Poné los archivos acá (jpg, png, webp) y referencialos en la peli o serie:

```json
{ "id": "m8", "kind": "movie", "answer": "Titanic", "image": ["titanic-1.jpg", "titanic-2.jpg"] }
```

Si hay varias, se elige una al azar cada vez. También acepta URLs (`"image": "https://..."`).

**Opción 2: automático con TMDB.** Creá una cuenta gratis en https://www.themoviedb.org, pedí una API key
(Configuración → API) y arrancá el servidor con ella:

```bash
TMDB_API_KEY=tu_clave npm start          # macOS / Linux / Git Bash
$env:TMDB_API_KEY="tu_clave"; npm start  # PowerShell
```

El servidor busca escenas sin texto de cada peli o serie. Si alguna sale mal, fijala con `"tmdbId": 12345`
(el número de la URL en themoviedb.org) o desactivala con `"noImage": true`.
