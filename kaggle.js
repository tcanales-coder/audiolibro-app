// Generar audiolibros en Kaggle desde la app (etapa 2).
// Cada persona usa su propia cuenta gratuita de Kaggle; su clave queda solo en su teléfono.
const KAGGLE = (() => {
  const INTERMEDIARIO_POR_DEFECTO = "https://cold-surf-87d1.tcanales.workers.dev";

  // ---------- credenciales y ajustes (solo en este teléfono) ----------
  function ajustes() {
    try { return JSON.parse(localStorage.getItem("kaggle:ajustes")) || {}; } catch { return {}; }
  }
  function guardarAjustes(a) {
    try { localStorage.setItem("kaggle:ajustes", JSON.stringify(a)); } catch {}
  }
  function intermediario() {
    return (ajustes().intermediario || INTERMEDIARIO_POR_DEFECTO || "").replace(/\/+$/, "");
  }
  function listo() {
    const a = ajustes();
    return !!(a.usuario && a.clave && intermediario());
  }
  function autorizacion() {
    const a = ajustes();
    // Claves nuevas de Kaggle (KGAT_...) van como "Bearer"; las de kaggle.json, como usuario:clave
    if (/^KGAT_/.test(a.clave)) return "Bearer " + a.clave;
    return "Basic " + btoa(unescape(encodeURIComponent(a.usuario + ":" + a.clave)));
  }

  // ---------- llamadas ----------
  async function api(servicio, metodo, cuerpo) {
    const r = await fetch(`${intermediario()}/api/${servicio}/${metodo}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": autorizacion() },
      body: JSON.stringify(cuerpo || {}),
    });
    const texto = await r.text();
    let datos = null;
    try { datos = texto ? JSON.parse(texto) : {}; } catch { datos = { mensaje: texto }; }
    if (!r.ok || (datos && datos.code >= 400)) {
      let msg = (datos && (datos.message || datos.error || datos.mensaje)) || "";
      if (/^\s*</.test(msg)) msg = "respuesta en HTML: " + (msg.match(/<title>([^<]*)/i) || [, "página web"])[1].trim();
      msg = `HTTP ${r.status}${msg ? " · " + String(msg).slice(0, 160) : ""}`;
      const e = new Error(r.status === 401 || r.status === 403 ? "Kaggle no aceptó la clave (" + msg + ")" : msg);
      e.status = r.status;
      throw e;
    }
    if (datos && datos.error) throw new Error(datos.error);
    return datos;
  }
  const viaIntermediario = url => `${intermediario()}/archivo?url=${encodeURIComponent(url)}`;

  // Con los tokens nuevos (KGAT_), el usuario real se le pregunta a Kaggle, igual que hace su
  // programa oficial. Así no importa si la persona escribió mal su usuario (mayúsculas, su nombre
  // visible, etc.): todo lo que se crea queda bajo el dueño correcto.
  async function confirmarUsuario() {
    const a = ajustes();
    if (!/^KGAT_/.test(a.clave || "")) return a.usuario;
    let r;
    try { r = await api("security.OAuthService", "IntrospectToken", { token: a.clave }); }
    catch (e) {
      if (e.status === 401 || e.status === 403) throw new Error("Kaggle no aceptó la clave. Genera un token nuevo y pégalo completo.");
      if (a.usuario) return a.usuario;      // si Kaggle no responde a esto, seguimos con lo escrito
      throw e;
    }
    if (!r.active || !r.username) throw new Error("Esa clave está vencida o fue borrada. Genera un token nuevo en Kaggle.");
    if (r.username !== a.usuario) guardarAjustes({ ...a, usuario: r.username });
    return r.username;
  }

  async function probar() {
    const usuario = await confirmarUsuario();
    // una consulta liviana para confirmar que la clave sirve para la API
    await api("kernels.KernelsApiService", "ListKernels", { user: usuario, pageSize: 1 });
    return usuario;
  }

  // ---------- subir archivos y crear el dataset ----------
  async function subirArchivo(archivo, nombre) {
    const inicio = await api("blobs.BlobApiService", "StartBlobUpload", {
      type: "DATASET",
      name: nombre,
      contentLength: archivo.size,
      contentType: archivo.type || "application/octet-stream",
      lastModifiedEpochSeconds: Math.floor((archivo.lastModified || Date.now()) / 1000),
    });
    const r = await fetch(viaIntermediario(inicio.createUrl), {
      method: "PUT",
      headers: { "Content-Type": archivo.type || "application/octet-stream" },
      body: archivo,
    });
    if (!r.ok) throw new Error(`No se pudo subir ${nombre} (HTTP ${r.status})`);
    return inicio.token;
  }

  const esperar = ms => new Promise(ok => setTimeout(ok, ms));

  // Devuelve { usuario, slug } tal como quedó en Kaggle.
  async function crearDataset(slug, titulo, archivos, avisar) {
    let usuario = await confirmarUsuario();
    const tokens = [];
    for (const [nombre, archivo] of archivos) {
      avisar(`Subiendo ${nombre}…`);
      tokens.push({ token: await subirArchivo(archivo, nombre) });
    }
    avisar("Creando la carpeta del libro en Kaggle…");
    const creado = await api("datasets.DatasetApiService", "CreateDataset", {
      ownerSlug: usuario, slug, title: titulo, isPrivate: true, licenseName: "unknown", files: tokens,
    });
    // Usar el dueño y nombre que Kaggle realmente le dio (puede diferir de lo pedido)
    const partes = String(creado.url || creado.ref || "").replace(/^https?:\/\/[^/]+/, "")
      .replace(/^\/?datasets\//, "").split("/").filter(Boolean);
    if (partes.length >= 2) { usuario = partes[partes.length - 2]; slug = partes[partes.length - 1]; }
    // Kaggle tarda un poco en dejar listo el dataset; esperamos antes de lanzar el notebook.
    // Recién creado, a veces responde "sin permiso" o "no existe" unos segundos: eso se reintenta.
    for (let i = 0; i < 60; i++) {
      let st;
      try { st = await api("datasets.DatasetApiService", "GetDatasetStatus", { ownerSlug: usuario, datasetSlug: slug }); }
      catch (e) {
        if ((e.status === 403 || e.status === 404) && i < 8) { avisar("Kaggle está preparando los archivos…"); await esperar(5000); continue; }
        throw e.status === 403 || e.status === 404
          ? new Error(`Kaggle creó la carpeta del libro pero no deja leerla (${usuario}/${slug}). Revisa en Cuenta de Kaggle que el usuario sea el tuyo.`)
          : e;
      }
      if (st.status === "READY") return { usuario, slug };
      if (st.status === "FAILED") throw new Error("Kaggle no pudo procesar los archivos subidos.");
      avisar("Kaggle está preparando los archivos…");
      await esperar(5000);
    }
    throw new Error("Kaggle se está demorando en preparar los archivos. Intenta de nuevo en unos minutos.");
  }

  // ---------- notebook ----------
  async function prepararNotebook({ epub, voz, descripcion }) {
    const nb = await (await fetch("kaggle/plantilla.ipynb", { cache: "no-cache" })).json();
    const cfg = nb.cells.find(c => c.cell_type === "code" && /PRUEBA\s*=/.test([].concat(c.source).join("")));
    let src = [].concat(cfg.source).join("");
    const linea = (nombre, valor) => {
      src = src.replace(new RegExp(`^(${nombre}\\s*=\\s*)([^#\\n]*?)(\\s*#@param.*)?$`, "m"), (_, a, __, c) => a + valor + (c || ""));
    };
    linea("PRUEBA", "False");
    linea("ARCHIVO_EPUB", JSON.stringify(epub));
    linea("MODO_VOZ", JSON.stringify(voz ? "clonar" : "diseñar"));
    linea("AUDIO_PARA_CLONAR", JSON.stringify(voz || ""));
    if (descripcion) linea("DESCRIPCION_VOZ", JSON.stringify(descripcion));
    linea("UN_SOLO_ARCHIVO_M4B", "False");
    cfg.source = src;
    for (const c of nb.cells) {
      if (Array.isArray(c.source)) c.source = c.source.join("");
      if (c.cell_type === "code") { c.outputs = []; c.execution_count = null; }
    }
    return JSON.stringify(nb);
  }

  async function lanzarNotebook(slugKernel, titulo, texto, fuentes) {
    const usuario = ajustes().usuario;
    const r = await api("kernels.KernelsApiService", "SaveKernel", {
      slug: `${usuario}/${slugKernel}`,
      newTitle: titulo,
      text: texto,
      language: "python",
      kernelType: "notebook",
      isPrivate: true,
      enableGpu: true,
      enableInternet: true,
      datasetDataSources: fuentes.datasets || [],
      kernelDataSources: fuentes.kernels || [],
    });
    if (r.invalidDatasetSources && r.invalidDatasetSources.length) throw new Error("Kaggle no encontró el EPUB subido: " + r.invalidDatasetSources.join(", "));
    return r;
  }

  // ---------- seguimiento ----------
  async function estado(slugKernel) {
    const r = await api("kernels.KernelsApiService", "GetKernelSessionStatus", { userName: ajustes().usuario, kernelSlug: slugKernel });
    return { estado: r.status || "QUEUED", error: r.failureMessage || "" };
  }

  // Lee el registro en vivo por unos segundos y saca la última estimación ("quedan ~X h").
  async function avance(slugKernel, msMax = 8000) {
    const ctrl = new AbortController();
    const corte = setTimeout(() => ctrl.abort(), msMax);
    let texto = "";
    try {
      const r = await fetch(`${intermediario()}/api/kernels.KernelsApiService/GetKernelSessionLogsStream`, {
        method: "POST", signal: ctrl.signal,
        headers: { "Content-Type": "application/json", "Authorization": autorizacion() },
        body: JSON.stringify({ userName: ajustes().usuario, kernelSlug: slugKernel, waitForLogsUrlSeconds: 5 }),
      });
      if (!r.ok || !r.body) return null;
      const lector = r.body.getReader(), dec = new TextDecoder();
      while (texto.length < 2_000_000) {
        const { value, done } = await lector.read();
        if (done) break;
        texto += dec.decode(value, { stream: true });
      }
    } catch { /* se cortó por tiempo: usamos lo leído */ }
    finally { clearTimeout(corte); }
    return interpretarRegistro(texto);
  }

  function interpretarRegistro(texto) {
    if (!texto) return null;
    const t = texto.replace(/\\n/g, "\n").replace(/\\u00b7/g, "·");
    const quedan = [...t.matchAll(/quedan ~([\d.]+) h/g)].pop();
    const listos = new Set([...t.matchAll(/✔ (\d{3}) -/g)].map(m => m[1])).size;
    const total = (t.match(/· (\d+) capítulos ·/) || [])[1];
    return {
      horasRestantes: quedan ? parseFloat(quedan[1]) : null,
      capitulosListos: listos,
      capitulosTotales: total ? parseInt(total) : null,
      pausado: /Pausado: vuelve a ejecutar/.test(t),
      terminado: /¡Listo!/.test(t),
    };
  }

  async function archivosDeSalida(slugKernel) {
    const usuario = ajustes().usuario;
    let archivos = [], token = null, log = "";
    do {
      const r = await api("kernels.KernelsApiService", "ListKernelSessionOutput",
        { userName: usuario, kernelSlug: slugKernel, pageSize: 200, pageToken: token || undefined });
      archivos = archivos.concat(r.files || []);
      if (r.log) log += r.log;
      token = r.nextPageToken;
    } while (token);
    return { archivos, registro: interpretarRegistro(log) };
  }

  async function descargar(url) {
    const r = await fetch(viaIntermediario(url));
    if (!r.ok) throw new Error(`No se pudo descargar (HTTP ${r.status})`);
    return r.blob();
  }

  return {
    ajustes, guardarAjustes, listo, intermediario, probar, confirmarUsuario, crearDataset,
    prepararNotebook, lanzarNotebook, estado, avance, archivosDeSalida, descargar,
  };
})();
