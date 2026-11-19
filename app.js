// Audiolibro: biblioteca y reproductor (etapa 1).
const $ = id => document.getElementById(id);
const audio = $("audio");
const EXT_AUDIO = /\.(mp3|m4a|m4b|aac|ogg|oga|opus|wav|flac)$/i;
const VELOCIDADES = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const DORMIR = [0, 15, 30, 45, 60, -1]; // minutos; -1 = al terminar el capítulo

const estado = {
  libro: null,        // libro abierto
  pista: 0,
  urlActual: null,
  velocidad: leerPref("velocidad", 1),
  dormirIdx: 0,
  dormirHasta: 0,
  ultimoGuardado: 0,
};

// ---------- utilidades ----------
function leerPref(k, def) {
  try { const v = localStorage.getItem("pref:" + k); return v === null ? def : JSON.parse(v); }
  catch { return def; }
}
function guardarPref(k, v) { try { localStorage.setItem("pref:" + k, JSON.stringify(v)); } catch {} }

function hhmmss(s) {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0");
}
function duracionTexto(s) {
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}
function avisar(texto, ms = 3500) {
  const a = $("aviso");
  a.textContent = texto; a.hidden = false;
  clearTimeout(avisar.t);
  avisar.t = setTimeout(() => { a.hidden = true; }, ms);
}
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(16).slice(2));

// "003 - El_regreso.mp3" -> "El regreso"
function nombreBonito(archivo) {
  let n = archivo.replace(/^.*\//, "").replace(EXT_AUDIO, "");
  n = n.replace(/^\d+\s*[-_.]\s*/, "").replace(/_/g, " ").trim();
  return n || archivo;
}
// orden natural: "2" antes que "10"
const ordenNatural = (a, b) => a.localeCompare(b, "es", { numeric: true, sensitivity: "base" });

function colorPortada(texto) {
  let h = 0;
  for (const c of texto) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `linear-gradient(145deg, hsl(${h} 45% 42%), hsl(${(h + 40) % 360} 50% 26%))`;
}
function iniciales(t) {
  return t.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]).join("").toUpperCase();
}

function duracionDe(blob) {
  return new Promise(ok => {
    const a = new Audio();
    const url = URL.createObjectURL(blob);
    const fin = d => { URL.revokeObjectURL(url); ok(isFinite(d) ? d : 0); };
    a.preload = "metadata";
    a.onloadedmetadata = () => fin(a.duration);
    a.onerror = () => fin(0);
    setTimeout(() => fin(0), 15000);
    a.src = url;
  });
}

function tipoPorNombre(n) {
  const e = (n.match(/\.(\w+)$/) || [])[1]?.toLowerCase();
  return { mp3: "audio/mpeg", m4a: "audio/mp4", m4b: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg",
           oga: "audio/ogg", opus: "audio/ogg", wav: "audio/wav", flac: "audio/flac" }[e] || "application/octet-stream";
}

