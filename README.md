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
- **Destacador:** en la vista de texto un toque destaca la frase y aparecen dos marcadores para ajustar desde dónde hasta dónde (otro toque lo quita), en 3 colores. La estrella muestra solo tus frases destacadas, para copiarlas o compartirlas. Se guardan solo en tu teléfono.
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

## Etapa 2: crear el audiolibro desde la app
- **Crear audiolibro desde un EPUB:** sube el EPUB (y la voz) a la cuenta de Kaggle de la persona, lanza el notebook con GPU, muestra el avance y descarga los capítulos al terminar.
- Cada persona conecta **su propia** cuenta de Kaggle (kaggle.json). La clave queda solo en su teléfono.
- `intermediario/worker.js`: Cloudflare Worker gratuito que pasa los mensajes entre la app y Kaggle (Kaggle no acepta llamadas directas desde una página web). No guarda nada.
- `kaggle/plantilla.ipynb`: el notebook EPUB → audiolibro con VoxCPM2; la app solo cambia la celda de configuración.

## Comentarios del club (solo Choro y Tinta)
- En `/choro/`, el reproductor tiene **Comentarios del club**: cada amiga pone su nombre una vez y comenta el libro; todas ven los mismos comentarios. Se puede marcar un comentario como "cuenta algo del final" para que quede oculto hasta tocarlo, y cada una puede borrar los suyos.
- Un libro se reconoce por su título (sin mayúsculas ni tildes), así que un libro pasado con **Compartir este libro** cae en la misma conversación.
- `comentarios.js` y `comentarios.css` solo los carga `choro/index.html`; la versión de la familia no los tiene.
- Se guardan en el mismo intermediario (`intermediario/worker.js`) usando Cloudflare KV gratis. Para activarlo: crear un espacio KV (por ejemplo `comentarios`), enlazarlo al Worker con el nombre de variable `COMENTARIOS` y pegar el código nuevo del Worker.
