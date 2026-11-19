// Intermediario para la app Audiolibro (Cloudflare Worker, plan gratuito).
//
// Kaggle no deja que una página web le hable directamente desde el navegador,
// así que la app le pasa los mensajes a este intermediario y él se los pasa a Kaggle.
// No guarda nada: ni claves, ni libros, ni audios. Solo reenvía.
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

export default {
  async fetch(pedido) {
    const origen = pedido.headers.get("Origin") || "";
    if (!ORIGENES.includes(origen)) {
      return new Response("Este intermediario solo atiende a la app Audiolibro.", { status: 403 });
    }
    const cors = cabecerasCors(origen);
    if (pedido.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(pedido.url);
    let destino, opciones;

    if (url.pathname === "/") {
      return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, "Content-Type": "application/json" } });
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