// ---------- importar ----------
// Lee el .zip por partes (sin cargarlo entero en memoria): un libro puede pesar cientos de MB.
async function abrirZip(archivo) {
  const audios = [];
  const pendientes = [];
  const unzip = new fflate.Unzip(entrada => {
    const nombre = entrada.name;
    if (!(EXT_AUDIO.test(nombre) || /\.json$/i.test(nombre)) || /(^|\/)(__MACOSX|_partes)\//.test(nombre)) return;
    const trozos = [];
    pendientes.push(new Promise((ok, mal) => {
      entrada.ondata = (err, datos, final) => {
        if (err) return mal(err);
        trozos.push(datos);
        if (final) {
          audios.push({ nombre: nombre.replace(/^.*\//, ""), blob: new Blob(trozos, { type: tipoPorNombre(nombre) }) });
          ok();
        }
      };
    }));
    entrada.start();
  });
  unzip.register(fflate.UnzipInflate);
  const lector = archivo.stream().getReader();
  for (;;) {
    const { value, done } = await lector.read();
    if (done) { unzip.push(new Uint8Array(0), true); break; }
    unzip.push(value);
  }
  await Promise.all(pendientes);
  return audios;
}

async function expandirArchivos(lista) {
  const salida = [];
  for (const f of lista) {
    if (/\.zip$/i.test(f.name)) {
      salida.push(...await abrirZip(f));
    } else if (EXT_AUDIO.test(f.name) || /\.json$/i.test(f.name)) {
      salida.push({ nombre: f.name, blob: f });
    }
  }
  // .json = sincronización texto-audio que genera el notebook (mismo nombre que el MP3)
  const base = n => n.replace(/\.[^.]+$/, "");
  const sinc = new Map();
  for (const a of salida.filter(a => /\.json$/i.test(a.nombre))) {
    try {
      const d = JSON.parse(await a.blob.text());
      if (Array.isArray(d.frases)) sinc.set(base(a.nombre), d.frases.filter(f => typeof f.t === "number" && f.texto));
    } catch {}
  }
  const audios = salida.filter(a => EXT_AUDIO.test(a.nombre));
  // si vienen MP3 por capítulo y además un .m4b del libro entero, quedarse con los capítulos
  const capitulos = audios.filter(a => !/\.m4b$/i.test(a.nombre));
  const elegidos = capitulos.length > 1 ? capitulos : audios;
  for (const a of elegidos) a.frases = sinc.get(base(a.nombre)) || null;
  return elegidos.sort((a, b) => ordenNatural(a.nombre, b.nombre));
}

function tituloSugerido(archivosOriginales) {
  const zip = archivosOriginales.find(f => /\.zip$/i.test(f.name));
  if (zip) return zip.name.replace(/\.zip$/i, "").replace(/[_-]+/g, " ").trim();
  if (archivosOriginales.length === 1) return nombreBonito(archivosOriginales[0].name);
  return "Libro nuevo";
}

function pedirTitulo(sugerido, resumen) {
  const dlg = $("dlg-nombre");
  $("in-titulo").value = sugerido;
  $("dlg-resumen").textContent = resumen;
  dlg.showModal();
  return new Promise(ok => {
    dlg.addEventListener("close", () => ok(dlg.returnValue === "ok" ? $("in-titulo").value.trim() : null), { once: true });
  });
}

async function importar(lista) {
  if (!lista.length) return;
  avisar("Leyendo archivos…", 60000);
  let pistas;
  try { pistas = await expandirArchivos(lista); }
  catch (e) { avisar("No pude abrir el archivo: " + e.message); return; }
  if (!pistas.length) { avisar("No encontré audios (MP3, M4B…) en lo que elegiste."); return; }
  $("aviso").hidden = true;

  const titulo = await pedirTitulo(tituloSugerido(lista),
    `${pistas.length} ${pistas.length === 1 ? "archivo" : "capítulos"} de audio`);
  if (!titulo) return;

  const libro = { id: uid(), titulo, creado: Date.now(), pistas: [], pos: { pista: 0, tiempo: 0 }, terminado: false };
  try {
    for (let i = 0; i < pistas.length; i++) {
      avisar(`Guardando ${i + 1} de ${pistas.length}…`, 60000);
      const idArchivo = uid();
      await BD.guardarArchivo(idArchivo, pistas[i].blob);
      libro.pistas.push({ nombre: nombreBonito(pistas[i].nombre), idArchivo, duracion: await duracionDe(pistas[i].blob),
                          frases: pistas[i].frases || null });
    }
    await BD.guardarLibro(libro);
  } catch (e) {
    avisar("No se pudo guardar (¿falta espacio en el teléfono?): " + e.message, 8000);
    return;
  }
  const conTexto = libro.pistas.some(p => p.frases && p.frases.length);
  avisar(`“${titulo}” agregado${conTexto ? " · con texto para seguir la lectura" : ""}`);
  pedirAlmacenamientoPersistente();
  mostrarBiblioteca();
}

async function pedirAlmacenamientoPersistente() {
  try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch {}
}

// ---------- biblioteca ----------
function progresoLibro(l) {
  const total = l.pistas.reduce((s, p) => s + (p.duracion || 0), 0);
  if (!total) return { total: 0, pct: 0 };
  const hecho = l.pistas.slice(0, l.pos.pista).reduce((s, p) => s + (p.duracion || 0), 0) + (l.pos.tiempo || 0);
  return { total, pct: l.terminado ? 100 : Math.min(100, Math.round((hecho / total) * 100)) };
}

async function mostrarBiblioteca() {
  $("vista-reproductor").hidden = true;
  $("vista-biblioteca").hidden = false;
  $("btn-volver").hidden = true;
  $("btn-texto").hidden = true;
  cerrarTexto();
  $("titulo-barra").textContent = "Mis audiolibros";

  for (const u of urlsPortada.values()) URL.revokeObjectURL(u);
  urlsPortada.clear();
  const libros = (await BD.libros()).sort((a, b) => (b.abierto || b.creado) - (a.abierto || a.creado));
  const ul = $("lista-libros");
  ul.innerHTML = "";
  $("vacio").hidden = libros.length > 0;
  for (const l of libros) {
    const { total, pct } = progresoLibro(l);
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.className = "tarjeta";
    b.innerHTML = `
      <span class="mini" style="background:${colorPortada(l.titulo)}">${iniciales(l.titulo)}</span>
      <span class="info">
        <span class="t"></span>
        <span class="d">${l.pistas.length} ${l.pistas.length === 1 ? "parte" : "capítulos"}${total ? " · " + duracionTexto(total) : ""}</span>
        <span class="barra-mini"><span style="width:${pct}%"></span></span>
      </span>
      <span class="pct">${pct}%</span>`;
    b.querySelector(".t").textContent = l.titulo;
    const url = await urlPortada(l);
    if (url) { const m = b.querySelector(".mini"); fondoPortada(m, l, url); m.textContent = ""; }
    b.onclick = () => abrirLibro(l.id);
    li.appendChild(b);
    ul.appendChild(li);
  }
  mostrarEspacio();
}

async function mostrarEspacio() {
  try {
    const e = await navigator.storage.estimate();
    const mb = x => (x / 1e6 >= 1000 ? (x / 1e9).toFixed(1) + " GB" : Math.round(x / 1e6) + " MB");
    $("nota-espacio").textContent = `Espacio usado: ${mb(e.usage || 0)} de ${mb(e.quota || 0)} disponibles para la app.`;
  } catch { $("nota-espacio").textContent = ""; }
}

// ---------- portadas ----------
const urlsPortada = new Map();   // idArchivo -> objectURL
async function urlPortada(l) {
  if (!l.portadaId) return null;
  if (!urlsPortada.has(l.portadaId)) {
    const blob = await BD.archivo(l.portadaId);
    if (!blob) return null;
    urlsPortada.set(l.portadaId, URL.createObjectURL(blob));
  }
  return urlsPortada.get(l.portadaId);
}
function fondoPortada(el, l, url) {
  el.style.background = url ? `center / cover no-repeat url("${url}")` : colorPortada(l.titulo);
}
async function pintarPortada() {
  const l = estado.libro, el = $("portada");
  const url = await urlPortada(l);
  fondoPortada(el, l, url);
  $("portada-letras").textContent = url ? "" : iniciales(l.titulo);
  el.classList.toggle("con-imagen", !!url);
}
// reduce la foto a 800 px para no ocupar espacio de más
async function reducirImagen(archivo, max = 800) {
  const bmp = await createImageBitmap(archivo);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise(ok => c.toBlob(ok, "image/jpeg", 0.85));
}
async function cambiarPortada(archivo) {
  const l = estado.libro;
  if (!l || !archivo) return;
  let blob;
  try { blob = await reducirImagen(archivo); }
  catch { avisar("No pude abrir esa imagen. Prueba con una foto JPG o PNG."); return; }
  const anterior = l.portadaId;
  l.portadaId = uid();
  await BD.guardarArchivo(l.portadaId, blob);
  await BD.guardarLibro(l);
  if (anterior) { await BD.borrarArchivo(anterior); urlsPortada.delete(anterior); }
  await pintarPortada();
  actualizarMediaSession();
  avisar("Portada guardada");
}

// ---------- reproductor ----------
async function abrirLibro(id) {
  const l = await BD.libro(id);
  if (!l) return mostrarBiblioteca();
  l.abierto = Date.now();
  await BD.guardarLibro(l);
  estado.libro = l;

  $("vista-biblioteca").hidden = true;
  $("vista-reproductor").hidden = false;
  $("btn-volver").hidden = false;
  $("btn-texto").hidden = false;
  $("titulo-barra").textContent = l.titulo;
  await pintarPortada();

  const ol = $("lista-capitulos");
  ol.innerHTML = "";
  l.pistas.forEach((p, i) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.innerHTML = `<span class="n"></span><span class="dur">${p.duracion ? hhmmss(p.duracion) : ""}</span>`;
    b.querySelector(".n").textContent = p.nombre;
    b.onclick = () => cargarPista(i, 0, true);
    li.appendChild(b);
    ol.appendChild(li);
  });

  await cargarPista(l.pos.pista || 0, l.pos.tiempo || 0, false);
  pintarSegmentos();
  actualizarTiempo();
  window.scrollTo(0, 0);
}

async function cargarPista(i, tiempo, reproducir) {
  const l = estado.libro;
  if (!l || i < 0 || i >= l.pistas.length) return;
  estado.pista = i;
  const blob = await BD.archivo(l.pistas[i].idArchivo);
  if (!blob) { avisar("Falta el audio de este capítulo. Vuelve a agregar el libro."); return; }
  if (estado.urlActual) URL.revokeObjectURL(estado.urlActual);
  estado.urlActual = URL.createObjectURL(blob);
  audio.src = estado.urlActual;
  audio.playbackRate = estado.velocidad;
  await new Promise(ok => { audio.onloadedmetadata = ok; audio.onerror = ok; });
  audio.playbackRate = estado.velocidad;
  if (tiempo > 0 && tiempo < (audio.duration || Infinity) - 1) audio.currentTime = tiempo;
  if (isFinite(audio.duration) && Math.abs((l.pistas[i].duracion || 0) - audio.duration) > 1) {
    l.pistas[i].duracion = audio.duration;     // corrige duraciones que no se pudieron leer al importar
    pintarSegmentos();
  }

  $("capitulo-actual").textContent = `${i + 1} de ${l.pistas.length} · ${l.pistas[i].nombre}`;
  [...$("lista-capitulos").children].forEach((li, k) => li.classList.toggle("activo", k === i));
  actualizarTiempo();
  actualizarMediaSession();
  guardarPosicion(true);
  seguirTexto();                          // si el texto está abierto, pasa al capítulo nuevo
  if (reproducir) audio.play().catch(() => {});
}

function alternar() {
  if (!estado.libro) return;
  if (audio.paused) audio.play().catch(e => avisar("No se pudo reproducir: " + e.message));
  else audio.pause();
}
function saltar(seg) {
  const d = audio.duration || 0;
  let t = audio.currentTime + seg;
  if (t < 0 && estado.pista > 0 && seg < 0) {          // retroceder hacia el capítulo anterior
    const anterior = estado.libro.pistas[estado.pista - 1].duracion || 0;
    return cargarPista(estado.pista - 1, Math.max(0, anterior + t), !audio.paused);
  }
  audio.currentTime = Math.max(0, Math.min(d ? d - 0.5 : t, t));
}
function anterior() {
  if (audio.currentTime > 5 || estado.pista === 0) audio.currentTime = 0;
  else cargarPista(estado.pista - 1, 0, !audio.paused);
}
function siguiente() {
  if (estado.pista < estado.libro.pistas.length - 1) cargarPista(estado.pista + 1, 0, !audio.paused);
}

async function guardarPosicion(forzar = false) {
  const l = estado.libro;
  if (!l) return;
  const ahora = Date.now();
  if (!forzar && ahora - estado.ultimoGuardado < 5000) return;
  estado.ultimoGuardado = ahora;
  l.pos = { pista: estado.pista, tiempo: audio.currentTime || 0 };
  try { await BD.guardarLibro(l); } catch {}
}

// ----- línea de tiempo del libro completo -----
function durPista(i) {
  const l = estado.libro;
  if (i === estado.pista && isFinite(audio.duration) && audio.duration > 0) return audio.duration;
  return l.pistas[i].duracion || 0;
}
function inicioPista(i) { let s = 0; for (let k = 0; k < i; k++) s += durPista(k); return s; }
function totalLibro() { return inicioPista(estado.libro.pistas.length); }
// tiempo del libro -> {pista, tiempo dentro del capítulo}
function ubicar(t) {
  const n = estado.libro.pistas.length;
  for (let i = 0; i < n; i++) {
    const d = durPista(i);
    if (t < d || i === n - 1) return { pista: i, tiempo: Math.max(0, Math.min(t, d - 0.5)) };
    t -= d;
  }
  return { pista: 0, tiempo: 0 };
}

// Barra al estilo de capítulos de podcast: un tramo por capítulo, separados por un espacio.
// El valor del control (0–10000) representa la posición en píxeles sobre la barra,
// así lo que la persona toca coincide exactamente con el tramo que ve.
function pintarSegmentos() {
  const cont = $("segmentos");
  cont.innerHTML = "";
  const l = estado.libro;
  const total = totalLibro();
  l.pistas.forEach((p, i) => {
    const seg = document.createElement("span");
    seg.className = "seg";
    seg.style.flexGrow = total ? Math.max(durPista(i), total * 0.004) : 1;
    seg.innerHTML = '<span class="relleno"></span>';
    cont.appendChild(seg);
  });
}

// tiempo del libro -> fracción horizontal (0..1)
function tiempoAFraccion(t) {
  const cont = $("segmentos"), segs = cont.children, ancho = cont.clientWidth;
  if (!segs.length || !ancho) return 0;
  const u = ubicar(t), seg = segs[u.pista], d = durPista(u.pista) || 1;
  return (seg.offsetLeft + Math.min(1, u.tiempo / d) * seg.offsetWidth) / ancho;
}
// fracción horizontal -> tiempo del libro (los espacios se cuentan como el borde más cercano)
function fraccionATiempo(f) {
  const cont = $("segmentos"), segs = [...cont.children], x = f * cont.clientWidth;
  let t = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i], d = durPista(i), fin = s.offsetLeft + s.offsetWidth;
    if (x <= fin || i === segs.length - 1) return t + Math.max(0, Math.min(1, (x - s.offsetLeft) / s.offsetWidth)) * d;
    t += d;
  }
  return t;
}

function pintarBarra(fraccion, tiempo) {
  const b = $("barra-tiempo");
  b.value = Math.round(fraccion * 10000);
  $("punto").style.left = (fraccion * 100) + "%";
  const segs = $("segmentos").children;
  let inicio = 0;
  for (let i = 0; i < segs.length; i++) {
    const d = durPista(i);
    const lleno = d ? Math.max(0, Math.min(1, (tiempo - inicio) / d)) : 0;
    segs[i].firstChild.style.width = (lleno * 100) + "%";
    segs[i].classList.toggle("actual", tiempo >= inicio && (tiempo < inicio + d || i === segs.length - 1));
    inicio += d;
  }
}

function actualizarTiempo() {
  if (!estado.libro) return;
  const total = totalLibro();
  const pos = inicioPista(estado.pista) + (audio.currentTime || 0);
  if (!arrastrando) {
    $("t-actual").textContent = hhmmss(pos);
    pintarBarra(tiempoAFraccion(pos), pos);
  }
  $("t-total").textContent = "-" + hhmmss(Math.max(0, total - pos));
  const pct = estado.libro.terminado ? 100 : (total ? Math.floor(pos / total * 100) : 0);
  $("pct-total").textContent = pct + "%";
}

function actualizarBotonPlay() {
  const pausado = audio.paused;
  // en un <svg> la propiedad .hidden no existe; hay que cambiar el atributo
  $("ico-play").toggleAttribute("hidden", !pausado);
  $("ico-pausa").toggleAttribute("hidden", pausado);
  $("btn-play").setAttribute("aria-label", pausado ? "Reproducir" : "Pausar");
  $("ico-play-t").toggleAttribute("hidden", !pausado);
  $("ico-pausa-t").toggleAttribute("hidden", pausado);
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = pausado ? "paused" : "playing";
}

function actualizarMediaSession() {
  if (!("mediaSession" in navigator) || !estado.libro) return;
  const l = estado.libro;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: l.pistas[estado.pista].nombre,
    artist: l.titulo,
    album: l.titulo,
    artwork: l.portadaId && urlsPortada.get(l.portadaId)
      ? [{ src: urlsPortada.get(l.portadaId), sizes: "800x800", type: "image/jpeg" }]
      : [{ src: "icons/icon-512.png", sizes: "512x512", type: "image/png" }],
  });
  const ms = navigator.mediaSession;
  const h = (acc, fn) => { try { ms.setActionHandler(acc, fn); } catch {} };
  h("play", () => audio.play());
  h("pause", () => audio.pause());
  h("seekbackward", () => saltar(-30));
  h("seekforward", () => saltar(30));
  h("previoustrack", anterior);
  h("nexttrack", siguiente);
  h("seekto", e => { audio.currentTime = e.seekTime; });
}

