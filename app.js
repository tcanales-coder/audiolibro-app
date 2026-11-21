// Audiolibro: biblioteca y reproductor (etapa 1).
const $ = id => document.getElementById(id);
// Justo después de una actualización, el teléfono puede mezclar la página vieja con el código nuevo
// (o al revés). Si falta una pieza nueva de la página, se recarga una vez pidiendo todo de nuevo.
if (!$("tirador-ini")) {
  let recargada = false;
  try { recargada = sessionStorage.getItem("recargaVersion") === "1"; sessionStorage.setItem("recargaVersion", "1"); } catch {}
  if (!recargada) location.reload();
} else { try { sessionStorage.removeItem("recargaVersion"); } catch {} }
const audio = $("audio");
const TEMA = window.TEMA_APP || null;
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
// Archivos extra que agrega «Compartir libro» (ver armarZipLibro)
const RE_PORTADA_ZIP = /(^|\/)_portada\.(jpe?g|png|webp)$/i;
const RE_EXTRA_ZIP = /^_(audiolibro|texto)\.json$|^_portada\.(jpe?g|png|webp)$/i;

async function abrirZip(archivo) {
  const audios = [];
  const pendientes = [];
  const unzip = new fflate.Unzip(entrada => {
    const nombre = entrada.name;
    if (!(EXT_AUDIO.test(nombre) || /\.json$/i.test(nombre) || RE_PORTADA_ZIP.test(nombre)) || /(^|\/)(__MACOSX|_partes)\//.test(nombre)) return;
    const trozos = [];
    pendientes.push(new Promise((ok, mal) => {
      entrada.ondata = (err, datos, final) => {
        if (err) return mal(err);
        trozos.push(datos);
        if (final) {
          const tipo = RE_PORTADA_ZIP.test(nombre) ? "image/" + nombre.split(".").pop().toLowerCase().replace("jpg", "jpeg") : tipoPorNombre(nombre);
          audios.push({ nombre: nombre.replace(/^.*\//, ""), blob: new Blob(trozos, { type: tipo }) });
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
  // extras de un libro compartido desde la app: título y nombres, texto libre y portada
  const extras = {};
  for (const a of salida.filter(a => RE_EXTRA_ZIP.test(a.nombre))) {
    if (/^_portada/i.test(a.nombre)) extras.portada = a.blob;
    else if (/^_texto/i.test(a.nombre)) extras.texto = a.blob;
    else { try { extras.manifiesto = JSON.parse(await a.blob.text()); } catch {} }
  }
  // .json = sincronización texto-audio que genera el notebook (mismo nombre que el MP3)
  const base = n => n.replace(/\.[^.]+$/, "");
  const sinc = new Map();
  for (const a of salida.filter(a => /\.json$/i.test(a.nombre) && !RE_EXTRA_ZIP.test(a.nombre))) {
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
  elegidos.sort((a, b) => ordenNatural(a.nombre, b.nombre));
  elegidos.extras = extras;
  return elegidos;
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

  const extras = pistas.extras || {}, man = extras.manifiesto || {};
  const nombres = Array.isArray(man.pistas) && man.pistas.length === pistas.length ? man.pistas : null;
  const titulo = await pedirTitulo(man.titulo || tituloSugerido(lista),
    `${pistas.length} ${pistas.length === 1 ? "archivo" : "capítulos"} de audio`);
  if (!titulo) return;

  const libro = { id: uid(), titulo, creado: Date.now(), pistas: [], pos: { pista: 0, tiempo: 0 }, terminado: false };
  try {
    for (let i = 0; i < pistas.length; i++) {
      avisar(`Guardando ${i + 1} de ${pistas.length}…`, 60000);
      const idArchivo = uid();
      await BD.guardarArchivo(idArchivo, pistas[i].blob);
      libro.pistas.push({ nombre: (nombres && nombres[i]) || nombreBonito(pistas[i].nombre), idArchivo, duracion: await duracionDe(pistas[i].blob),
                          frases: pistas[i].frases || null });
    }
    if (extras.portada) { libro.portadaId = uid(); await BD.guardarArchivo(libro.portadaId, extras.portada); }
    if (extras.texto) { libro.epubId = uid(); await BD.guardarArchivo(libro.epubId, new Blob([extras.texto], { type: "application/json" })); }
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

// ---------- compartir un libro ----------
// Arma un .zip que esta misma app sabe importar: audios numerados, la sincronización de cada
// capítulo (.json), y extras con el título, los nombres reales, el texto libre y la portada.
const EXT_POR_TIPO = { "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac",
                       "audio/ogg": "ogg", "audio/wav": "wav", "audio/x-wav": "wav", "audio/flac": "flac" };
const nombreParaZip = s => s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\w\s.,()-]/g, "")
  .trim().replace(/\s+/g, "_").slice(0, 60) || "libro";

async function armarZipLibro(l, avance) {
  const trozos = [];
  let falla = null;
  const zip = new fflate.Zip((err, datos) => { if (err) falla = err; else trozos.push(datos); });
  const agregar = async (nombre, blob) => {
    const f = new fflate.ZipPassThrough(nombre);      // sin comprimir: los audios ya vienen comprimidos
    zip.add(f);
    const lector = blob.stream().getReader();
    for (;;) {
      const { value, done } = await lector.read();
      if (done) { f.push(new Uint8Array(0), true); break; }
      f.push(value);
    }
    if (falla) throw falla;
  };
  const texto = o => new Blob([JSON.stringify(o)], { type: "application/json" });
  const ancho = Math.max(3, String(l.pistas.length).length);
  await agregar("_audiolibro.json", texto({ version: 1, titulo: l.titulo, pistas: l.pistas.map(p => p.nombre) }));
  for (let i = 0; i < l.pistas.length; i++) {
    const p = l.pistas[i];
    avance(i + 1, l.pistas.length);
    const blob = await BD.archivo(p.idArchivo);
    if (!blob) throw new Error(`Falta el audio del capítulo ${i + 1}`);
    const nombre = `${String(i + 1).padStart(ancho, "0")} - ${nombreParaZip(p.nombre)}`;
    await agregar(`${nombre}.${EXT_POR_TIPO[blob.type] || "mp3"}`, blob);
    if (p.frases && p.frases.length) await agregar(`${nombre}.json`, texto({ version: 1, titulo: p.nombre, frases: p.frases }));
  }
  if (l.portadaId) {
    const b = await BD.archivo(l.portadaId);
    if (b) await agregar(`_portada.${(b.type.split("/")[1] || "jpeg").replace("jpeg", "jpg")}`, b);
  }
  if (l.epubId) { const b = await BD.archivo(l.epubId); if (b) await agregar("_texto.json", b); }
  zip.end();
  if (falla) throw falla;
  return new File(trozos, nombreParaZip(l.titulo) + ".zip", { type: "application/zip" });
}

// Nota: Chrome en Android no deja pasar archivos .zip al menú Compartir (da "Permission denied"),
// así que el libro se guarda en el teléfono y se manda desde WhatsApp como documento.
const compartir = { archivo: null, url: "", libro: null };
async function abrirCompartir(l = estado.libro) {
  if (!l) return;
  const est = $("compartir-estado");
  est.classList.remove("error");
  $("btn-compartir-guardar").hidden = true;
  $("compartir-pasos").hidden = true;
  if (compartir.url) URL.revokeObjectURL(compartir.url);
  compartir.archivo = null; compartir.url = ""; compartir.libro = l;
  $("dlg-compartir").showModal();
  try {
    const archivo = await armarZipLibro(l, (i, n) => { est.textContent = `Preparando capítulo ${i} de ${n}…`; });
    if (compartir.libro !== l || !$("dlg-compartir").open) return;
    compartir.archivo = archivo;
    est.textContent = `Listo: ${archivo.name} · ${(archivo.size / 1048576).toFixed(0)} MB`;
    $("btn-compartir-guardar").hidden = false;
  } catch (e) {
    est.textContent = "No se pudo armar el archivo: " + e.message;
    est.classList.add("error");
  }
}
function guardarCompartido() {
  const f = compartir.archivo;
  if (!f) return;
  if (!compartir.url) compartir.url = URL.createObjectURL(f);
  const a = document.createElement("a");
  a.href = compartir.url; a.download = f.name;
  document.body.appendChild(a); a.click(); a.remove();
  $("compartir-estado").textContent = "Guardado en Descargas. Ahora mándalo así:";
  $("compartir-nombre").textContent = f.name;
  $("compartir-pasos").hidden = false;
  $("btn-compartir-guardar").textContent = "Guardar otra vez";
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
  $("vista-generando").hidden = true;
  clearInterval(generacion.reloj);
  $("vista-biblioteca").hidden = false;
  $("btn-volver").hidden = true;
  $("btn-texto").hidden = true;
  cerrarTexto();
  $("titulo-barra").textContent = TEMA ? TEMA.nombre : "Mis audiolibros";

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
        ${l.generando
          ? `<span class="d generando">${textoEstadoCorto(l.generando)}</span>`
          : `<span class="d">${l.pistas.length} ${l.pistas.length === 1 ? "parte" : "capítulos"}${total ? " · " + duracionTexto(total) : ""}</span>
             <span class="barra-mini"><span style="width:${pct}%"></span></span>`}
      </span>
      <span class="pct">${l.generando ? "" : pct + "%"}</span>`;
    b.querySelector(".t").textContent = l.titulo;
    const url = await urlPortada(l);
    if (url) { const m = b.querySelector(".mini"); fondoPortada(m, l, url); m.textContent = ""; }
    b.onclick = () => abrirLibro(l.id);
    li.appendChild(b);
    if (!l.generando && l.pistas.length) {          // compartir directo desde la biblioteca
      li.classList.add("con-compartir");
      const c = document.createElement("button");
      c.className = "compartir-mini icono";
      c.setAttribute("aria-label", `Compartir «${l.titulo}»`);
      c.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="M8.3 10.8l7.4-4.4M8.3 13.2l7.4 4.4"/></svg>';
      c.onclick = () => abrirCompartir(l);
      li.appendChild(c);
    }
    ul.appendChild(li);
  }
  mostrarEspacio();
  mostrarCuota();
}

// Barra con las horas de GPU de la semana en Kaggle (se consulta como mucho cada 5 minutos)
const cuotaCache = { t: 0, datos: null };
async function mostrarCuota() {
  if (!KAGGLE.listo()) { $("cuota").hidden = true; return; }
  try {
    if (!cuotaCache.datos || Date.now() - cuotaCache.t > 300000) {
      cuotaCache.datos = await KAGGLE.cuota(); cuotaCache.t = Date.now();
    }
  } catch { if (!cuotaCache.datos) { $("cuota").hidden = true; return; } }
  const c = cuotaCache.datos, total = c.total || 30;
  const f = x => x.toLocaleString("es", { maximumFractionDigits: 1 });
  const pct = x => Math.min(100, x / total * 100) + "%";
  $("cuota-horas").textContent = `${f(c.usadas)} de ${f(total)} h`;
  $("cuota-usada").style.width = pct(c.usadas);
  $("cuota-reservada").style.width = pct(Math.min(c.reservadas, Math.max(0, total - c.usadas)));
  const partes = [];
  if (c.reservadas > 0.05) partes.push(`${f(c.reservadas)} h reservadas por lo que está corriendo`);
  if (c.renueva) partes.push("se renueva el " + c.renueva.toLocaleString("es", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }));
  $("cuota-renueva").textContent = partes.join(" · ");
  $("cuota").hidden = false;
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
// Un libro puede estar a la vez en el reproductor y generándose: usar siempre el mismo objeto
// en memoria, para que un guardado no pise lo que hizo el otro.
const enUso = l => (estado.libro && estado.libro.id === l.id) ? estado.libro
  : (generacion.libro && generacion.libro.id === l.id) ? generacion.libro : l;

async function abrirLibro(id) {
  let l = await BD.libro(id);
  if (!l) return mostrarBiblioteca();
  l = enUso(l);
  const yaSonando = estado.libro === l && !!audio.src;
  if (l.generando && !l.pistas.length) return abrirGenerando(l);
  l.abierto = Date.now();
  await BD.guardarLibro(l);
  estado.libro = l;
  guardarPref("ultimoLibro", l.id);       // al volver a abrir la app, sigue aquí

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

  pintarSegmentos();                        // antes de cargar: si no, quedan los segmentos del libro anterior
  if (yaSonando) {                          // no cortar lo que está sonando (p. ej. llegaron capítulos nuevos)
    [...ol.children].forEach((li, k) => li.classList.toggle("activo", k === estado.pista));
  } else {
    await cargarPista(l.pos.pista || 0, l.pos.tiempo || 0, false);
  }
  pintarSegmentos();
  actualizarTiempo();
  pintarAvisoGenerando();
  window.scrollTo(0, 0);
  revisarSiQuedoAMedias(l);
}

// Libros dados por terminados antes de este arreglo: si Kaggle cortó la última corrida, quedaron incompletos.
// Se revisa una sola vez por libro mirando el registro de esa corrida.
async function revisarSiQuedoAMedias(l) {
  const g = l.generado;
  if (!g || !g.kernel || g.revisado || !KAGGLE.listo()) return;
  try {
    const { registro } = await KAGGLE.archivosDeSalida(g.kernel);
    g.revisado = true;
    if (registro) {
      if (registro.capitulosTotales) g.capitulosTotales = registro.capitulosTotales;
      g.aMedias = registro.cortado || registro.pausado || (!!registro.capitulosTotales && l.pistas.length < registro.capitulosTotales);
    }
    await BD.guardarLibro(l);
    if (estado.libro === l) pintarAvisoGenerando();
  } catch {}
}

// "Generar lo que falta": el libro vuelve a generarse desde donde quedó (los capítulos hechos no se repiten).
// Primero se lanza (o se retoma) la corrida nueva y recién después se abre el avance:
// así nunca se vuelve a revisar la corrida vieja, que podría darse por terminada.
async function seguirLibroAMedias(l) {
  if (procesando.has(l.id)) return;
  procesando.add(l.id);
  const previo = l.generado;
  const g = { ...previo, partes: [...(previo.partes || [previo.kernel])], aMedias: false, revisado: false,
              etapa: "resto", estado: "QUEUED", pausado: false, cortado: false, archivos: null };
  avisar("Pidiéndole a Kaggle lo que falta…");
  try {
    // ¿Ya hay una corrida andando de un intento anterior? Se usa esa, para no gastar horas dos veces.
    const candidatas = [g.kernel, `${g.partes[0]}-p${g.partes.length + 1}`];
    let andando = null;
    for (const k of candidatas) {
      try { const st = await KAGGLE.estado(k); if (st.estado === "RUNNING" || st.estado === "QUEUED") { andando = { k, st }; break; } } catch {}
    }
    l.generando = g; delete l.generado;
    if (andando) {
      if (!g.partes.includes(andando.k)) g.partes.push(andando.k);
      g.kernel = andando.k; g.estado = andando.st.estado;
    } else {
      await lanzarSiguienteParte(l);
    }
    await BD.guardarLibro(l);
  } catch (e) {
    l.generado = previo; delete l.generando;
    await BD.guardarLibro(l);
    avisar("No se pudo seguir: " + e.message, 6000);
    return;
  } finally { procesando.delete(l.id); }
  abrirGenerando(l);
}

// Kaggle dio la corrida por terminada pero faltan capítulos del libro: no se da por completo.
function faltanCapitulos(l, g) { return !!g.capitulosTotales && l.pistas.length < g.capitulosTotales; }
function pintarAvisoGenerando() {
  const l = estado.libro, g = l && l.generando, a = $("aviso-generando");
  const medias = l && !g && l.generado && l.generado.aMedias;
  a.hidden = !g && !medias;
  if (medias) a.textContent = `⚠️ Este libro quedó a medias: tienes ${l.pistas.length}${l.generado.capitulosTotales ? ` de ${l.generado.capitulosTotales}` : ""} capítulos. Toca para generar lo que falta.`;
  if (g) a.textContent = `⏳ ${textoEstadoCorto(g)}. Llevas ${l.pistas.length} ${l.pistas.length === 1 ? "capítulo" : "capítulos"} para escuchar · Ver avance`;
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
  if (audio.paused) reproducirSeguro();
  else audio.pause();
}
// Android a veces deja el audio "dormido" tras pasar a otra app: si no arranca, se recarga
// el capítulo desde el teléfono en el mismo punto y se intenta de nuevo.
async function reproducirSeguro() {
  const t = audio.currentTime || estado.libro.pos?.tiempo || 0;
  const recargar = () => cargarPista(estado.pista, t, true);
  if (audio.error || !audio.src) return recargar();
  let arranco = false;
  const marca = audio.currentTime;
  const vigia = setTimeout(() => {
    if (!arranco || (audio.currentTime === marca && !audio.paused)) { audio.pause(); recargar(); }
  }, 2500);
  try { await audio.play(); arranco = true; }
  catch (e) { clearTimeout(vigia); if (e.name === "NotAllowedError") avisar("Toca play de nuevo"); else recargar(); }
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
  return (l.pistas[i] && l.pistas[i].duracion) || 0;
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
  guardarPref("textoAbierto", true);
  $("panel-texto").hidden = false;
  iconoTexto(true);
  salirModos();
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
  const d = destacados(); Object.keys(d).forEach(k => { if ((k.startsWith("r:") ? d[k].a.k : k).startsWith("e:")) delete d[k]; }); guardarDestacados(d);
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
  datos.capitulos.forEach((cap, ci) => {
    const sec = document.createElement("section");
    sec.className = "cap-epub";
    cap.forEach((b, bi) => {
      const el = document.createElement(b.h ? "h3" : "p");
      el.textContent = b.t;
      if (!b.h) { el.className = "frase"; el.dataset.clave = `e:${ci}:${bi}`; }
      sec.appendChild(el);
    });
    frag.appendChild(sec);
  });
  cont.appendChild(frag);
  pintarDestacados();
  const cambiar = document.createElement("button");
  cambiar.className = "chip cambiar-epub";
  cambiar.textContent = "Usar otro EPUB";
  cambiar.onclick = () => $("entrada-epub").click();
  cont.appendChild(cambiar);
  $("panel-texto").scrollTop = l.lecturaScroll || 0;
}
function cerrarTexto() {
  salirModos();
  $("panel-texto").hidden = true;
  iconoTexto(false);
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
  if (!ver && (modoLectura.destacar || modoLectura.estrella)) return;   // con destacador o estrella, el panel queda a la vista
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
  $("lista-destacados")?.style.setProperty("--tam", tam);
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
    if (e.target.closest("button, input, .texto-controles, .zona-brillo, .tirador")) return;
    if (modoLectura.destacar) { toqueDestacar(e); return; }
    if (modoLectura.estrella) return;
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
    s.dataset.clave = `p:${estado.pista}:${i}`;
    s.ondblclick = e => { e.preventDefault(); if (modoLectura.destacar) return; audio.currentTime = f.t; if (audio.paused) audio.play().catch(() => {}); lectura.manualHasta = 0; };
    parrafo.appendChild(s);
    lectura.spans.push(s);
    // un fragmento que termina en punto final y el siguiente parte con mayúscula: posible fin de párrafo
    if (i % 4 === 3 && /[.!?…»”]$/.test(f.texto)) { cont.appendChild(parrafo); parrafo = document.createElement("p"); }
  });
  cont.appendChild(parrafo);
  pintarDestacados();
  $("panel-texto").scrollTop = 0;
  seguirTexto(true);
}
function seguirTexto(forzar = false) {
  if ($("panel-texto").hidden || !estado.libro || lectura.libre) return;
  if (modoLectura.estrella) { lectura.pista = -1; return; }      // se repinta al volver al texto
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

// ----- destacador y frases destacadas -----
// Se guardan solo en este teléfono (no viajan en el zip al compartir el libro).
// Clave: "p:<capítulo>:<frase>" en libros con texto sincronizado; "e:<sección>:<párrafo>" en lectura libre.
const modoLectura = { destacar: false, estrella: false };

const destacados = () => (estado.libro ? leerPref("destacados:" + estado.libro.id, {}) : {});
const guardarDestacados = d => { if (estado.libro) guardarPref("destacados:" + estado.libro.id, d); };

function iconoTexto(abierto) {
  $("ico-abrir-texto")?.toggleAttribute("hidden", abierto);
  $("ico-cerrar-texto")?.toggleAttribute("hidden", !abierto);
  $("btn-texto").setAttribute("aria-label", abierto ? "Volver al reproductor" : "Seguir el texto");
}
function pintarDestacados() {
  const d = destacados();
  const frases = [...$("texto-contenido").querySelectorAll(".frase")];
  const pos = new Map(frases.map((el, i) => [el.dataset.clave, i]));
  const tramos = new Map();                                    // índice de frase → [[desde, hasta, color, clave]]
  for (const [k, x] of Object.entries(d)) {
    if (!k.startsWith("r:")) continue;
    const ia = pos.get(x.a.k), ib = pos.get(x.b.k);
    if (ia == null || ib == null) continue;
    for (let i = ia; i <= ib; i++) {
      const largo = frases[i].textContent.length;
      if (!tramos.has(i)) tramos.set(i, []);
      tramos.get(i).push([i === ia ? x.a.i : 0, i === ib ? x.b.i : largo, x.c, k]);
    }
  }
  frases.forEach((el, i) => {
    const x = d[el.dataset.clave];
    el.classList.toggle("destacada", !!x);
    el.dataset.color = x ? x.c : "";
    const texto = el.textContent;
    if (el.querySelector("mark") || tramos.has(i)) el.textContent = texto;   // quita marcas viejas
    const ts = (tramos.get(i) || []).sort((a, b) => a[0] - b[0]);
    if (!ts.length) return;
    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (const [a0, b, c, k] of ts) {
      const a = Math.max(a0, cursor);
      if (b <= a) continue;
      if (a > cursor) frag.append(texto.slice(cursor, a));
      const m = document.createElement("mark");
      m.className = "tramo"; m.dataset.color = c; m.dataset.tramo = k; m.textContent = texto.slice(a, b);
      frag.append(m); cursor = b;
    }
    if (cursor < texto.length) frag.append(texto.slice(cursor));
    el.textContent = ""; el.append(frag);
  });
  if (lectura.actual >= 0) lectura.spans[lectura.actual]?.classList.add("leyendo");
  pintarTiradores();
}
// Toques con el destacador: uno = frase completa; dos rápidos = inicio de un tramo libre, y el siguiente toque = fin.
// Destacador: un toque en una frase la destaca entera y muestra dos marcadores (inicio y fin)
// que se arrastran como los del teléfono. Un toque sobre algo ya destacado lo quita.
const tiradores = { activo: null, arrastre: null };
function puntoEnTexto(x, y) {
  let nodo, off;
  if (document.caretRangeFromPoint) { const r = document.caretRangeFromPoint(x, y); if (!r) return null; nodo = r.startContainer; off = r.startOffset; }
  else if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); if (!p) return null; nodo = p.offsetNode; off = p.offset; }
  else return null;
  const el = (nodo.nodeType === 3 ? nodo.parentElement : nodo)?.closest(".frase");
  if (!el || !$("texto-contenido").contains(el)) return null;
  const r = document.createRange(); r.setStart(el, 0); r.setEnd(nodo, off);
  return { el, i: r.toString().length };
}
function ajustarPalabra(el, i, haciaAtras) {
  const t = el.textContent;
  if (haciaAtras) { while (i > 0 && !/\s/.test(t[i - 1])) i--; }
  else { while (i < t.length && !/\s/.test(t[i])) i++; }
  return i;
}
function capituloDe(el) {
  if (!lectura.libre) return `${estado.pista + 1}. ${estado.libro.pistas[estado.pista].nombre}`;
  const sec = el.closest(".cap-epub"), secs = seccionesEpub();
  const h = sec && sec.querySelector("h3");
  return h ? h.textContent : `Parte ${secs.indexOf(sec) + 1}`;
}
const frasesVisibles = () => [...$("texto-contenido").querySelectorAll(".frase")];
function textoDeTramo(a, b) {
  const frases = frasesVisibles(), na = frases.findIndex(f => f.dataset.clave === a.k), nb = frases.findIndex(f => f.dataset.clave === b.k);
  if (na < 0 || nb < 0) return "";
  let texto = "";
  for (let n = na; n <= nb; n++) {
    const t = frases[n].textContent;
    texto += t.slice(n === na ? a.i : 0, n === nb ? b.i : t.length) + " ";
  }
  return texto.replace(/\s+/g, " ").trim();
}
function toqueDestacar(e) {
  const d = destacados();
  const tramo = e.target.closest("mark.tramo");
  if (tramo) { delete d[tramo.dataset.tramo]; guardarDestacados(d); tiradores.activo = null; pintarDestacados(); return; }
  const f = e.target.closest(".frase");
  if (!f) { tiradores.activo = null; pintarTiradores(); return; }
  if (d[f.dataset.clave]) { delete d[f.dataset.clave]; guardarDestacados(d); pintarDestacados(); return; }   // destacado de la versión anterior
  const a = { k: f.dataset.clave, i: 0 }, b = { k: f.dataset.clave, i: f.textContent.trimEnd().length };
  const k = "r:" + Date.now().toString(36);
  d[k] = { c: leerPref("colorDestacador", 0), t: textoDeTramo(a, b), cap: capituloDe(f), o: Date.now(), a, b };
  guardarDestacados(d);
  tiradores.activo = k;
  pintarDestacados();
}
// rectángulo del borde de un tramo (inicio o fin) en la pantalla
function bordeTramo(k, fin) {
  const marcas = [...$("texto-contenido").querySelectorAll(`mark[data-tramo="${k}"]`)];
  const m = fin ? marcas[marcas.length - 1] : marcas[0];
  if (!m) return null;
  const rects = [...m.getClientRects()].filter(r => r.width > 0);
  if (!rects.length) return null;
  let r = fin ? rects[rects.length - 1] : rects[0];
  if (fin && /\s$/.test(m.textContent)) {                       // no contar el espacio final
    const rg = document.createRange(), n = m.lastChild; rg.setStart(n, 0); rg.setEnd(n, n.length - 1);
    const rr = [...rg.getClientRects()].filter(x => x.width > 0); if (rr.length) r = rr[rr.length - 1];
  }
  return { x: fin ? r.right : r.left, top: r.top, bottom: r.bottom };
}
function pintarTiradores() {
  const panel = $("panel-texto"), ini = $("tirador-ini"), fin = $("tirador-fin");
  if (!ini) return;
  const k = tiradores.activo;
  const ok = k && modoLectura.destacar && destacados()[k];
  const p1 = ok && bordeTramo(k, false), p2 = ok && bordeTramo(k, true);
  if (!p1 || !p2) { ini.hidden = fin.hidden = true; if (!tiradores.arrastre) tiradores.activo = ok ? k : null; return; }
  const base = panel.getBoundingClientRect();
  const poner = (el, p) => { el.hidden = false; el.style.left = (p.x - base.left) + "px"; el.style.top = (p.bottom - base.top + panel.scrollTop) + "px"; };
  poner(ini, p1); poner(fin, p2);
}
function iniciarTiradores() {
  ["tirador-ini", "tirador-fin"].forEach(id => {
    const el = $(id);
    if (!el) return;
    const esFin = id === "tirador-fin";
    el.addEventListener("pointerdown", e => {
      e.preventDefault(); e.stopPropagation();
      tiradores.arrastre = { fin: esFin, id: e.pointerId };
      el.setPointerCapture(e.pointerId);
      el.classList.add("arrastrando");
    });
    el.addEventListener("pointermove", e => {
      const ar = tiradores.arrastre;
      if (!ar || ar.id !== e.pointerId) return;
      const p = puntoEnTexto(e.clientX, e.clientY - 28);        // un poco más arriba que el dedo, para ver el texto
      if (!p) return;
      const d = destacados(), x = d[tiradores.activo];
      if (!x) return;
      const frases = frasesVisibles(), n = frases.indexOf(p.el);
      const na = frases.findIndex(f => f.dataset.clave === x.a.k), nb = frases.findIndex(f => f.dataset.clave === x.b.k);
      if (ar.fin) {
        const i = ajustarPalabra(p.el, p.i, false);
        if (n < na || (n === na && i <= x.a.i)) return;          // el fin no pasa al inicio
        x.b = { k: p.el.dataset.clave, i };
      } else {
        const i = ajustarPalabra(p.el, p.i, true);
        if (n > nb || (n === nb && i >= x.b.i)) return;
        x.a = { k: p.el.dataset.clave, i };
      }
      x.t = textoDeTramo(x.a, x.b);
      x.cap = capituloDe(frasesVisibles()[Math.min(na, n)] || p.el);
      guardarDestacados(d);
      pintarDestacados();
    });
    const soltar = e => {
      if (!tiradores.arrastre || tiradores.arrastre.id !== e.pointerId) return;
      tiradores.arrastre = null; el.classList.remove("arrastrando");
      const d = destacados(), x = d[tiradores.activo];
      if (x) { const f = frasesVisibles().find(f => f.dataset.clave === x.a.k); if (f) { x.cap = capituloDe(f); guardarDestacados(d); } }
    };
    el.addEventListener("pointerup", soltar);
    el.addEventListener("pointercancel", soltar);
    el.addEventListener("click", e => e.stopPropagation());
  });
}
function pintarColores() {
  const c = leerPref("colorDestacador", 0);
  document.querySelectorAll(".color-dest").forEach(b => b.classList.toggle("activo", +b.dataset.color === c));
}
// posición para ordenar: [capítulo o sección, frase o párrafo, letra]
function ordenDe(k, x) {
  const base = k.startsWith("r:") ? x.a.k : k;
  return [...base.split(":").slice(1).map(Number), k.startsWith("r:") ? x.a.i : 0];
}
function listaDestacados() {
  const d = destacados(), tipo = lectura.libre ? "e:" : "p:";
  return Object.entries(d)
    .filter(([k, x]) => (k.startsWith("r:") ? x.a.k : k).startsWith(tipo))
    .sort(([ka, a], [kb, b]) => { const x = ordenDe(ka, a), y = ordenDe(kb, b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; })
    .map(([k, v]) => ({ k, ...v }));
}
function pintarListaDestacados() {
  const caja = $("lista-destacados"), lista = listaDestacados();
  caja.innerHTML = "";
  $("texto-capitulo").textContent = `★ Mis frases destacadas (${lista.length})`;
  if (!lista.length) {
    caja.innerHTML = '<p class="sin-epub">Aún no destacas frases en este libro.<br>Toca el destacador y luego una frase.</p>';
    return;
  }
  const acciones = document.createElement("div");
  acciones.className = "acciones-destacados";
  acciones.innerHTML = '<button class="chip" id="btn-copiar-dest">Copiar</button><button class="chip" id="btn-compartir-dest">Compartir</button>';
  caja.appendChild(acciones);
  let capActual = null;
  for (const x of lista) {
    if (x.cap !== capActual) {
      capActual = x.cap;
      const h = document.createElement("h3"); h.textContent = x.cap; caja.appendChild(h);
    }
    const fila = document.createElement("p"); fila.className = "item-destacado";
    const t = document.createElement("span"); t.className = "frase destacada"; t.dataset.color = x.c; t.textContent = x.t;
    const ir = document.createElement("button"); ir.className = "ir-destacado"; ir.textContent = "Ir ▸";
    ir.onclick = () => irADestacado(x.k);
    fila.append(t, ir); caja.appendChild(fila);
  }
  $("btn-copiar-dest").onclick = () => copiarDestacados(false);
  $("btn-compartir-dest").onclick = () => copiarDestacados(true);
}
function textoDestacados() {
  const lista = listaDestacados();
  let out = `${estado.libro.titulo}\n`, cap = null;
  for (const x of lista) {
    if (x.cap !== cap) { cap = x.cap; out += `\n${cap}\n`; }
    out += `«${x.t}»\n`;
  }
  return out.trim();
}
async function copiarDestacados(compartir) {
  const texto = textoDestacados();
  if (compartir && navigator.share) {
    try { await navigator.share({ title: estado.libro.titulo, text: texto }); return; }
    catch (e) { if (e.name === "AbortError") return; }
  }
  try { await navigator.clipboard.writeText(texto); avisar(compartir ? "Copiadas. Pégalas donde quieras compartirlas." : "Frases copiadas."); }
  catch { avisar("No pude copiar las frases."); }
}
async function irADestacado(k) {
  salirModos();
  const x = destacados()[k];
  if (k.startsWith("r:") && x) k = x.a.k;
  const [tipo, a, b] = k.split(":");
  if (tipo === "p" && +a !== estado.pista) {
    await cargarPista(+a, estado.libro.pistas[+a].frases[+b].t, false);
  }
  const el = $("texto-contenido").querySelector(`[data-clave="${k}"]`);
  if (!el) return;
  if (tipo === "p") { audio.currentTime = estado.libro.pistas[+a].frases[+b].t; }
  lectura.manualHasta = Date.now() + 6000;
  el.scrollIntoView({ block: "center" });
  el.classList.add("parpadeo"); setTimeout(() => el.classList.remove("parpadeo"), 1600);
}
function pintarModos() {
  if (!$("btn-destacador")) return;
  const { destacar, estrella } = modoLectura;
  $("btn-destacador").classList.toggle("activo-dest", destacar);
  $("btn-destacador").setAttribute("aria-pressed", destacar);
  $("btn-estrella").classList.toggle("activo-estrella", estrella);
  $("btn-estrella").setAttribute("aria-pressed", estrella);
  $("fila-colores").hidden = !destacar;
  $("aviso-destacar").hidden = !destacar;
  $("panel-texto").classList.toggle("destacando", destacar);
  $("texto-contenido").hidden = estrella;
  $("lista-destacados").hidden = !estrella;
  if (destacar) pintarColores();
  pintarTiradores();
}
function salirModos() {
  const estaba = modoLectura.estrella;
  tiradores.activo = null;
  modoLectura.destacar = modoLectura.estrella = false;
  pintarModos();
  if (estaba && estado.libro) {
    $("lista-destacados").innerHTML = "";
    if (lectura.libre) { $("texto-capitulo").textContent = "Lectura libre (sin sincronía)"; $("panel-texto").scrollTop = estado.libro.lecturaScroll || 0; }
    else { lectura.pista = -1; seguirTexto(true); }
  }
}
function alternarDestacador() {
  const activar = !modoLectura.destacar;
  if (modoLectura.estrella) salirModos();
  modoLectura.destacar = activar;
  if (activar) { audio.pause(); $("fila-tamano").hidden = true; }
  pintarModos();
}
function alternarEstrella() {
  if (modoLectura.estrella) { salirModos(); return; }
  audio.pause();
  modoLectura.destacar = false;
  modoLectura.estrella = true;
  $("fila-tamano").hidden = true;
  pintarModos();
  pintarListaDestacados();
  $("panel-texto").scrollTop = 0;
}

// ---------- etapa 2: generar en Kaggle ----------
const generacion = { epub: null, epubInfo: null, voz: null, reloj: 0, libro: null, otraVoz: null };
const ESTADOS = {
  SUBIENDO: "Subiendo a Kaggle…", QUEUED: "En la fila de Kaggle", RUNNING: "Generando el audio",
  COMPLETE: "¡Terminado!", ERROR: "Kaggle tuvo un error", CANCEL_REQUESTED: "Cancelado", CANCEL_ACKNOWLEDGED: "Cancelado",
};
function textoEstadoCorto(g) {
  if (g.descargado) return "Descargando…";
  if (g.fase === "muestra") {
    if (g.muestraLista) return "Muestra de voz lista: escúchala";
    if (g.estado === "ERROR") return ESTADOS.ERROR;
    return "Creando una muestra de la voz…";
  }
  if (g.etapa === "primero" && g.estado !== "ERROR") return `Generando la primera parte (${g.pct || 20} %)…`;
  if (g.etapa === "resto") {
    if (g.estado === "QUEUED") return "Segunda parte: esperando una GPU en Kaggle";
    if (g.estado === "RUNNING") {
      const listos = g.capitulosListos && g.capitulosTotales ? ` · ${g.capitulosListos} de ${g.capitulosTotales} capítulos` : "";
      const quedan = g.horasRestantes != null ? ` · quedan ~${String(g.horasRestantes).replace(".", ",")} h` : "";
      return `Segunda parte: generándose${listos}${quedan}`;
    }
    if (g.estado === "COMPLETE" && !g.pausado) return "Segunda parte lista: bajándola…";
    if (g.estado === "ERROR") return "Segunda parte: Kaggle tuvo un error";
  }
  if (g.estado === "COMPLETE" && g.pausado) return "Se detuvo antes de terminar · toca para seguir";
  const base = ESTADOS[g.estado] || "Generando";
  if (g.estado === "RUNNING" && g.horasRestantes != null) return `${base} · quedan ~${String(g.horasRestantes).replace(".", ",")} h`;
  return base;
}
const idCorto = () => uid().replace(/[^a-f0-9]/gi, "").slice(0, 8).toLowerCase();

// --- cuenta ---
function abrirCuenta(mensaje = "") {
  const a = KAGGLE.ajustes();
  $("in-usuario").value = a.usuario || "";
  $("in-clave").value = a.clave || "";
  $("in-intermediario").value = a.intermediario || KAGGLE.intermediario();
  $("cuenta-mensaje").textContent = mensaje;
  $("dlg-cuenta").showModal();
}
async function guardarCuenta() {
  const a = {
    // si se pegó la línea completa de Kaggle (export KAGGLE_API_TOKEN=KGAT_…), tomar solo el token
    clave: (($("in-clave").value.match(/KGAT_[A-Za-z0-9_\-]+/) || [])[0] || $("in-clave").value).trim().replace(/^["']|["']$/g, ""),
    usuario: $("in-usuario").value.trim().replace(/^@/, "").replace(/^.*kaggle\.com\//, "").replace(/\/.*$/, ""),
    intermediario: $("in-intermediario").value.trim(),
  };
  if (!a.clave) { $("cuenta-mensaje").textContent = "Falta la clave."; return; }
  if (!a.usuario && !/^KGAT_/.test(a.clave)) { $("cuenta-mensaje").textContent = "Falta el usuario."; return; }
  if (!a.intermediario && !KAGGLE.intermediario()) { $("cuenta-mensaje").textContent = "Falta la dirección del intermediario (en Avanzado)."; return; }
  if (!a.intermediario) delete a.intermediario;
  const anterior = KAGGLE.ajustes();
  KAGGLE.guardarAjustes(a);
  $("cuenta-mensaje").textContent = "Probando con Kaggle…";
  try {
    const usuario = await KAGGLE.probar();
    const corregido = a.usuario && a.usuario !== usuario;
    $("in-usuario").value = usuario;
    $("cuenta-mensaje").textContent = `¡Listo! Conectada la cuenta de Kaggle «${usuario}».` +
      (corregido ? ` (Corregí el usuario: era «${usuario}», no «${a.usuario}».)` : "");
    setTimeout(() => $("dlg-cuenta").close(), corregido ? 3500 : 1200);
  } catch (e) {
    KAGGLE.guardarAjustes(anterior.usuario ? anterior : a);
    $("cuenta-mensaje").textContent = "No funcionó: " + e.message;
  }
}
async function leerKaggleJson(archivo) {
  try {
    const d = JSON.parse(await archivo.text());
    if (d.username) $("in-usuario").value = d.username;
    if (d.key) $("in-clave").value = d.key;
    $("cuenta-mensaje").textContent = "Datos cargados. Toca «Probar y guardar».";
  } catch { $("cuenta-mensaje").textContent = "Ese archivo no parece un kaggle.json."; }
}

// --- formulario de nuevo libro ---
async function abrirGenerar(otraVoz = null) {
  if (!KAGGLE.listo()) return abrirCuenta("Primero conecta tu cuenta de Kaggle (solo una vez).");
  generacion.otraVoz = otraVoz;          // libro al que se le prueba otra voz (sin volver a elegir EPUB)
  $("bloque-libro-gen").hidden = !!otraVoz;
  $("btn-gen-directo").hidden = !!otraVoz;
  $("gen-titulo-dlg").textContent = otraVoz ? "Probar otra voz" : "Crear audiolibro";
  $("btn-gen-iniciar").textContent = otraVoz ? "Crear nueva muestra" : "Escuchar una muestra";
  $("btn-gen-directo").disabled = false;
  if (!otraVoz) generacion.epub = null;
  generacion.voz = null;
  $("gen-epub-info").textContent = "";
  $("in-titulo-gen").value = "";
  $("gen-voz-info").textContent = "";
  $("gen-mensaje").textContent = ""; $("gen-mensaje").classList.remove("error");
  $("btn-gen-iniciar").disabled = false;
  if (otraVoz && otraVoz.generando.config.descripcion) $("in-descripcion").value = otraVoz.generando.config.descripcion;
  const guardada = leerPref("vozGuardadaNombre", "");
  $("voz-guardada").closest("label").hidden = !guardada;
  $("txt-voz-guardada").textContent = guardada ? `Mi voz guardada (${guardada})` : "";
  (guardada ? $("voz-guardada") : $("voz-describir")).checked = true;
  pintarOpcionesVoz();
  $("dlg-generar").showModal();
}
function pintarOpcionesVoz() {
  const v = document.querySelector('input[name="voz"]:checked')?.value;
  $("bloque-voz-archivo").hidden = v !== "archivo";
  $("bloque-voz-describir").hidden = v !== "describir";
}
async function elegirEpubGen(archivo) {
  if (!archivo) return;
  generacion.epub = archivo;
  try {
    const d = leerEpub(new Uint8Array(await archivo.arrayBuffer()));
    generacion.epubInfo = d;
    const car = d.capitulos.reduce((n, c) => n + c.reduce((m, b) => m + b.t.length, 0), 0);
    const horas = car / 15 * 1.5 / 3600;      // ~15 caracteres por segundo de audio, ~1,5 s de GPU por segundo
    generacion.horasLibro = horas;
    pintarModo();
    $("gen-epub-info").textContent = `${archivo.name} · ${car.toLocaleString("es")} caracteres · ~${Math.max(1, Math.round(horas))} h de GPU`;
    if (!$("in-titulo-gen").value) $("in-titulo-gen").value = d.titulo || archivo.name.replace(/\.epub$/i, "");
  } catch (e) {
    $("gen-epub-info").textContent = `${archivo.name} (no pude leer el contenido: ${e.message})`;
  }
}
function nombreSeguro(n) {
  const ext = (n.match(/\.[a-z0-9]+$/i) || [""])[0].toLowerCase();
  const base = n.slice(0, n.length - ext.length).normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "_").slice(0, 50) || "archivo";
  return base + ext;
}

// Lee la voz elegida en el diálogo. Devuelve { voz: File|null, descripcion } o lanza un error.
async function leerVozElegida() {
  const tipoVoz = document.querySelector('input[name="voz"]:checked')?.value;
  if (tipoVoz === "guardada") {
    const blob = await BD.archivo("voz-guardada");
    if (!blob) throw new Error("No encontré la voz guardada. Elige un audio.");
    return { voz: new File([blob], leerPref("vozGuardadaNombre", "voz.wav"), { type: blob.type }), descripcion: "" };
  }
  if (tipoVoz === "archivo") {
    if (!generacion.voz) throw new Error("Elige el audio de la voz.");
    if ($("chk-recordar-voz").checked) {
      await BD.guardarArchivo("voz-guardada", generacion.voz);
      guardarPref("vozGuardadaNombre", nombreSeguro(generacion.voz.name));
    }
    return { voz: generacion.voz, descripcion: "" };
  }
  const descripcion = $("in-descripcion").value.trim();
  if (!descripcion) throw new Error("Escribe cómo quieres que suene la voz.");
  return { voz: null, descripcion };
}

// "Todo de una vez" o "una parte ahora y el resto después", con cuánto tardaría cada corrida.
const PASOS_PCT = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 100];   // el último paso es "Todo"
function modoElegido() {
  const pct = PASOS_PCT[Math.round(+$("in-pct").value)] ?? 100;
  return pct >= 100 ? { modo: "", pct: 100 } : { modo: "parte", pct };
}
function pintarModo() {
  const { modo, pct } = modoElegido();
  $("pct-valor").textContent = modo ? `${pct} %` : "Todo";
  $("pct-sub").textContent = modo ? "ahora, y el resto después" : "de una vez";
  $("aviso-parte").hidden = !modo;
  const h = generacion.horasLibro;
  const txt = x => { const m = Math.round(x * 60 / 15) * 15; return m < 60 ? `${Math.max(15, m)} min` : `${String(Math.round(x * 2) / 2).replace(".", ",")} h`; };
  const preparar = 0.25;   // instalar y cargar la voz, en cada corrida
  $("estimacion-parte").innerHTML = !h ? ""
    : modo ? `Primera parte: unas <b>${txt(h * pct / 100 + preparar)}</b>. El resto: unas <b>${txt(h * (100 - pct) / 100 + preparar)}</b>. Es aproximado: los capítulos no se cortan por la mitad.`
    : `Tardaría unas <b>${txt(h + preparar)}</b>. Sigue solo aunque cierres la app.`;
}

// conMuestra=true: primero una muestra corta de la voz; el libro completo se lanza al confirmarla.
async function iniciarGeneracion(conMuestra = true) {
  const msg = t => { $("gen-mensaje").textContent = t; };
  const botones = on => { $("btn-gen-iniciar").disabled = !on; $("btn-gen-directo").disabled = !on; };
  const fallo = t => { $("gen-mensaje").textContent = t; $("gen-mensaje").classList.add("error"); botones(true); };
  $("gen-mensaje").classList.remove("error");
  if (generacion.otraVoz) return nuevaMuestra(generacion.otraVoz, msg, fallo, botones);
  if (!generacion.epub) return fallo("Elige primero el EPUB.");
  const titulo = $("in-titulo-gen").value.trim() || generacion.epub.name.replace(/\.epub$/i, "");
  let voz, descripcion;
  try { ({ voz, descripcion } = await leerVozElegida()); } catch (e) { return fallo(e.message); }

  botones(false);
  const id = idCorto();
  let slugKernel = conMuestra ? `audiolibro-${id}-voz1` : `audiolibro-${id}`;
  let slugDataset = `audiolibro-${id}-entrada`;
  let usuario = KAGGLE.ajustes().usuario;
  const nombreEpub = nombreSeguro(generacion.epub.name);
  const archivos = [[nombreEpub, generacion.epub]];
  const nombreVoz = voz ? nombreSeguro(voz.name) : "";
  if (voz) archivos.push([nombreVoz, voz]);
  const config = { epub: nombreEpub, voz: nombreVoz, descripcion };
  const { modo, pct } = modoElegido();
  const primero = modo === "parte" && !conMuestra;

  try {
    ({ usuario, slug: slugDataset } = await KAGGLE.crearDataset(slugDataset, `Audiolibro ${id} entrada`, archivos, msg));
    msg(conMuestra ? "Pidiendo la muestra de voz a Kaggle…" : "Lanzando el notebook con GPU…");
    const texto = await KAGGLE.prepararNotebook(config, conMuestra, primero ? `hasta:${pct}` : "");
    ({ slug: slugKernel } = await KAGGLE.lanzarNotebook(slugKernel, conMuestra ? `Audiolibro ${id} voz1` : `Audiolibro ${id}`, texto,
      { datasets: [`${usuario}/${slugDataset}`] }));
  } catch (e) {
    return fallo("No se pudo: " + e.message);
  }

  const libro = {
    id: uid(), titulo, creado: Date.now(), pistas: [], pos: { pista: 0, tiempo: 0 }, terminado: false,
    generando: {
      fase: conMuestra ? "muestra" : "libro", idKaggle: id, nMuestra: conMuestra ? 1 : 0,
      modo, pct, etapa: primero ? "primero" : "", importados: [],
      kernel: slugKernel, partes: conMuestra ? [] : [slugKernel],
      dataset: slugDataset, datasets: [slugDataset], usuario, estado: "QUEUED",
      inicio: Date.now(), config,
    },
  };
  await BD.guardarLibro(libro);
  msg(conMuestra ? "¡Listo! Kaggle está creando la muestra de la voz." : "¡Listo! Kaggle empezó a generar tu libro.");
  setTimeout(() => { $("dlg-generar").close(); abrirGenerando(libro); }, 900);
}

// Otra muestra para el mismo libro: el EPUB ya está en Kaggle; solo se sube la voz nueva (si es un audio).
async function nuevaMuestra(l, msg, fallo, botones) {
  const g = l.generando;
  let voz, descripcion;
  try { ({ voz, descripcion } = await leerVozElegida()); } catch (e) { return fallo(e.message); }
  botones(false);
  const n = (g.nMuestra || 1) + 1;
  let slugKernel = `audiolibro-${g.idKaggle}-voz${n}`;
  const config = { ...g.config, voz: "", descripcion };
  const datasets = [...(g.datasets || [g.dataset])];
  try {
    if (voz) {
      // nombre único para no confundirla con la voz de la muestra anterior
      config.voz = `voz${n}_${nombreSeguro(voz.name)}`;
      const r = await KAGGLE.crearDataset(`audiolibro-${g.idKaggle}-voz${n}`, `Audiolibro ${g.idKaggle} voz ${n}`, [[config.voz, voz]], msg);
      datasets.push(r.slug);
    }
    msg("Pidiendo la nueva muestra a Kaggle…");
    const texto = await KAGGLE.prepararNotebook(config, true);
    ({ slug: slugKernel } = await KAGGLE.lanzarNotebook(slugKernel, `Audiolibro ${g.idKaggle} voz${n}`, texto,
      { datasets: datasets.map(d => `${g.usuario}/${d}`) }));
  } catch (e) {
    return fallo("No se pudo: " + e.message);
  }
  try { await BD.borrarArchivo("muestra-" + l.id); } catch {}
  Object.assign(g, { fase: "muestra", nMuestra: n, kernel: slugKernel, datasets, config, estado: "QUEUED",
                     muestraLista: false, error: "", estimacionHoras: null });
  await BD.guardarLibro(l);
  msg("¡Listo! Kaggle está creando la nueva muestra.");
  setTimeout(() => { $("dlg-generar").close(); abrirGenerando(l); }, 900);
}

// La persona escuchó la muestra y le gustó: el libro completo usa esa misma voz
// (la salida de la muestra entra al notebook, que reutiliza su voz_referencia.wav).
async function confirmarMuestra() {
  const l = generacion.libro, g = l.generando;
  let slug = `audiolibro-${g.idKaggle}`;
  $("btn-muestra-ok").disabled = true;
  pintarGenerando("Lanzando el libro completo…");
  try {
    const texto = await KAGGLE.prepararNotebook(g.config, false, g.modo === "parte" ? `hasta:${g.pct}` : "");
    ({ slug } = await KAGGLE.lanzarNotebook(slug, `Audiolibro ${g.idKaggle}`, texto, {
      datasets: (g.datasets || [g.dataset]).map(d => `${g.usuario}/${d}`),
      kernels: [`${g.usuario}/${g.kernel}`],
    }));
  } catch (e) {
    $("btn-muestra-ok").disabled = false;
    return pintarGenerando("No se pudo lanzar el libro: " + e.message);
  }
  try { await BD.borrarArchivo("muestra-" + l.id); } catch {}
  Object.assign(g, { fase: "libro", kernel: slug, partes: [slug], estado: "QUEUED", muestraLista: false, inicio: Date.now(),
                     etapa: g.modo === "parte" ? "primero" : "", importados: [] });
  $("gen-enlace").href = `https://www.kaggle.com/code/${g.usuario}/${slug}`;
  $("btn-muestra-ok").disabled = false;
  await BD.guardarLibro(l);
  pintarGenerando();
}

// --- seguimiento ---
async function abrirGenerando(l) {
  l = enUso(l);
  generacion.libro = l;
  $("vista-biblioteca").hidden = true;
  $("vista-reproductor").hidden = true;
  $("vista-generando").hidden = false;
  $("btn-volver").hidden = false;
  $("btn-texto").hidden = true;
  $("titulo-barra").textContent = l.titulo;
  $("gen-enlace").href = `https://www.kaggle.com/code/${l.generando.usuario}/${l.generando.kernel}`;
  pintarGenerando();
  await actualizarGenerando();
  clearInterval(generacion.reloj);
  generacion.reloj = setInterval(() => { if (!$("vista-generando").hidden && !document.hidden) actualizarGenerando(); }, 120000);
}

function pintarGenerando(detalle) {
  const g = generacion.libro.generando;
  const icono = $("gen-icono");
  icono.className = "gen-icono" + (g.estado === "COMPLETE" ? " listo" : g.estado === "ERROR" ? " error" : " girando");
  const muestra = g.fase === "muestra";
  $("gen-estado").textContent = muestra
    ? (g.muestraLista ? "Escucha la muestra" : g.estado === "ERROR" ? ESTADOS.ERROR : g.estado === "QUEUED" ? "En la fila de Kaggle" : "Creando una muestra de la voz")
    : g.pausado ? (g.cortado ? "Se detuvo antes de terminar" : "Kaggle hizo una pausa") : (ESTADOS[g.estado] || "Generando");
  if (muestra && g.muestraLista) icono.className = "gen-icono listo";
  let d = detalle || "";
  if (!d && muestra) {
    if (g.muestraLista) d = "Así suena la voz con tu libro. Si te gusta, genera el libro completo" +
      (g.estimacionHoras ? ` (unas ${Math.max(1, Math.round(g.estimacionHoras))} h en Kaggle).` : ".") + " Si no, prueba otra voz.";
    else if (g.estado === "QUEUED") d = "Esperando una GPU libre. Suele tardar unos minutos.";
    else if (g.estado === "ERROR") d = g.error || "Abre Kaggle para ver el detalle.";
    else d = "Kaggle instala y carga la voz, y lee unos segundos del libro. Suele tardar 10 a 20 minutos.";
  }
  if (!d) {
    if (g.estado === "QUEUED") d = "Esperando una GPU libre. Suele tardar unos minutos.";
    else if (g.estado === "RUNNING") {
      const partes = [];
      if (g.capitulosListos != null && g.capitulosTotales) partes.push(`${g.capitulosListos} de ${g.capitulosTotales} capítulos listos`);
      if (g.horasRestantes != null) {
        const fin = new Date(Date.now() + g.horasRestantes * 3600000);
        partes.push(`quedan ~${String(g.horasRestantes).replace(".", ",")} h (cerca de las ${fin.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })})`);
      }
      d = partes.join(" · ") || "Instalando y cargando la voz (los primeros 10–15 minutos).";
    } else if (g.estado === "COMPLETE") d = g.pausado
      ? (g.cortado
        ? `Kaggle cortó antes de terminar, casi siempre porque se acabaron las horas de GPU de la semana. ${generacion.libro.pistas.length ? `Ya tienes ${generacion.libro.pistas.length === 1 ? "1 capítulo" : generacion.libro.pistas.length + " capítulos"} para escuchar. ` : ""}Toca Continuar cuando tengas horas de nuevo.`
        : "Kaggle llega a un máximo de horas por corrida. Toca Continuar y sigue desde donde quedó.")
      : "Toca Descargar para guardarlo en tu teléfono.";
    else if (g.estado === "ERROR") d = g.error || "Abre Kaggle para ver el detalle.";
  }
  if (!detalle && !muestra && generacion.libro.pistas.length && g.estado !== "COMPLETE")
    d = `Ya puedes escuchar ${generacion.libro.pistas.length === 1 ? "el primer capítulo" : generacion.libro.pistas.length + " capítulos"} mientras tanto. ` + d;
  if (!detalle && g.etapa === "resto" && g.estado !== "COMPLETE")
    d = "Segunda parte (el resto del libro). " + d;
  else if (!detalle && g.etapa === "primero" && (g.estado === "QUEUED" || g.estado === "RUNNING"))
    d = `Primero se genera el ${g.pct || 20} % del libro, para que empieces a escuchar antes. El resto empieza cuando entres a la app después de eso. ` + d;
  $("gen-detalle").textContent = d;
  const pct = g.estado === "COMPLETE" && !g.pausado ? 100
    : (g.capitulosListos && g.capitulosTotales ? Math.round(g.capitulosListos / g.capitulosTotales * 100) : (g.estado === "RUNNING" ? 3 : 0));
  $("gen-barra").style.width = pct + "%";
  $("btn-gen-descargar").hidden = muestra || !(g.estado === "COMPLETE" && !g.pausado);
  $("btn-gen-continuar").hidden = muestra || !(g.estado === "COMPLETE" && g.pausado);
  $("btn-gen-actualizar").hidden = muestra ? !!g.muestraLista : g.estado === "COMPLETE";
  $("gen-muestra").hidden = !(muestra && (g.muestraLista || g.estado === "ERROR"));
  $("btn-gen-escuchar").hidden = !generacion.libro.pistas.length;
  if (generacion.libro.pistas.length) $("btn-gen-actualizar").className = "boton-secundario";
  else $("btn-gen-actualizar").className = "boton-principal";
  $("audio-muestra").hidden = !g.muestraLista;
  $("btn-muestra-ok").hidden = !g.muestraLista;
  if (muestra) $("gen-barra").style.width = g.muestraLista ? "100%" : g.estado === "RUNNING" ? "30%" : "5%";
}
async function pintarAudioMuestra() {
  const a = $("audio-muestra");
  if (a.dataset.libro === generacion.libro.id && a.src) return;
  const blob = await BD.archivo("muestra-" + generacion.libro.id);
  if (a.src) URL.revokeObjectURL(a.src);
  a.removeAttribute("src");
  if (blob) { a.src = URL.createObjectURL(blob); a.dataset.libro = generacion.libro.id; }
}

// Muestras lanzadas antes del arreglo: Kaggle las guardó como "…-voz-1" y la app las buscaba como "…-voz1".
async function estadoKernel(g) {
  try { return await KAGGLE.estado(g.kernel); }
  catch (e) {
    const alt = g.kernel.replace(/-voz(\d+)$/, "-voz-$1");
    if (alt === g.kernel || !/403|404/.test(e.message)) throw e;
    const st = await KAGGLE.estado(alt);
    g.kernel = alt;
    $("gen-enlace").href = `https://www.kaggle.com/code/${g.usuario}/${alt}`;
    return st;
  }
}

async function actualizarGenerando() {
  const l = generacion.libro, g = l.generando;
  if (g.fase === "muestra" && g.muestraLista) { pintarGenerando(); return pintarAudioMuestra(); }
  $("btn-gen-actualizar").disabled = true;
  try {
    const st = await estadoKernel(g);
    g.estado = st.estado; g.error = st.error;
    if (g.estado === "RUNNING") {
      const av = await KAGGLE.avance(g.kernel);
      if (av) Object.assign(g, {
        horasRestantes: av.horasRestantes ?? g.horasRestantes,
        capitulosListos: av.capitulosListos || g.capitulosListos || 0,
        capitulosTotales: av.capitulosTotales || g.capitulosTotales,
      });
    } else if (g.estado === "COMPLETE" && g.fase === "muestra") {
      const salida = await KAGGLE.archivosDeSalida(g.kernel);
      const f = salida.archivos.find(x => /(^|\/)prueba\.wav$/i.test(x.fileName));
      if (!f) { g.estado = "ERROR"; g.error = "Kaggle terminó pero no dejó la muestra. Prueba otra vez."; }
      else {
        pintarGenerando("Descargando la muestra…");
        const blob = await KAGGLE.descargar(f.url);
        await BD.guardarArchivo("muestra-" + l.id, new Blob([blob], { type: "audio/wav" }));
        g.muestraLista = true;
        g.estimacionHoras = salida.registro && salida.registro.estimacionHoras;
        $("audio-muestra").dataset.libro = "";
      }
    } else if (g.estado === "COMPLETE") {
      const salida = await KAGGLE.archivosDeSalida(g.kernel);
      g.pausado = !!(salida.registro && salida.registro.pausado);
      g.cortado = !!(salida.registro && salida.registro.cortado);
      if (salida.registro && salida.registro.capitulosTotales) g.capitulosTotales = salida.registro.capitulosTotales;
      g.archivos = salida.archivos.map(f => ({ nombre: f.fileName, url: f.url }));
      if (g.pausado) await importarSalida(l, t => pintarGenerando(t));   // lo que alcanzó a hacer ya se puede escuchar
      if (g.etapa === "primero" && !g.pausado) await procesarPrimero(l, t => pintarGenerando(t));
      else if (g.etapa === "resto" && !g.pausado) { await BD.guardarLibro(l); return descargarGenerado(); }
    }
    await BD.guardarLibro(l);
    pintarGenerando();
    if (g.muestraLista) await pintarAudioMuestra();
  } catch (e) {
    pintarGenerando("No pude consultar a Kaggle: " + e.message);
  } finally {
    $("btn-gen-actualizar").disabled = false;
  }
}

// Lanza la siguiente corrida del mismo libro: los capítulos ya hechos llegan como entrada y se saltan.
async function lanzarSiguienteParte(l) {
  const g = l.generando;
  const n = g.partes.length + 1;
  const texto = await KAGGLE.prepararNotebook(g.config || { epub: "", voz: "", descripcion: "" }, false, "");
  const { slug } = await KAGGLE.lanzarNotebook(`${g.partes[0]}-p${n}`, `Audiolibro ${g.partes[0].slice(11)} p${n}`, texto,
    { datasets: (g.datasets || [g.dataset]).map(d => `${g.usuario}/${d}`), kernels: [`${g.usuario}/${g.kernel}`] });
  g.partes.push(slug); g.kernel = slug; g.estado = "QUEUED"; g.pausado = false; g.cortado = false; g.archivos = null;
  if (g.etapa === "primero") g.etapa = "resto";
  await BD.guardarLibro(l);
}

async function continuarGeneracion() {
  const l = generacion.libro, g = l.generando;
  pintarGenerando("Lanzando la siguiente parte…");
  try {
    await lanzarSiguienteParte(l);
    $("gen-enlace").href = `https://www.kaggle.com/code/${g.usuario}/${g.kernel}`;
    pintarGenerando();
  } catch (e) { pintarGenerando("No se pudo continuar: " + e.message); }
}

// Baja de la salida de Kaggle los capítulos que este libro todavía no tiene y los agrega al final.
async function importarSalida(l, avisarAvance) {
  const g = l.generando;
  g.importados = g.importados || [];
  const nuevos = (g.archivos || []).filter(f => /\.(mp3|json)$/i.test(f.nombre) && !/(^|\/)_partes\//.test(f.nombre)
    && !g.importados.includes(f.nombre.replace(/^.*\//, "")));
  if (!nuevos.some(f => /\.mp3$/i.test(f.nombre))) return 0;
  const archivos = [];
  for (let i = 0; i < nuevos.length; i++) {
    avisarAvance(`Descargando ${i + 1} de ${nuevos.length}…`);
    const blob = await KAGGLE.descargar(nuevos[i].url);
    archivos.push(new File([blob], nuevos[i].nombre.replace(/^.*\//, ""), { type: /\.json$/i.test(nuevos[i].nombre) ? "application/json" : "audio/mpeg" }));
  }
  const pistas = await expandirArchivos(archivos);
  for (let i = 0; i < pistas.length; i++) {
    avisarAvance(`Guardando capítulo ${i + 1} de ${pistas.length}…`);
    const idArchivo = uid();
    await BD.guardarArchivo(idArchivo, pistas[i].blob);
    l.pistas.push({ nombre: nombreBonito(pistas[i].nombre), idArchivo, duracion: await duracionDe(pistas[i].blob), frases: pistas[i].frases || null });
  }
  g.importados.push(...archivos.map(f => f.name));
  await BD.guardarLibro(l);
  pedirAlmacenamientoPersistente();
  return pistas.length;
}

// Terminó la corrida corta del primer capítulo: se agrega a la biblioteca y se lanza el resto.
const procesando = new Set();
async function procesarPrimero(l, avisarAvance = () => {}) {
  if (procesando.has(l.id)) return;
  procesando.add(l.id);
  try {
    const g = l.generando;
    if (!g.archivos) {
      const salida = await KAGGLE.archivosDeSalida(g.kernel);
      g.archivos = salida.archivos.map(f => ({ nombre: f.fileName, url: f.url }));
    }
    const n = await importarSalida(l, avisarAvance);
    avisarAvance("Lanzando el resto del libro…");
    await lanzarSiguienteParte(l);
    g.etapa = "resto";
    await BD.guardarLibro(l);
    if (n) avisar(`Ya puedes empezar a escuchar “${l.titulo}” 🎧 El resto se sigue generando.`, 6000);
  } finally { procesando.delete(l.id); }
}

// Con la app abierta, revisa cada pocos minutos los libros que esperan su primer capítulo.
async function revisarPrimeros() {
  if (!KAGGLE.listo() || document.hidden) return;
  let libros = [];
  try { libros = await BD.libros(); } catch { return; }
  for (const l0 of libros) {
    const l = enUso(l0), g = l.generando;
    if (!g || g.fase === "muestra" || !(g.etapa === "primero" || g.etapa === "resto") || procesando.has(l.id)) continue;
    try {
      const st = await KAGGLE.estado(g.kernel);
      if (st.estado !== g.estado) { g.estado = st.estado; g.error = st.error; await BD.guardarLibro(l); }
      if (st.estado === "RUNNING" && g.etapa === "resto") {
        const av = await KAGGLE.avance(g.kernel).catch(() => null);
        if (av) Object.assign(g, { horasRestantes: av.horasRestantes ?? g.horasRestantes,
          capitulosListos: av.capitulosListos || g.capitulosListos || 0, capitulosTotales: av.capitulosTotales || g.capitulosTotales });
        await BD.guardarLibro(l);
      }
      if (st.estado === "COMPLETE" && g.etapa === "resto") await bajarResto(l);
      else if (st.estado === "COMPLETE") await procesarPrimero(l);
      if (!$("vista-biblioteca").hidden) mostrarBiblioteca();
      else if (estado.libro === l && !$("vista-reproductor").hidden) { if (l.generando) pintarAvisoGenerando(); else abrirLibro(l.id); }
      else if (generacion.libro === l && !$("vista-generando").hidden) { if (l.generando) pintarGenerando(); else abrirLibro(l.id); }
    } catch {}
  }
}

// Terminó la segunda parte con la app abierta: se baja sola y el libro queda completo.
async function bajarResto(l) {
  if (procesando.has(l.id)) return;
  procesando.add(l.id);
  try {
    const g = l.generando;
    const salida = await KAGGLE.archivosDeSalida(g.kernel);
    g.pausado = !!(salida.registro && salida.registro.pausado);
    g.cortado = !!(salida.registro && salida.registro.cortado);
    g.archivos = salida.archivos.map(f => ({ nombre: f.fileName, url: f.url }));
    if (salida.registro && salida.registro.capitulosTotales) g.capitulosTotales = salida.registro.capitulosTotales;
    if (!g.pausado) {
      await importarSalida(l, () => {});
      if (faltanCapitulos(l, g)) g.pausado = g.cortado = true;
    }
    if (g.pausado) {
      await importarSalida(l, () => {});
      await BD.guardarLibro(l);
      avisar(`La segunda parte de “${l.titulo}” se detuvo antes de terminar. Ábrela para seguir.`, 6000);
      return;
    }
    l.generado = { ...g, archivos: undefined };
    delete l.generando;
    await BD.guardarLibro(l);
    avisar(`Llegó la segunda parte: “${l.titulo}” está completo 🎧`, 6000);
  } finally { procesando.delete(l.id); }
}

async function descargarGenerado() {
  const l = generacion.libro, g = l && l.generando;
  if (!g || descargando.has(l.id)) return;      // ya se está bajando (p. ej. sola, o doble toque)
  descargando.add(l.id);
  try { await descargarGeneradoSinRepetir(l, g); } finally { descargando.delete(l.id); }
}
const descargando = new Set();
async function descargarGeneradoSinRepetir(l, g) {
  if (!(g.archivos || []).some(f => /\.mp3$/i.test(f.nombre)) && !l.pistas.length) { pintarGenerando("No encontré capítulos en la salida de Kaggle."); return; }
  $("btn-gen-descargar").disabled = true;
  try {
    await importarSalida(l, t => pintarGenerando(t));
    if (!l.pistas.length) throw new Error("no llegó ningún capítulo");
    if (faltanCapitulos(l, g)) {             // Kaggle cortó sin avisar: queda para Continuar
      g.pausado = g.cortado = true;
      await BD.guardarLibro(l);
      return pintarGenerando();
    }
    l.generado = { ...g, archivos: undefined };
    delete l.generando;
    await BD.guardarLibro(l);
    avisar(`“${l.titulo}” está listo para escuchar 🎧`);
    abrirLibro(l.id);
  } catch (e) {
    pintarGenerando("Falló la descarga: " + e.message + ". Toca Descargar para reintentar.");
  } finally {
    $("btn-gen-descargar").disabled = false;
  }
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
$("btn-volver").onclick = () => { guardarPosicion(true); guardarPref("ultimoLibro", null); mostrarBiblioteca(); };
$("btn-texto").onclick = () => ($("panel-texto").hidden ? abrirTexto() : (guardarPref("textoAbierto", false), cerrarTexto()));
if ($("btn-destacador")) $("btn-destacador").onclick = alternarDestacador;   // la página vieja no los tiene: que no impida mostrar los libros
if ($("btn-estrella")) $("btn-estrella").onclick = alternarEstrella;
document.querySelectorAll(".color-dest").forEach(b => { b.onclick = () => {
  guardarPref("colorDestacador", +b.dataset.color); pintarColores();
  const d = destacados(), x = d[tiradores.activo];                // si hay uno recién hecho, cambia su color
  if (x) { x.c = +b.dataset.color; guardarDestacados(d); pintarDestacados(); }
}; });
iniciarTiradores();
$("entrada-epub").onchange = e => { const f = e.target.files[0]; e.target.value = ""; agregarEpub(f); };
// lectura libre: recordar hasta dónde bajó la persona
let guardadoScroll;
$("panel-texto").addEventListener("scroll", () => {
  if (!lectura.libre || !estado.libro?.epubId) return;
  if (!$("texto-controles").hidden) pintarNombreCapLectura();
  clearTimeout(guardadoScroll);
  guardadoScroll = setTimeout(() => { estado.libro.lecturaScroll = $("panel-texto").scrollTop; BD.guardarLibro(estado.libro).catch(() => {}); }, 600);
}, { passive: true });
$("btn-play-texto").onclick = () => { if (modoLectura.destacar || modoLectura.estrella) salirModos(); alternar(); };
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
$("btn-generar").onclick = () => abrirGenerar();
$("btn-cuenta").onclick = () => abrirCuenta();
$("btn-cuenta-guardar").onclick = guardarCuenta;
$("btn-kaggle-json").onclick = () => $("entrada-kaggle-json").click();
$("entrada-kaggle-json").onchange = e => { const f = e.target.files[0]; e.target.value = ""; if (f) leerKaggleJson(f); };
$("btn-elegir-epub-gen").onclick = () => $("entrada-epub-gen").click();
$("entrada-epub-gen").onchange = e => { const f = e.target.files[0]; e.target.value = ""; elegirEpubGen(f); };
$("btn-elegir-voz").onclick = () => $("entrada-voz").click();
$("entrada-voz").onchange = e => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  generacion.voz = f;
  $("gen-voz-info").textContent = `${f.name} · ${Math.round(f.size / 1024)} KB`;
};
document.querySelectorAll('input[name="voz"]').forEach(r => r.onchange = pintarOpcionesVoz);
$("in-pct").oninput = pintarModo;
pintarModo();
$("btn-gen-iniciar").onclick = () => iniciarGeneracion(true);
$("btn-gen-directo").onclick = () => iniciarGeneracion(false);
$("btn-muestra-ok").onclick = confirmarMuestra;
$("btn-muestra-otra").onclick = () => abrirGenerar(generacion.libro);
$("btn-gen-actualizar").onclick = actualizarGenerando;
$("btn-gen-descargar").onclick = descargarGenerado;
$("btn-gen-continuar").onclick = continuarGeneracion;
$("btn-gen-borrar").onclick = async () => {
  const dlg = $("dlg-confirmar");
  dlg.showModal();
  dlg.addEventListener("close", async () => {
    if (dlg.returnValue !== "ok") return;
    try { await BD.borrarArchivo("muestra-" + generacion.libro.id); } catch {}
    await BD.borrarLibro(generacion.libro);
    mostrarBiblioteca();
  }, { once: true });
};
$("btn-agregar").onclick = () => $("entrada-archivos").click();
$("btn-compartir").onclick = () => abrirCompartir();
$("btn-gen-escuchar").onclick = () => generacion.libro && abrirLibro(generacion.libro.id);
$("aviso-generando").onclick = () => {
  const l = estado.libro;
  if (!l) return;
  if (!l.generando && l.generado && l.generado.aMedias) return seguirLibroAMedias(l);
  abrirGenerando(l);
};
setInterval(revisarPrimeros, 180000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) revisarPrimeros(); });
$("btn-compartir-guardar").onclick = guardarCompartido;
$("dlg-compartir").addEventListener("close", () => {
  compartir.archivo = null; compartir.libro = null; $("btn-compartir-guardar").textContent = "Guardar en el teléfono";
});
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
if (TEMA) {                               // otra piel de la misma app (ej. choro/index.html)
  $("logo-tema").hidden = false;
  $("logo-tema").querySelector("img").src = TEMA.logo;
  $("logo-tema").querySelector("img").alt = TEMA.nombre;
  if (TEMA.logoOscuro) $("logo-tema-oscuro").srcset = TEMA.logoOscuro;
}
pintarVelocidad();
pintarDormir();
(async function iniciar() {
  pedirAlmacenamientoPersistente();
  let libros = [];
  try { libros = await BD.libros(); } catch {}
  if (libros.length) guardarPref("habiaLibros", true);
  else if (leerPref("habiaLibros", false)) {
    avisar("El teléfono borró los libros guardados. Abre la app siempre desde el ícono instalado (no desde WhatsApp ni una pestaña de incógnito).", 15000);
    guardarPref("habiaLibros", false);
  }
  const ultimo = leerPref("ultimoLibro", null);
  const l = ultimo && libros.find(x => x.id === ultimo && (!x.generando || x.pistas.length));
  if (!l) return mostrarBiblioteca();
  await abrirLibro(l.id);
  if (leerPref("textoAbierto", false)) abrirTexto();
})().finally(() => setTimeout(revisarPrimeros, 1500));
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

window.addEventListener("resize", () => { if (estado.libro && !$("vista-reproductor").hidden) actualizarTiempo(); });
