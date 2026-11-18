# Audiolibro

App para el celular (se instala desde Chrome) para escuchar audiolibros generados con **VoxCPM**.

**Abrir la app:** https://tcanales-coder.github.io/audiolibro-app/

## Qué hace (etapa 1)
- Biblioteca de libros guardados en el teléfono (funciona sin internet).
- Agrega un libro desde sus MP3 o desde el `.zip` que se descarga en la pestaña **Output** de Kaggle.
- Reproductor con capítulos, ±30 segundos, velocidad, temporizador para dormir y controles en la pantalla de bloqueo.
- Barra de progreso del libro completo, dividida por capítulos.
- Portada propia para cada libro.
- **Seguir el texto:** si el libro se generó desde un EPUB con el notebook, el `.zip` trae un `.json` por capítulo y la app resalta la parte que se está leyendo. Si el libro se agregó solo con audio, puedes abrir su EPUB y leerlo libremente (sin sincronía).
- Recuerda dónde quedaste en cada libro.

## Cómo instalarla en Android
1. Abre el link de arriba en **Chrome**.
2. Menú ⋮ → **Agregar a la pantalla principal** (o **Instalar app**).

## Próximas etapas
2. Subir un EPUB desde el celular y generar el audiolibro en Kaggle con la cuenta de cada persona.
3. Ver el avance y descargar los capítulos automáticamente.

## Privacidad
Los audios se guardan solo en el teléfono de cada persona. La app no envía tus libros a ningún servidor.

Usa solo libros que te pertenecen y voces propias o con permiso.

---
Archivos: `index.html` (pantallas), `app.js` (lógica), `db.js` (almacenamiento en el teléfono), `sw.js` (funcionamiento sin internet), `vendor/` (fflate, licencia MIT, para abrir .zip).