// ---------- seguir el texto ----------
const lectura = { pista: -1, actual: -1, spans: [], manualHasta: 0 };
const tieneTexto = l => !!l && l.pistas.some(p => p.frases && p.frases.length);

function abrirTexto() {
  $("panel-texto").hidden = false;
  document.body.classList.add("sin-scroll");
  $("hueco-progreso").appendChild(document.querySelector(".progreso"));   // la misma barra del reproductor
  mostrarControles(false);
  aplicarPreferenciasLectura();
  lectura.pista = -1;
  lectura.libre = !tieneTexto(estado.libro);
  if (lectura.libre) pintarEpubLibre(); else pintarTexto();
}

// ----- Libros solo con audio: el EPUB se lee libremente, sin sincronía -----
// Extrae el texto de un EPUB (solo párrafos y títulos, sin código ni estilos).
function leerEpub(bytes) {
  const zip = fflate.unzipSync(bytes);
  const txt = ruta => zip[ruta] ? fflate.strFromU8(zip[ruta]) : null;
  const xml = t => new DOMParser().parseFromString(t, "application/xml");
  const contenedor = txt("META-INF/container.xml");
  if (!contenedor) throw new Error("no parece un EPUB");
  const rutaOpf = xml(contenedor).querySelector("rootfile")?.getAttribute("full-path");
  const opf = xml(txt(rutaOpf));
  const dir = rutaOpf.includes("/") ? rutaOpf.replace(/[^/]*$/, "") : "";
  const manifiesto = {};
  opf.querySelectorAll("manifest > item").forEach(it => { manifiesto[it.getAttribute("id")] = it.getAttribute("href"); });
  const titulo = opf.querySelector("metadata > title, metadata > *|title")?.textContent?.trim() || "";
  const resolver = href => {
    const partes = (dir + decodeURIComponent(href.split("#")[0])).split("/"), out = [];
    for (const p of partes) { if (p === "..") out.pop(); else if (p && p !== ".") out.push(p); }
    return out.join("/");
  };
  const BLOQUES = "h1,h2,h3,h4,p,li,blockquote,div";
  const capitulos = [];
  opf.querySelectorAll("spine > itemref").forEach(ref => {
    const href = manifiesto[ref.getAttribute("idref")];
    const html = href && txt(resolver(href));
    if (!html) return;
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script,style,nav,sup").forEach(e => e.remove());
    const bloques = [];
    doc.body?.querySelectorAll(BLOQUES).forEach(el => {
      if (el.querySelector(BLOQUES)) return;                 // solo bloques "hoja", para no repetir texto
      const t = el.textContent.replace(/\u00ad/g, "").replace(/\s+/g, " ").trim();
      if (t) bloques.push({ t, h: /^H[1-3]$/.test(el.tagName) });
    });
    if (bloques.reduce((n, b) => n + b.t.length, 0) >= 40) capitulos.push(bloques);
  });
  if (!capitulos.length) throw new Error("no encontré texto");
  return { titulo, capitulos };
}

