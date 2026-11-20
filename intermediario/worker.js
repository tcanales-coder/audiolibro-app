// Intermediario para la app Audiolibro (Cloudflare Worker, plan gratuito).
//
// Kaggle no deja que una página web le hable directamente desde el navegador,
// así que la app le pasa los mensajes a este intermediario y él se los pasa a Kaggle.
// No guarda claves, ni libros, ni audios: eso solo se reenvía.
//
// Lo único que guarda son los comentarios del club Choro y Tinta (texto corto con
// nombre), en un espacio KV de Cloudflare enlazado al Worker con el nombre COMENTARIOS.
//
// Solo acepta pedidos que vienen desde la app (lista ORIGENES) y solo habla con
// Kaggle y con el almacenamiento de archivos que Kaggle usa.

const ORIGENES = [
  "https://tcanales-coder.github.io",
  "http://localhost:8765",
];

const HOSTS_ARCHIVOS = [
  /(^|\.)googleapis\.com$/,
  /(^|\.)kaggle\.com$/,
  /(^|\.)kaggle\.net$/,
  /(^|\.)kaggleusercontent\.com$/,
];

function cabecerasCors(origen) {
  return {
    "Access-Control-Allow-Origin": origen,
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Expose-Headers": "Content-Type, Content-Length",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

// ---------- comentarios del club (Cloudflare KV, plan gratuito) ----------
const MAX_COMENTARIOS = 500;   // por libro
const LIMITES = { nombre: 40, texto: 1500, capitulo: 120, titulo: 160 };

function json(datos, cors, status = 200) {
  return new Response(JSON.stringify(datos), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });
}
const texto = (v, max) => String(v ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, max);
async function huella(secreto) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("choro:" + secreto));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function leerLibro(kv, clave) {
  return (await kv.get("libro:" + clave, "json")) || { titulo: "", comentarios: [] };
}
// Lo que ve la app: nunca la huella del secreto de cada autora
const publico = c => ({ id: c.id, nombre: c.nombre, texto: c.texto, capitulo: c.capitulo, spoiler: c.spoiler, fecha: c.fecha });

async function comentarios(pedido, url, env, cors) {
  const kv = env && env.COMENTARIOS;
  if (!kv) return json({ error: "Los comentarios aún no están activados en el intermediario." }, cors, 503);
  const clave = url.searchParams.get("libro") || "";
  if (!/^[a-z0-9-]{1,120}$/.test(clave)) return json({ error: "Libro no válido" }, cors, 400);

  if (pedido.method === "GET" && url.pathname === "/comentarios") {
    const datos = await leerLibro(kv, clave);
    return json({ comentarios: datos.comentarios.map(publico) }, cors);
  }
  if (pedido.method !== "POST") return json({ error: "No encontrado" }, cors, 404);

  let cuerpo;
  try { cuerpo = await pedido.json(); } catch { return json({ error: "Pedido no válido" }, cors, 400); }
  const secreto = texto(cuerpo.secreto, 100);
  if (secreto.length < 16) return json({ error: "Pedido no válido" }, cors, 400);
  const datos = await leerLibro(kv, clave);

  if (url.pathname === "/comentarios") {
    const nombre = texto(cuerpo.nombre, LIMITES.nombre), t = texto(cuerpo.texto, LIMITES.texto);
    if (!nombre || !t) return json({ error: "Falta el nombre o el comentario" }, cors, 400);
    if (datos.comentarios.length >= MAX_COMENTARIOS) return json({ error: "Este libro ya tiene demasiados comentarios" }, cors, 409);
    const c = {
      id: crypto.randomUUID().slice(0, 12), nombre, texto: t,
      capitulo: texto(cuerpo.capitulo, LIMITES.capitulo), spoiler: !!cuerpo.spoiler,
      fecha: Date.now(), dueno: await huella(secreto),
    };
    datos.titulo = datos.titulo || texto(cuerpo.titulo, LIMITES.titulo);
    datos.comentarios.push(c);
    await kv.put("libro:" + clave, JSON.stringify(datos));
    return json({ comentario: publico(c) }, cors);
  }
  if (url.pathname === "/comentarios/borrar") {
    const id = texto(cuerpo.id, 40), dueno = await huella(secreto);
    const antes = datos.comentarios.length;
    datos.comentarios = datos.comentarios.filter(c => !(c.id === id && c.dueno === dueno));
    if (datos.comentarios.length === antes) return json({ error: "Solo puedes borrar tus propios comentarios" }, cors, 403);
    await kv.put("libro:" + clave, JSON.stringify(datos));
    return json({ ok: true }, cors);
  }
  return json({ error: "No encontrado" }, cors, 404);
}

export default {
  async fetch(pedido, env) {
    const origen = pedido.headers.get("Origin") || "";
    if (!ORIGENES.includes(origen)) {
      return new Response("Este intermediario solo atiende a la app Audiolibro.", { status: 403 });
    }
    const cors = cabecerasCors(origen);
    if (pedido.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(pedido.url);
    let destino, opciones;

    if (url.pathname === "/") {
      return json({ ok: true, comentarios: !!(env && env.COMENTARIOS) }, cors);
    } else if (url.pathname === "/comentarios" || url.pathname === "/comentarios/borrar") {
      return comentarios(pedido, url, env, cors);
    } else if (url.pathname.startsWith("/api/") && pedido.method === "POST") {
      // /api/kernels.KernelsApiService/SaveKernel  ->  https://api.kaggle.com/v1/kernels.KernelsApiService/SaveKernel
      const ruta = url.pathname.slice(5);
      if (!/^[A-Za-z.]+\/[A-Za-z]+$/.test(ruta)) return new Response("Ruta no válida", { status: 400, headers: cors });
      destino = "https://api.kaggle.com/v1/" + ruta;
      opciones = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": pedido.headers.get("Authorization") || "",
          "User-Agent": "kaggle-api/v1.7.0 (audiolibro-app)",
        },
        body: await pedido.text(),
      };
    } else if (url.pathname === "/archivo" && (pedido.method === "GET" || pedido.method === "PUT")) {
      // Subir el EPUB a Kaggle (PUT) o bajar los audios terminados (GET)
      destino = url.searchParams.get("url") || "";
      let host;
      try { host = new URL(destino).hostname; } catch { host = ""; }
      if (!destino.startsWith("https://") || !HOSTS_ARCHIVOS.some(r => r.test(host))) {
        return new Response("Destino no permitido", { status: 403, headers: cors });
      }
      opciones = { method: pedido.method, redirect: "follow", headers: {} };
      if (pedido.method === "PUT") {
        const cuerpo = await pedido.arrayBuffer();
        opciones.body = cuerpo;
        opciones.headers["Content-Type"] = pedido.headers.get("Content-Type") || "application/octet-stream";
        opciones.headers["Content-Length"] = String(cuerpo.byteLength);
      }
    } else {
      return new Response("No encontrado", { status: 404, headers: cors });
    }

    const respuesta = await fetch(destino, opciones);
    const cabeceras = new Headers(respuesta.headers);
    for (const [k, v] of Object.entries(cors)) cabeceras.set(k, v);
    cabeceras.delete("Set-Cookie");
    return new Response(respuesta.body, { status: respuesta.status, headers: cabeceras });
  },
};
