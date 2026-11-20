// Comentarios del club: solo se carga en la versión Choro y Tinta (choro/index.html lo agrega).
// Las amigas comentan el libro que están leyendo; los comentarios se guardan en el
// intermediario de Cloudflare (espacio KV "COMENTARIOS") y los ve todo el club.
// Un libro se reconoce por su título, así que las que tienen el mismo libro ven los mismos comentarios.
(() => {
  const el = id => document.getElementById(id);
  const leer = (k, def) => { try { const v = localStorage.getItem("club:" + k); return v == null ? def : JSON.parse(v); } catch { return def; } };
  const guardar = (k, v) => { try { localStorage.setItem("club:" + k, JSON.stringify(v)); } catch {} };

  // Secreto de este teléfono: permite borrar solo los comentarios propios
  let secreto = leer("secreto", "");
  if (!secreto) {
    secreto = [...crypto.getRandomValues(new Uint8Array(18))].map(b => b.toString(16).padStart(2, "0")).join("");
    guardar("secreto", secreto);
  }
  const mios = new Set(leer("mios", []));

  const base = () => (typeof KAGGLE !== "undefined" ? KAGGLE.intermediario() : "https://cold-surf-87d1.tcanales.workers.dev");
  const libroAbierto = () => (typeof estado !== "undefined" && estado.libro) || null;
  const claveLibro = titulo => String(titulo || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "sin-titulo";

  async function pedir(ruta, datos) {
    let r;
    try {
      r = await fetch(base() + ruta, datos
        ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...datos, secreto }) }
        : { cache: "no-store" });
    } catch { throw new Error("Sin conexión. Revisa el internet e intenta de nuevo."); }
    let j = {};
    try { j = await r.json(); } catch {}
    if (!r.ok) throw new Error(r.status === 503 ? "Los comentarios todavía no están activados. Avísale a Tere." : (j.error || `Error ${r.status}`));
    return j;
  }

  // ---------- botón en el reproductor y ventana de comentarios ----------
  const boton = document.createElement("button");
  boton.id = "btn-club";
  boton.className = "boton-club";
  boton.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/></svg><span>Comentarios del club</span><b id="club-cuenta"></b>';
  el("vista-reproductor").querySelector(".opciones").after(boton);

  const dlg = document.createElement("dialog");
  dlg.id = "dlg-club";
  dlg.className = "dlg-club";
  dlg.innerHTML = `
    <div class="club-cabeza">
      <div><h2>Comentarios del club</h2><p class="nota" id="club-libro"></p></div>
      <button type="button" class="icono" id="club-cerrar" aria-label="Cerrar"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </div>
    <ul id="club-lista" class="club-lista"></ul>
    <p id="club-estado" class="nota centrado" role="status"></p>
    <form id="club-form" class="club-form">
      <div class="club-yo"><span class="nota">Comentas como <b id="club-nombre"></b></span><button type="button" class="enlace" id="club-cambiar">Cambiar</button></div>
      <textarea id="club-texto" rows="3" maxlength="1500" placeholder="¿Qué te pareció? Escribe tu comentario…"></textarea>
      <label class="club-spoiler"><input type="checkbox" id="club-spoiler"> Cuenta algo del final (ocultarlo hasta que lo toquen)</label>
      <div class="fila-botones"><span class="nota" id="club-cap"></span><button type="submit" class="boton-principal" id="club-enviar">Publicar</button></div>
    </form>
    <form id="club-form-nombre" class="club-form" hidden>
      <label for="club-in-nombre">¿Cómo te llamas?</label>
      <input id="club-in-nombre" maxlength="40" autocomplete="given-name" placeholder="Tu nombre, como te conocen en el club">
      <div class="fila-botones"><button type="submit" class="boton-principal">Listo</button></div>
    </form>`;
  document.body.appendChild(dlg);

  let actual = null;   // { clave, titulo, comentarios }

  function fecha(ms) {
    const d = new Date(ms), hoy = new Date();
    const hora = d.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    if (d.toDateString() === hoy.toDateString()) return "hoy " + hora;
    const ayer = new Date(hoy); ayer.setDate(hoy.getDate() - 1);
    if (d.toDateString() === ayer.toDateString()) return "ayer " + hora;
    return d.toLocaleDateString("es-CL", { day: "numeric", month: "short" }) + " " + hora;
  }

  function pintarCuenta() {
    const n = actual && actual.comentarios ? actual.comentarios.length : 0;
    el("club-cuenta").textContent = n ? String(n) : "";
  }

  function pintarLista() {
    const ul = el("club-lista");
    ul.innerHTML = "";
    const lista = (actual && actual.comentarios) || [];
    el("club-estado").textContent = lista.length ? "" : "Todavía nadie comenta este libro. ¡Sé la primera!";
    for (const c of lista) {
      const li = document.createElement("li");
      li.className = "club-comentario" + (mios.has(c.id) ? " mio" : "");
      li.innerHTML = `<div class="club-meta"><b class="quien"></b><span class="nota cuando"></span></div>
        <p class="club-cap-tag nota" hidden></p><p class="club-txt"></p>`;
      li.querySelector(".quien").textContent = c.nombre;
      li.querySelector(".cuando").textContent = fecha(c.fecha);
      if (c.capitulo) { const t = li.querySelector(".club-cap-tag"); t.hidden = false; t.textContent = "Escuchando: " + c.capitulo; }
      const txt = li.querySelector(".club-txt");
      txt.textContent = c.texto;
      if (c.spoiler && !mios.has(c.id)) {
        txt.classList.add("oculto");
        const b = document.createElement("button");
        b.type = "button"; b.className = "chip club-ver"; b.textContent = "Cuenta algo del final · tocar para ver";
        b.onclick = () => { txt.classList.remove("oculto"); b.remove(); };
        txt.before(b);
      }
      if (mios.has(c.id)) {
        const b = document.createElement("button");
        b.type = "button"; b.className = "enlace club-borrar"; b.textContent = "Borrar";
        b.onclick = () => borrar(c);
        li.querySelector(".club-meta").appendChild(b);
      }
      ul.appendChild(li);
    }
  }

  async function cargar(silencioso = false) {
    const l = libroAbierto();
    if (!l) return;
    const clave = claveLibro(l.titulo);
    if (!actual || actual.clave !== clave) actual = { clave, titulo: l.titulo, comentarios: null };
    pintarCuenta();
    if (!silencioso) el("club-estado").textContent = "Cargando comentarios…";
    try {
      const j = await pedir("/comentarios?libro=" + encodeURIComponent(clave));
      if (actual.clave !== clave) return;
      actual.comentarios = j.comentarios || [];
      pintarCuenta();
      if (dlg.open) pintarLista();
    } catch (e) {
      if (!silencioso) el("club-estado").textContent = e.message;
    }
  }

  function pintarNombre() {
    const nombre = leer("nombre", "");
    el("club-nombre").textContent = nombre;
    el("club-form").hidden = !nombre;
    el("club-form-nombre").hidden = !!nombre;
    if (!nombre) el("club-in-nombre").value = "";
  }

  function capituloActual() {
    const l = libroAbierto();
    const p = l && l.pistas && l.pistas[typeof estado !== "undefined" ? estado.pista : 0];
    return p ? p.nombre : "";
  }

  async function abrir() {
    const l = libroAbierto();
    if (!l) return;
    el("club-libro").textContent = l.titulo;
    const cap = capituloActual();
    el("club-cap").textContent = cap ? "Vas en: " + cap : "";
    pintarNombre();
    if (actual && actual.comentarios) pintarLista(); else el("club-lista").innerHTML = "";
    dlg.showModal();
    await cargar();
    pintarLista();
    const ul = el("club-lista");
    ul.scrollTop = ul.scrollHeight;
  }

  async function publicar(ev) {
    ev.preventDefault();
    const texto = el("club-texto").value.trim();
    if (!texto || !actual) return;
    const b = el("club-enviar");
    b.disabled = true; b.textContent = "Publicando…";
    try {
      const j = await pedir("/comentarios?libro=" + encodeURIComponent(actual.clave), {
        titulo: actual.titulo, nombre: leer("nombre", ""), texto,
        capitulo: capituloActual(), spoiler: el("club-spoiler").checked,
      });
      mios.add(j.comentario.id); guardar("mios", [...mios]);
      actual.comentarios = [...(actual.comentarios || []), j.comentario];
      el("club-texto").value = ""; el("club-spoiler").checked = false;
      pintarLista(); pintarCuenta();
      const ul = el("club-lista"); ul.scrollTop = ul.scrollHeight;
    } catch (e) {
      el("club-estado").textContent = "No se pudo publicar: " + e.message;
    } finally {
      b.disabled = false; b.textContent = "Publicar";
    }
  }

  async function borrar(c) {
    if (!actual) return;
    try {
      await pedir("/comentarios/borrar?libro=" + encodeURIComponent(actual.clave), { id: c.id });
      actual.comentarios = actual.comentarios.filter(x => x.id !== c.id);
      mios.delete(c.id); guardar("mios", [...mios]);
      pintarLista(); pintarCuenta();
    } catch (e) {
      el("club-estado").textContent = "No se pudo borrar: " + e.message;
    }
  }

  boton.onclick = abrir;
  el("club-cerrar").onclick = () => dlg.close();
  el("club-form").onsubmit = publicar;
  el("club-cambiar").onclick = () => { guardar("nombre", ""); pintarNombre(); el("club-in-nombre").focus(); };
  el("club-form-nombre").onsubmit = ev => {
    ev.preventDefault();
    const n = el("club-in-nombre").value.trim().slice(0, 40);
    if (!n) return;
    guardar("nombre", n); pintarNombre(); el("club-texto").focus();
  };

  // Al abrir un libro (o cambiar de libro) se trae cuántos comentarios tiene, para mostrarlo en el botón.
  let ultimoTitulo = null;
  const revisar = () => {
    if (el("vista-reproductor").hidden) return;
    const l = libroAbierto();
    if (l && l.titulo !== ultimoTitulo) { ultimoTitulo = l.titulo; cargar(true); }
  };
  new MutationObserver(() => { ultimoTitulo = null; revisar(); }).observe(el("vista-reproductor"), { attributes: true, attributeFilter: ["hidden"] });
  new MutationObserver(revisar).observe(el("titulo-barra"), { childList: true, characterData: true, subtree: true });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !el("vista-reproductor").hidden) cargar(true); });
  revisar();
})();