async function agregarEpub(archivo) {
  const l = estado.libro;
  if (!l || !archivo) return;
  let datos;
  try { datos = leerEpub(new Uint8Array(await archivo.arrayBuffer())); }
  catch (e) { avisar("No pude abrir ese EPUB: " + e.message); return; }
  const anterior = l.epubId;
  l.epubId = uid();
  l.lecturaScroll = 0;
  await BD.guardarArchivo(l.epubId, new Blob([JSON.stringify(datos)], { type: "application/json" }));
  await BD.guardarLibro(l);
  if (anterior) await BD.borrarArchivo(anterior);
  pintarEpubLibre();
}

async function pintarEpubLibre() {
  const l = estado.libro, cont = $("texto-contenido");
  cont.innerHTML = "";
  lectura.spans = [];
  if (!l.epubId) {
    $("texto-capitulo").textContent = "Leer el libro";
    cont.innerHTML = `<div class="sin-epub">
      <p>Este libro se agregó solo con audio, así que el texto no va sincronizado.</p>
      <p>Puedes abrir su EPUB y leerlo a tu ritmo mientras escuchas. La app recordará hasta dónde bajaste.</p>
      <button id="btn-elegir-epub" class="boton-principal">Elegir EPUB</button></div>`;
    $("btn-elegir-epub").onclick = () => $("entrada-epub").click();
    return;
  }
  const blob = await BD.archivo(l.epubId);
  const datos = blob ? JSON.parse(await blob.text()) : { capitulos: [] };
  $("texto-capitulo").textContent = "Lectura libre (sin sincronía)";
  const frag = document.createDocumentFragment();
  for (const cap of datos.capitulos) {
    const sec = document.createElement("section");
    sec.className = "cap-epub";
    for (const b of cap) {
      const el = document.createElement(b.h ? "h3" : "p");
      el.textContent = b.t;
      sec.appendChild(el);
    }
    frag.appendChild(sec);
  }
  cont.appendChild(frag);
  const cambiar = document.createElement("button");
  cambiar.className = "chip cambiar-epub";
  cambiar.textContent = "Usar otro EPUB";
  cambiar.onclick = () => $("entrada-epub").click();
  cont.appendChild(cambiar);
  $("panel-texto").scrollTop = l.lecturaScroll || 0;
}
function cerrarTexto() {
  $("panel-texto").hidden = true;
  document.body.classList.remove("sin-scroll");
  $("oscurecer").style.opacity = 0;
  const prog = document.querySelector(".progreso");
  if (prog && prog.parentElement.id === "hueco-progreso") {
    $("vista-reproductor").insertBefore(prog, document.querySelector(".controles"));
    if (estado.libro) actualizarTiempo();
  }
}

