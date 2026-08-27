// ════════════════════════════════════════════════════════════════════════════
// MENSAJERÍA — ARCHIVADO
// ----------------------------------------------------------------------------
// El operador y el cajero no necesitan cargar con meses de conversación, pero
// el administrador sí necesita poder volver atrás cuando haya un reclamo.
//
// Por eso el mensaje viejo no se borra: se mueve de estante. Pasa de
//   patriarca_chat_hilos/{uid}/mensajes      (la conversación viva)
// a
//   patriarca_chat_archivo/{uid}/mensajes    (solo lo abre el administrador)
//
// Lo que alguno de los dos haya FIJADO nunca se mueve. Esa es la forma de
// decir «esto quiero tenerlo a la mano», y aplica para ambos lados.
// ════════════════════════════════════════════════════════════════════════════

const DIAS = 30;
const LOTE = 400;          // Firestore aguanta 500 operaciones por lote

async function archivarHilo(db, uid, corte) {
  const hilo   = db.collection('patriarca_chat_hilos').doc(uid);
  const vivos  = hilo.collection('mensajes');
  const imgs   = hilo.collection('imagenes');
  const arch   = db.collection('patriarca_chat_archivo').doc(uid).collection('mensajes');
  const archIm = db.collection('patriarca_chat_archivo').doc(uid).collection('imagenes');

  let movidos = 0, imagenes = 0;
  for (;;) {
    const snap = await vivos.where('ts', '<', corte).orderBy('ts').limit(LOTE).get();
    if (snap.empty) break;

    // Las imágenes de los reportes viven en su propia colección. Si solo se
    // moviera el mensaje quedarían sueltas, ocupando espacio para siempre.
    const conImagen = snap.docs.filter(d => !d.data().fijado
      && d.data().contexto && d.data().contexto.imagenRef);
    const traidas = await Promise.all(conImagen.map(d =>
      imgs.doc(d.data().contexto.imagenRef).get().catch(() => null)));

    const lote = db.batch();
    let enEsteLote = 0;
    snap.docs.forEach(d => {
      if (d.data().fijado) return;              // fijado se queda donde está
      lote.set(arch.doc(d.id), d.data());
      lote.delete(d.ref);
      enEsteLote++;
    });
    traidas.forEach(img => {
      if (!img || !img.exists) return;
      lote.set(archIm.doc(img.id), img.data());
      lote.delete(img.ref);
      imagenes++;
    });

    if (!enEsteLote) break;                     // solo quedaban fijados
    await lote.commit();
    movidos += enEsteLote;
    if (snap.size < LOTE) break;
  }
  return { movidos, imagenes };
}

async function archivar(db) {
  const corte = new Date(Date.now() - DIAS * 86400 * 1000);
  const hilos = await db.collection('patriarca_chat_hilos').get();

  const resumen = { revisados: hilos.size, movidos: 0, imagenes: 0, porHilo: {}, corte: corte.toISOString() };
  for (const h of hilos.docs) {
    try {
      const n = await archivarHilo(db, h.id, corte);
      if (n.movidos) {
        resumen.movidos  += n.movidos;
        resumen.imagenes += n.imagenes;
        resumen.porHilo[h.data().nombre || h.id] = n.movidos
          + (n.imagenes ? ' (+' + n.imagenes + ' imágenes)' : '');
      }
    } catch (e) {
      resumen.porHilo[h.id] = 'error: ' + (e && e.message || e);
    }
  }

  // Queda anotado que sí corrió, aunque no hubiera nada que mover: si no,
  // «no se ejecutó» y «no había nada» se ven exactamente igual.
  resumen.cuando = new Date().toISOString();
  await db.collection('trixibot_estado').doc('chat_archivado').set(resumen);
  return resumen;
}

module.exports = { archivar, DIAS };
