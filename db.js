// Almacenamiento local en el teléfono (IndexedDB).
// libros: {id, titulo, creado, pistas:[{nombre, idArchivo, duracion}], pos:{pista, tiempo}, terminado}
// archivos: {id, blob}
const BD = (() => {
  let conexion;

  function abrir() {
    if (conexion) return Promise.resolve(conexion);
    return new Promise((ok, mal) => {
      const pet = indexedDB.open("audiolibro", 1);
      pet.onupgradeneeded = () => {
        const db = pet.result;
        db.createObjectStore("libros", { keyPath: "id" });
        db.createObjectStore("archivos", { keyPath: "id" });
      };
      pet.onsuccess = () => { conexion = pet.result; ok(conexion); };
      pet.onerror = () => mal(pet.error);
    });
  }

  async function tx(almacenes, modo, fn) {
    const db = await abrir();
    return new Promise((ok, mal) => {
      const t = db.transaction(almacenes, modo);
      let resultado;
      Promise.resolve(fn(t)).then(r => { resultado = r; });
      t.oncomplete = () => ok(resultado);
      t.onerror = () => mal(t.error);
      t.onabort = () => mal(t.error || new Error("Transacción cancelada"));
    });
  }

  const pedir = p => new Promise((ok, mal) => { p.onsuccess = () => ok(p.result); p.onerror = () => mal(p.error); });

  return {
    libros: () => tx(["libros"], "readonly", t => pedir(t.objectStore("libros").getAll())),
    libro: id => tx(["libros"], "readonly", t => pedir(t.objectStore("libros").get(id))),
    guardarLibro: libro => tx(["libros"], "readwrite", t => { t.objectStore("libros").put(libro); }),
    archivo: id => tx(["archivos"], "readonly", t => pedir(t.objectStore("archivos").get(id))).then(r => r && r.blob),
    guardarArchivo: (id, blob) => tx(["archivos"], "readwrite", t => { t.objectStore("archivos").put({ id, blob }); }),
    borrarLibro: libro => tx(["libros", "archivos"], "readwrite", t => {
      t.objectStore("libros").delete(libro.id);
      for (const p of libro.pistas) t.objectStore("archivos").delete(p.idArchivo);
    }),
  };
})();