// ----- controles de lectura (aparecen con un toque) -----
function mostrarControles(ver) {
  $("texto-controles").hidden = !ver;
  if (!ver) $("fila-tamano").hidden = true;
  if (ver) { actualizarTiempo(); pintarNombreCapLectura(); }
}
function seccionesEpub() { return [...$("texto-contenido").querySelectorAll(".cap-epub")]; }
function seccionVisible() {
  const panel = $("panel-texto"), secs = seccionesEpub(), y = panel.scrollTop + 90;
  let i = 0;
  secs.forEach((sec, k) => { if (sec.offsetTop <= y) i = k; });
  return i;
}
function pintarNombreCapLectura() {
  const l = estado.libro;
  if (!l) return;
  if (!lectura.libre) {
    $("nombre-cap-lectura").textContent = `${estado.pista + 1}. ${l.pistas[estado.pista].nombre}`;
    return;
  }
  const secs = seccionesEpub();
  if (!secs.length) { $("nombre-cap-lectura").textContent = ""; return; }
  const i = seccionVisible();
  const h = secs[i].querySelector("h3");
  $("nombre-cap-lectura").textContent = h ? h.textContent : `Parte ${i + 1} de ${secs.length}`;
}
function cambiarCapLectura(paso) {
  if (!lectura.libre) {
    const i = estado.pista + paso;
    if (i >= 0 && i < estado.libro.pistas.length) cargarPista(i, 0, !audio.paused);
    return;
  }
  const secs = seccionesEpub();
  const i = Math.max(0, Math.min(secs.length - 1, seccionVisible() + paso));
  if (secs[i]) $("panel-texto").scrollTop = secs[i].offsetTop - 70;
  setTimeout(pintarNombreCapLectura, 50);
}

