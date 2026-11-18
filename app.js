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
    if (!EXT_AUDIO.test(nombre) || /(^|\/)(__MACOSX|_partes)\//.test(nombre)) return;
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
    } else if (EXT_AUDIO.test(f.name)) {
      salida.push({ nombre: f.name, blob: f });
    }
  }
  // si vienen MP3 por capítulo y además un .m4b del libro entero, quedarse con los capítulos
  const capitulos = salida.filter(a => !/\.m4b$/i.test(a.nombre));
  const elegidos = capitulos.length > 1 ? capitulos : salida;
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
      libro.pistas.push({ nombre: nombreBonito(pistas[i].nombre), idArchivo, duracion: await duracionDe(pistas[i].blob) });
    }
    await BD.guardarLibro(libro);
  } catch (e) {
    avisar("No se pudo guardar (¿falta espacio en el teléfono?): " + e.message, 8000);
    return;
  }
  avisar(`“${titulo}” agregado`);
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
  $("titulo-barra").textContent = "Mis audiolibros";

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
  $("titulo-barra").textContent = l.titulo;
  const portada = $("portada");
  portada.style.background = colorPortada(l.titulo);
  portada.textContent = iniciales(l.titulo);

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

  $("capitulo-actual").textContent = `${i + 1} de ${l.pistas.length} · ${l.pistas[i].nombre}`;
  [...$("lista-capitulos").children].forEach((li, k) => li.classList.toggle("activo", k === i));
  actualizarTiempo();
  actualizarMediaSession();
  guardarPosicion(true);
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

function actualizarTiempo() {
  const d = audio.duration || estado.libro?.pistas[estado.pista]?.duracion || 0;
  $("t-actual").textContent = hhmmss(audio.currentTime);
  $("t-total").textContent = "-" + hhmmss(Math.max(0, d - audio.currentTime));
  if (!arrastrando) $("barra-tiempo").value = d ? Math.round((audio.currentTime / d) * 1000) : 0;
  $("barra-tiempo").style.setProperty("--p", ($("barra-tiempo").value / 10) + "%");
}

function actualizarBotonPlay() {
  const pausado = audio.paused;
  $("ico-play").hidden = !pausado;
  $("ico-pausa").hidden = pausado;
  $("btn-play").setAttribute("aria-label", pausado ? "Reproducir" : "Pausar");
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = pausado ? "paused" : "playing";
}

function actualizarMediaSession() {
  if (!("mediaSession" in navigator) || !estado.libro) return;
  const l = estado.libro;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: l.pistas[estado.pista].nombre,
    artist: l.titulo,
    album: l.titulo,
    artwork: [{ src: "icons/icon-512.png", sizes: "512x512", type: "image/png" }],
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

// ---------- velocidad y temporizador ----------
function cambiarVelocidad() {
  const i = VELOCIDADES.indexOf(estado.velocidad);
  estado.velocidad = VELOCIDADES[(i + 1) % VELOCIDADES.length];
  audio.playbackRate = estado.velocidad;
  guardarPref("velocidad", estado.velocidad);
  pintarVelocidad();
}
function pintarVelocidad() {
  $("btn-velocidad").textContent = `Velocidad ${String(estado.velocidad).replace(".", ",")}×`;
}
function cambiarDormir() {
  estado.dormirIdx = (estado.dormirIdx + 1) % DORMIR.length;
  const m = DORMIR[estado.dormirIdx];
  estado.dormirHasta = m > 0 ? Date.now() + m * 60000 : 0;
  pintarDormir();
}
function pintarDormir() {
  const m = DORMIR[estado.dormirIdx];
  let t = "Dormir: no";
  if (m === -1) t = "Dormir: fin del capítulo";
  else if (m > 0) t = `Dormir: ${Math.max(1, Math.ceil((estado.dormirHasta - Date.now()) / 60000))} min`;
  $("btn-dormir").textContent = t;
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
  arrastrando = true;
  const d = audio.duration || 0;
  $("t-actual").textContent = hhmmss((barra.value / 1000) * d);
  barra.style.setProperty("--p", (barra.value / 10) + "%");
});
barra.addEventListener("change", () => {
  const d = audio.duration || 0;
  if (d) audio.currentTime = (barra.value / 1000) * d;
  arrastrando = false;
});

audio.addEventListener("timeupdate", () => { actualizarTiempo(); guardarPosicion(); });
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