// ----- tamaño de letra y modo noche -----
const TAMANOS = [0.8, 0.9, 1, 1.12, 1.25, 1.4, 1.6];
function aplicarPreferenciasLectura() {
  const tam = leerPref("tamanoLetra", 1);
  $("texto-contenido").style.setProperty("--tam", tam);
  $("txt-tamano").textContent = Math.round(tam * 100) + "%";
  const noche = leerPref("lecturaNoche", false);
  $("panel-texto").classList.toggle("noche", noche);
  $("btn-noche").classList.toggle("activo", noche);
  aplicarBrillo(leerPref("brilloLectura", 1));
}
function cambiarTamano(paso) {
  const actual = leerPref("tamanoLetra", 1);
  let i = TAMANOS.indexOf(actual); if (i < 0) i = 2;
  i = Math.max(0, Math.min(TAMANOS.length - 1, i + paso));
  guardarPref("tamanoLetra", TAMANOS[i]);
  aplicarPreferenciasLectura();
  if (!lectura.libre) seguirTexto(true);
}

// ----- brillo: deslizar por el borde izquierdo -----
// El navegador no puede cambiar el brillo real del teléfono; se oscurece la pantalla por encima.
function aplicarBrillo(b) {
  b = Math.max(0.15, Math.min(1, b));
  $("oscurecer").style.opacity = $("panel-texto").hidden ? 0 : ((1 - b) * 0.85).toFixed(3);
  $("nivel-brillo").style.height = (((b - 0.15) / 0.85) * 100) + "%";
  return b;
}
const gestoBrillo = { id: null, movio: false, y0: 0, b0: 1, ocultar: 0 };
function iniciarGestosLectura() {
  const panel = $("panel-texto"), zona = $("zona-brillo");
  // la franja izquierda no desplaza el texto (touch-action: none): ahí el dedo ajusta el brillo
  zona.addEventListener("pointerdown", e => {
    gestoBrillo.id = e.pointerId; gestoBrillo.movio = false;
    gestoBrillo.y0 = e.clientY; gestoBrillo.b0 = leerPref("brilloLectura", 1);
    zona.setPointerCapture(e.pointerId);
  });
  zona.addEventListener("pointermove", e => {
    if (e.pointerId !== gestoBrillo.id) return;
    const dy = e.clientY - gestoBrillo.y0;
    if (!gestoBrillo.movio) {
      if (Math.abs(dy) < 8) return;
      gestoBrillo.movio = true;
      clearTimeout(gestoBrillo.ocultar);
      const ind = $("indicador-brillo"); ind.hidden = false; ind.classList.remove("saliendo");
    }
    guardarPref("brilloLectura", aplicarBrillo(gestoBrillo.b0 - dy / 260));   // hacia arriba = más brillo
  });
  const soltar = e => {
    if (e.pointerId !== gestoBrillo.id) return;
    gestoBrillo.id = null;
    if (!gestoBrillo.movio) { mostrarControles($("texto-controles").hidden); return; }   // fue un toque
    gestoBrillo.ocultar = setTimeout(() => {
      const ind = $("indicador-brillo"); ind.classList.add("saliendo");
      setTimeout(() => { ind.hidden = true; }, 300);
    }, 1000);
  };
  zona.addEventListener("pointerup", soltar);
  zona.addEventListener("pointercancel", soltar);

  // un toque en el texto muestra u oculta los controles
  panel.addEventListener("click", e => {
    if (e.target.closest("button, input, .texto-controles, .zona-brillo")) return;
    mostrarControles($("texto-controles").hidden);
  });
}
function pintarTexto() {
  const l = estado.libro, p = l.pistas[estado.pista];
  const cont = $("texto-contenido");
  lectura.pista = estado.pista; lectura.actual = -1; lectura.spans = [];
  cont.innerHTML = "";
  $("texto-capitulo").textContent = `${estado.pista + 1} de ${l.pistas.length} · ${p.nombre}`;
  if (!p.frases || !p.frases.length) {
    cont.innerHTML = '<p class="nota">Este capítulo no tiene texto sincronizado.</p>';
    return;
  }
  let parrafo = document.createElement("p");
  p.frases.forEach((f, i) => {
    const s = document.createElement("span");
    s.className = "frase";
    s.textContent = f.texto + " ";
    s.ondblclick = e => { e.preventDefault(); audio.currentTime = f.t; if (audio.paused) audio.play().catch(() => {}); lectura.manualHasta = 0; };
    parrafo.appendChild(s);
    lectura.spans.push(s);
    // un fragmento que termina en punto final y el siguiente parte con mayúscula: posible fin de párrafo
    if (i % 4 === 3 && /[.!?…»”]$/.test(f.texto)) { cont.appendChild(parrafo); parrafo = document.createElement("p"); }
  });
  cont.appendChild(parrafo);
  $("panel-texto").scrollTop = 0;
  seguirTexto(true);
}
function seguirTexto(forzar = false) {
  if ($("panel-texto").hidden || !estado.libro || lectura.libre) return;
  if (lectura.pista !== estado.pista) { pintarNombreCapLectura(); return pintarTexto(); }
  const frases = estado.libro.pistas[estado.pista].frases;
  if (!frases || !frases.length) return;
  const t = audio.currentTime;
  let lo = 0, hi = frases.length - 1, idx = 0;          // búsqueda binaria de la frase actual
  while (lo <= hi) { const m = (lo + hi) >> 1; if (frases[m].t <= t + 0.05) { idx = m; lo = m + 1; } else hi = m - 1; }
  if (idx === lectura.actual && !forzar) return;
  lectura.spans[lectura.actual]?.classList.remove("leyendo");
  lectura.actual = idx;
  const s = lectura.spans[idx];
  s.classList.add("leyendo");
  if (forzar || Date.now() > lectura.manualHasta) s.scrollIntoView({ block: "center", behavior: forzar ? "auto" : "smooth" });
}

// ---------- velocidad y temporizador ----------
function cambiarVelocidad() {
  const i = VELOCIDADES.indexOf(estado.velocidad);
  estado.velocidad = VELOCIDADES[(i + 1) % VELOCIDADES.length];
  audio.playbackRate = estado.velocidad;
  guardarPref("velocidad", estado.velocidad);
  pintarVelocidad();
}
function pintarVelocidad() {
  $("txt-velocidad").textContent = `${String(estado.velocidad).replace(".", ",")}×`;
}
function cambiarDormir() {
  estado.dormirIdx = (estado.dormirIdx + 1) % DORMIR.length;
  const m = DORMIR[estado.dormirIdx];
  estado.dormirHasta = m > 0 ? Date.now() + m * 60000 : 0;
  pintarDormir();
}
function pintarDormir() {
  const m = DORMIR[estado.dormirIdx];
  let t = "No";
  if (m === -1) t = "Fin cap.";
  else if (m > 0) t = `${Math.max(1, Math.ceil((estado.dormirHasta - Date.now()) / 60000))} min`;
  $("txt-dormir").textContent = t;
  $("btn-dormir").classList.toggle("activo", m !== 0);
}
setInterval(() => {
  if (DORMIR[estado.dormirIdx] > 0) {
    if (Date.now() >= estado.dormirHasta) {
      audio.pause(); estado.dormirIdx = 0; avisar("Temporizador: buenas noches 🌙");
    }
    pintarDormir();
  }
}, 15000);

// ---------- eventos ----------
let arrastrando = false;
const barra = $("barra-tiempo");
barra.addEventListener("input", () => {
  if (!estado.libro) return;
  arrastrando = true;
  const t = fraccionATiempo(barra.value / 10000);
  const u = ubicar(t);
  $("t-actual").textContent = hhmmss(t);
  $("capitulo-actual").textContent = `${u.pista + 1} de ${estado.libro.pistas.length} · ${estado.libro.pistas[u.pista].nombre}`;
  pintarBarra(barra.value / 10000, t);
});
barra.addEventListener("change", async () => {
  if (!estado.libro) return;
  const u = ubicar(fraccionATiempo(barra.value / 10000));
  if (u.pista === estado.pista) audio.currentTime = u.tiempo;
  else await cargarPista(u.pista, u.tiempo, !audio.paused);
  arrastrando = false;
  actualizarTiempo();
});

audio.addEventListener("timeupdate", () => { actualizarTiempo(); guardarPosicion(); seguirTexto(); });
audio.addEventListener("play", actualizarBotonPlay);
audio.addEventListener("pause", () => { actualizarBotonPlay(); guardarPosicion(true); });
audio.addEventListener("ended", async () => {
  const l = estado.libro;
  if (DORMIR[estado.dormirIdx] === -1) { estado.dormirIdx = 0; pintarDormir(); }
  else if (estado.pista < l.pistas.length - 1) return cargarPista(estado.pista + 1, 0, true);
  if (estado.pista >= l.pistas.length - 1) {
    l.terminado = true; await guardarPosicion(true); avisar("¡Terminaste el libro! 🎉");
  } else {
    await cargarPista(estado.pista + 1, 0, false);   // dejarlo listo en el siguiente capítulo
  }
});
document.addEventListener("visibilitychange", () => { if (document.hidden) guardarPosicion(true); });

$("btn-play").onclick = alternar;
$("btn-atras").onclick = () => saltar(-30);
$("btn-adelante").onclick = () => saltar(30);
$("btn-anterior").onclick = anterior;
$("btn-siguiente").onclick = siguiente;
$("btn-velocidad").onclick = cambiarVelocidad;
$("btn-dormir").onclick = cambiarDormir;
$("btn-volver").onclick = () => { guardarPosicion(true); mostrarBiblioteca(); };
$("btn-texto").onclick = () => ($("panel-texto").hidden ? abrirTexto() : cerrarTexto());
$("btn-cerrar-texto").onclick = cerrarTexto;
$("entrada-epub").onchange = e => { const f = e.target.files[0]; e.target.value = ""; agregarEpub(f); };
// lectura libre: recordar hasta dónde bajó la persona
let guardadoScroll;
$("panel-texto").addEventListener("scroll", () => {
  if (!lectura.libre || !estado.libro?.epubId) return;
  if (!$("texto-controles").hidden) pintarNombreCapLectura();
  clearTimeout(guardadoScroll);
  guardadoScroll = setTimeout(() => { estado.libro.lecturaScroll = $("panel-texto").scrollTop; BD.guardarLibro(estado.libro).catch(() => {}); }, 600);
}, { passive: true });
$("btn-play-texto").onclick = alternar;
$("btn-cap-ant").onclick = () => cambiarCapLectura(-1);
$("btn-cap-sig").onclick = () => cambiarCapLectura(1);
$("btn-tamano").onclick = () => { $("fila-tamano").hidden = !$("fila-tamano").hidden; };
$("btn-letra-menos").onclick = () => cambiarTamano(-1);
$("btn-letra-mas").onclick = () => cambiarTamano(1);
$("btn-noche").onclick = () => { guardarPref("lecturaNoche", !leerPref("lecturaNoche", false)); aplicarPreferenciasLectura(); };
iniciarGestosLectura();
// si la persona desplaza el texto con el dedo, no se lo movemos por 6 segundos
["touchmove", "wheel"].forEach(ev => $("panel-texto").addEventListener(ev, () => { lectura.manualHasta = Date.now() + 6000; }, { passive: true }));
$("portada").onclick = () => $("entrada-portada").click();
$("entrada-portada").onchange = e => { const f = e.target.files[0]; e.target.value = ""; cambiarPortada(f); };
$("btn-agregar").onclick = () => $("entrada-archivos").click();
$("entrada-archivos").onchange = e => { const f = [...e.target.files]; e.target.value = ""; importar(f); };
$("btn-borrar").onclick = () => {
  const dlg = $("dlg-confirmar");
  dlg.showModal();
  dlg.addEventListener("close", async () => {
    if (dlg.returnValue !== "ok") return;
    audio.pause(); audio.removeAttribute("src"); audio.load();
    await BD.borrarLibro(estado.libro);
    avisar(`“${estado.libro.titulo}” borrado`);
    estado.libro = null;
    mostrarBiblioteca();
  }, { once: true });
};

// ---------- inicio ----------
pintarVelocidad();
pintarDormir();
mostrarBiblioteca();
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

window.addEventListener("resize", () => { if (estado.libro && !$("vista-reproductor").hidden) actualizarTiempo(); });
