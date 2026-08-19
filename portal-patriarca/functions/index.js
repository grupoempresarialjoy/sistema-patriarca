// ════════════════════════════════════════════════════════════════════════════
// TRIXI BOT — CAPTADOR
// Lee las casas cada pocos minutos y deja los partidos listos en Firestore.
// El portal solo lee de ahí; nunca habla con las casas directamente.
// ════════════════════════════════════════════════════════════════════════════

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest }  = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin   = require('firebase-admin');
const cheerio = require('cheerio');

const { traer, leerKambi, leerKambiMercados, leerYaJuegos, leerWplay } = require('./casas');
const { leerEnVivo, esFirme } = require('./resultados');
const { esPrincipal } = require('./ligas');
const { descargar } = require('./historico');
const { resolverCupon, acerto, sumarCalibracion, leerCalibracion } = require('./aprendizaje');
const { normEquipo, lineaDe, actualizarFicha,
        sumarAlHistorico, DIAS_DETALLE } = require('./aprendizaje');
const { agrupar } = require('./emparejar');

admin.initializeApp();
const db = admin.firestore();
setGlobalOptions({ region: 'us-central1', memory: '512MiB', timeoutSeconds: 300 });

// Fecha en Colombia, sin importar dónde corra el servidor
function hoyBogota(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(d || new Date());
}
function horaBogota(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota',
    hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}

// Cinco días, no tres. Medido: Wplay publica bastante de jueves y viernes que
// con tres días se botaba — pasa de 5 a 13 partidos emparejados. El costo es
// contenido porque los partidos lejanos solo refrescan sus mercados cada hora.
const DIAS_VENTANA = 5;

// Margen antes del pitazo inicial. Un partido a punto de empezar no sirve: las
// casas empiezan a mover cuotas y a cerrar mercados, y el operador necesita
// tiempo para colocar las dos patas.
const MINUTOS_MARGEN = 5;

async function capturar() {
  const inicio = Date.now();

  // Cada casa por separado: si una cae, las demás siguen
  const tareas = [
    { casa: 'YA JUEGOS', fn: () => leerYaJuegos() },
    { casa: 'BET PLAY',  fn: () => leerKambi('BET PLAY', 'betplay') },
    { casa: 'RUSHBET',   fn: () => leerKambi('RUSHBET', 'rsico') },
    { casa: 'WPLAY',     fn: () => leerWplay(cheerio) }
  ];

  const lecturas = [];
  const informe  = {};
  await Promise.all(tareas.map(async t => {
    try {
      const r = await t.fn();
      lecturas.push(...r);
      informe[t.casa] = r.length;
    } catch (e) {
      informe[t.casa] = 'ERROR: ' + (e.message || e);
    }
  }));

  // Agrupar el mismo partido de distintas casas
  const eventos = agrupar(lecturas);

  // Solo los que están en al menos 2 casas y dentro de la ventana
  const ahora = Date.now();
  const limite = ahora + DIAS_VENTANA * 24 * 3600 * 1000;
  const utiles = eventos.filter(e => {
    if (Object.keys(e.cuotas).length < 2) return false;
    if (!e.inicio) return true;                        // sin hora → se conserva
    const t = Date.parse(e.inicio);
    // Solo partidos que todavía no arrancan. Antes se conservaban los que
    // habían empezado hasta una hora atrás, y ahí una casa ya tenía cuotas en
    // vivo mientras la otra seguía mostrando las previas.
    return !isNaN(t) && t > ahora + MINUTOS_MARGEN * 60000 && t < limite;
  });

  // Id estable del partido, para reconocerlo entre corridas
  const idDe = e => (e.local + '_' + e.visita + '_' + (e.inicio || ''))
    .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '_').slice(0, 400);
  utiles.forEach(e => { e._id = idDe(e); });

  // Lo que ya está guardado: sirve para no volver a pedir mercados que apenas
  // cambiaron y, al final, para borrar los partidos que ya no aparecen.
  const previos = await db.collection('trixibot_eventos').get();
  const guardado = new Map();
  previos.docs.forEach(d => guardado.set(d.id, d.data()));

  // ── Mercados extra ────────────────────────────────────────────────────────
  // Ya Juegos los trae en su bundle. Kambi obliga a una petición por partido:
  // 240 partidos cada 3 minutos son 115.000 peticiones diarias, y la mayoría
  // para traer cuotas que no se movieron.
  //
  // Se refrescan según lo cerca que esté el partido. Una cuota de dentro de dos
  // días puede tener una hora de antigüedad sin que importe; una de dentro de
  // media hora, no.
  const EDAD_MAX_MIN = horas =>
    horas < 2  ? 3  :      // a punto de empezar: cada corrida
    horas < 12 ? 15 :      // hoy: cada cinco corridas
    horas < 24 ? 30 :      // mañana temprano
                 60;       // pasado mañana: una vez por hora

  const TOPE_KAMBI = 240;
  const EN_PARALELO = 10;
  const pendientes = [];
  let reusados = 0;

  utiles.forEach(e => {
    const prev = guardado.get(e._id);
    const horas = e.inicio ? (Date.parse(e.inicio) - ahora) / 3600000 : 0;
    const edad = prev && prev.mercadosTs ? (ahora - prev.mercadosTs) / 60000 : Infinity;

    // Los mercados extra son lo único caro: una petición por partido. Solo se
    // piden donde el operador va a apostar de verdad. En las demás ligas queda
    // el 1X2, que viene gratis en el listado.
    if (!esPrincipal(e.liga, e.pais)) { e._mercadosTs = prev && prev.mercadosTs || null;
      if (prev) Object.entries(prev.cuotas || {}).forEach(([clave, porCasa]) => {
        if (clave === '1X2') return;
        Object.entries(porCasa).forEach(([casa, vias]) => {
          if (!/BET PLAY|RUSHBET/.test(casa)) return;
          (e.mercados[casa] = e.mercados[casa] || {})[clave] = vias;
        });
      });
      return;
    }

    if (edad <= EDAD_MAX_MIN(horas)) {
      // Todavía sirve: se reutiliza lo guardado y no se pide nada.
      e._mercadosTs = prev.mercadosTs;
      Object.entries(prev.cuotas || {}).forEach(([clave, porCasa]) => {
        if (clave === '1X2') return;                  // el 1X2 siempre va fresco
        Object.entries(porCasa).forEach(([casa, vias]) => {
          if (!/BET PLAY|RUSHBET/.test(casa)) return; // solo lo que cuesta pedir
          (e.mercados[casa] = e.mercados[casa] || {})[clave] = vias;
        });
      });
      reusados++;
      return;
    }
    (e.refs || []).forEach(r => pendientes.push({ e, r }));
  });

  // Primero los que arrancan antes: si se llega al tope, que se queden sin
  // refrescar los más lejanos, que son los que menos se juegan.
  pendientes.sort((a, b) => Date.parse(a.e.inicio || 0) - Date.parse(b.e.inicio || 0));
  const cola = pendientes.slice(0, TOPE_KAMBI);
  let okMercados = 0, fallosMercados = 0;

  for (let i = 0; i < cola.length; i += EN_PARALELO) {
    await Promise.all(cola.slice(i, i + EN_PARALELO).map(async ({ e, r }) => {
      try {
        const m = await leerKambiMercados(r.marca, r.id);
        if (Object.keys(m).length) {
          e.mercados[r.casa] = Object.assign(e.mercados[r.casa] || {}, m);
          e._mercadosTs = ahora; okMercados++;
        }
      } catch (_) { fallosMercados++; }
    }));
  }

  // Armar el mapa final: mercado → casa → vías. Solo se guarda un mercado si
  // al menos dos casas lo tienen; con una sola no hay nada que comparar.
  function armarCuotas(e) {
    const porMercado = { '1X2': Object.assign({}, e.cuotas) };
    Object.entries(e.mercados || {}).forEach(([casa, ms]) => {
      Object.entries(ms).forEach(([clave, vias]) => {
        if (clave === '1X2') return;
        (porMercado[clave] = porMercado[clave] || {})[casa] = vias;
      });
    });
    Object.keys(porMercado).forEach(k => {
      if (Object.keys(porMercado[k]).length < 2) delete porMercado[k];
    });
    return porMercado;
  }

  // Escribir. Un documento por partido, con id estable para que se actualice
  // en vez de duplicarse. Se borra lo que ya no aparece.
  const lote = db.batch();
  const vivos = new Set();
  utiles.forEach(e => {
    const cuotas = armarCuotas(e);
    const id = e._id;
    vivos.add(id);
    lote.set(db.collection('trixibot_eventos').doc(id), {
      fecha: e.inicio ? hoyBogota(new Date(e.inicio)) : hoyBogota(),
      hora: horaBogota(e.inicio),
      inicioUTC: e.inicio || null,
      deporte: 'Fútbol',
      liga: e.liga || '—',
      pais: e.pais || '',
      // El captador decide si la liga es principal y lo deja escrito. Así la
      // lista vive en un solo sitio (functions/ligas.js) y el portal solo lee
      // la marca, en vez de mantener su propia copia que se puede desfasar.
      principal: esPrincipal(e.liga, e.pais),
      local: e.local,
      visitante: e.visita,
      cuotas,
      casas: Object.keys(e.cuotas),
      mercados: Object.keys(cuotas),
      mercadosTs: e._mercadosTs || null,   // cuándo se pidieron por última vez
      fuente: 'captador',
      actualizado: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: false });
  });

  // Limpiar los que dejaron de estar
  let borrados = 0;
  previos.docs.forEach(d => {
    if (!vivos.has(d.id)) { lote.delete(d.ref); borrados++; }
  });

  await lote.commit();

  // Resultados: aprovecha la misma corrida. Si falla, el captador sigue.
  let vigilancia = null;
  try { vigilancia = await vigilar(); }
  catch (e) { vigilancia = { error: String(e && e.message || e) }; }

  const resumen = {
    ok: true,
    corridoEn: new Date().toISOString(),
    fechaBogota: hoyBogota(),
    porCasa: informe,
    lecturas: lecturas.length,
    eventosUnicos: eventos.length,
    guardados: utiles.length,
    mercadosKambi: { pedidos: cola.length, ok: okMercados, fallos: fallosMercados,
                     reusados, principales: utiles.filter(e => esPrincipal(e.liga, e.pais)).length },
    resultados: vigilancia,
    borrados,
    duracionMs: Date.now() - inicio
  };
  await db.collection('trixibot_estado').doc('captador').set(resumen);
  return resumen;
}

// ════════════════════════════════════════════════════════════════════════════
// VIGILANTE DE RESULTADOS
// Va montado dentro del captador, que ya corre cada 3 minutos: así no gasta ni
// una ejecución extra. Guarda una sola hoja con los partidos en curso; cuando
// uno desaparece, su última anotación pasa a ser el resultado.
//
// Con 3 minutos entre lecturas, un gol en el descuento puede quedar sin anotar.
// Por eso cada resultado se marca firme o dudoso: la ficha del equipo solo
// aprende de los firmes. Es preferible tener menos datos que tenerlos malos.
// ════════════════════════════════════════════════════════════════════════════
const HOJA_VIVO = () => db.collection('trixibot_estado').doc('envivo');

// Suma un día a una fecha 'AAAA-MM-DD' sin pasar por Date, que en zonas
// distintas de UTC devuelve el día equivocado.
function siguienteDia(f) {
  if (!f) return null;
  const [a, m, d] = f.split('-').map(Number);
  const t = new Date(Date.UTC(a, m - 1, d + 1));
  return t.toISOString().slice(0, 10);
}

async function vigilar() {
  const actuales = await leerEnVivo(traer);
  const ahora = {};
  actuales.forEach(f => { ahora[f.id] = f; });

  const snap = await HOJA_VIVO().get();
  const antes = (snap.exists && snap.data().partidos) || {};

  // Los que estaban y ya no están: terminaron. Se archiva su última foto.
  const terminados = Object.keys(antes).filter(id => !ahora[id]);
  let guardados = 0, dudosos = 0;

  if (terminados.length) {
    const lote = db.batch();
    terminados.forEach(id => {
      const f = antes[id];
      if (!f || f.golesLocal == null) return;
      const firme = esFirme(f);
      if (!firme) dudosos++;
      guardados++;
      lote.set(db.collection('trixibot_resultados').doc(String(id)), {
        ...f,
        // Sin llegar al minuto 90 el dato no es de fiar: pudo suspenderse o el
        // feed pudo soltarlo antes de tiempo.
        firme,
        procesado: false,          // lo recoge el cierre diario
        fecha: f.inicio ? hoyBogota(new Date(f.inicio)) : hoyBogota(),
        registrado: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    });
    await lote.commit();
  }

  // Si nada se movió, no se reescribe: de madrugada casi no hay partidos y no
  // tiene sentido gastar una escritura por corrida para guardar lo mismo.
  const igual = JSON.stringify(ahora) === JSON.stringify(antes);
  if (!igual) {
    await HOJA_VIVO().set({
      partidos: ahora,
      enCurso: actuales.length,
      actualizado: admin.firestore.FieldValue.serverTimestamp()
    });
  }

  return { enCurso: actuales.length, terminados: guardados, dudosos, sinCambios: igual };
}

exports.vigilarAhora = onRequest(async (req, res) => {
  try { res.json(await vigilar()); }
  catch (e) { res.status(500).json({ ok:false, error:String(e && e.message || e) }); }
});

// ════════════════════════════════════════════════════════════════════════════
// CIERRE DIARIO — COMBINADAS PRO
// Una sola ejecución de madrugada. Toma los resultados que el vigilante anotó
// durante el día y arma la ficha de cada equipo. Se procesa lo que esté sin
// procesar, sin importar de qué día sea: un partido de las 10pm que acaba
// pasada la medianoche entra en el cierre siguiente.
// ════════════════════════════════════════════════════════════════════════════
// El resultado se guarda con el id de Kambi y el cupón con el id del evento del
// captador: no son el mismo. Se cruzan por equipos y fecha, que ambos traen y
// vienen del mismo feed, así que los nombres coinciden.
async function cargarResultados(cupones) {
  const clave = (local, visita, fecha) =>
    normEquipo(local) + '|' + normEquipo(visita) + '|' + (fecha || '');

  // Solo resultados firmes: uno capturado antes del minuto 90 podría dar por
  // perdido un cupón que un gol tardío habría ganado.
  const fechas = [...new Set(cupones.map(c => c.fecha).filter(Boolean))];
  const cache = new Map();
  for (const f of fechas) {
    for (const dia of [f, siguienteDia(f)]) {        // un partido de noche cae al día siguiente
      const q = await db.collection('trixibot_resultados')
        .where('fecha', '==', dia).where('firme', '==', true).get();
      q.docs.forEach(d => { const r = d.data();
        cache.set(clave(r.local, r.visita, r.fecha), r); });
    }
  }
  const buscar = o => {
    const f = o.inicio ? hoyBogota(new Date(o.inicio)) : null;
    return cache.get(clave(o.local, o.visitante, f)) ||
           cache.get(clave(o.local, o.visitante, siguienteDia(f)));
  };
  return { cache, buscar };
}

// Los cupones resueltos antes de que se guardara el detalle por opción quedaron
// sin saber cuál falló: la hoja les mostraba "0 de 3" aunque hubieran ganado.
// Esto los vuelve a resolver con los resultados que ya están guardados.
async function recalcularCupones() {
  const snap = await db.collection('combinadas_cupones')
    .where('resuelto', '==', true).limit(300).get();
  const viejos = snap.docs
    .map(d => ({ ref: d.ref, ...d.data() }))
    .filter(c => c.aciertos == null);
  if (!viejos.length) return { recalculados: 0 };

  const { cache, buscar } = await cargarResultados(viejos);
  const ops = [];
  viejos.forEach(c => {
    const opciones = (c.opciones || []).map(o => {
      const r = buscar(o);
      return { ...o, acerto: acerto(o, r),
               golesLocal: r ? r.golesLocal : null,
               golesVisita: r ? r.golesVisita : null };
    });
    ops.push(b => b.update(c.ref, {
      opciones, aciertos: opciones.filter(o => o.acerto === true).length
    }));
  });
  for (let i = 0; i < ops.length; i += 400) {
    const b = db.batch(); ops.slice(i, i + 400).forEach(f => f(b)); await b.commit();
  }
  return { recalculados: viejos.length, sinResultado: cache.size === 0 };
}

// Se llama desde el administrador, así que necesita permiso de origen cruzado
exports.recalcularAhora = onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.set('Access-Control-Allow-Methods', 'GET'); return res.status(204).send(''); }
  try { res.json(await recalcularCupones()); }
  catch (e) { res.status(500).json({ ok:false, error:String(e && e.message || e) }); }
});

// ── Resolver los cupones propuestos ─────────────────────────────────────────
// Se corre dentro del cierre. Compara cada cupón con los resultados y anota si
// pegó. Los que esperan un partido que aún no termina quedan pendientes y se
// vuelven a mirar mañana.
async function resolverCupones() {
  const snap = await db.collection('combinadas_cupones')
    .where('resuelto', '==', false).limit(300).get();
  if (snap.empty) return { revisados: 0 };

  const cupones = snap.docs.map(d => ({ ref: d.ref, ...d.data() }));

  const { buscar } = await cargarResultados(cupones);

  const cuenta = { ganados: 0, perdidos: 0, pendientes: 0 };
  const ops = [];
  const paraCalibrar = [];
  cupones.forEach(c => {
    const { estado } = resolverCupon(c, buscar);
    if (estado === 'pendiente') { cuenta.pendientes++; return; }
    const gano = estado === 'ganado';
    gano ? cuenta.ganados++ : cuenta.perdidos++;
    paraCalibrar.push({ prob: c.probEstimada || 0, gano });

    // Se guarda el resultado de CADA opción, no solo el del cupón. Perder por
    // una sola opción no es lo mismo que perder por las tres, y esa diferencia
    // es lo que dice si el bot iba encaminado o escogió mal.
    const opciones = (c.opciones || []).map(o => {
      const r = buscar(o);
      return { ...o, acerto: acerto(o, r),
               golesLocal: r ? r.golesLocal : null,
               golesVisita: r ? r.golesVisita : null };
    });
    const aciertos = opciones.filter(o => o.acerto === true).length;

    ops.push(b => b.update(c.ref, {
      resuelto: true, estado, opciones, aciertos,
      resueltoEn: admin.firestore.FieldValue.serverTimestamp()
    }));
  });
  for (let i = 0; i < ops.length; i += 400) {
    const b = db.batch(); ops.slice(i, i + 400).forEach(f => f(b)); await b.commit();
  }

  // Calibración: ¿lo que el bot predijo se parece a lo que pasó?
  let calibracion = null;
  if (paraCalibrar.length) {
    const ref = db.collection('trixibot_estado').doc('calibracion');
    const prev = await ref.get();
    const franjas = sumarCalibracion(prev.exists ? prev.data().franjas : null, paraCalibrar);
    calibracion = leerCalibracion(franjas);
    await ref.set({ franjas, lectura: calibracion,
                    actualizado: admin.firestore.FieldValue.serverTimestamp() });
  }

  const total = cuenta.ganados + cuenta.perdidos;
  return { revisados: cupones.length, ...cuenta, calibracion,
           // El acierto solo significa algo con muestra; con 5 cupones no dice nada
           acierto: total ? +(cuenta.ganados / total).toFixed(3) : null };
}

async function cerrarDia() {
  // Solo los firmes: los dudosos son partidos que desaparecieron antes del
  // minuto 90 y su marcador puede estar incompleto. Es mejor tener menos
  // datos que aprender de datos malos.
  const snap = await db.collection('trixibot_resultados')
    .where('procesado', '==', false).where('firme', '==', true).limit(200).get();

  // Aunque no haya nada que procesar se deja constancia: si no, no hay manera
  // de saber si la tarea programada corrió o si nunca se disparó.
  const cupones = await resolverCupones().catch(e => ({ error: String(e.message || e) }));

  if (snap.empty) {
    const vacio = { ok:true, corridoEn:new Date().toISOString(), procesados:0, equipos:0, sinTrabajo:true, cupones };
    const antes = await db.collection('trixibot_estado').doc('aprendizaje').get();
    await db.collection('trixibot_estado').doc('aprendizaje')
      .set({ ...(antes.exists ? antes.data() : {}), ...vacio }, { merge:true });
    return vacio;
  }

  // Agrupar por equipo antes de escribir: un partido toca dos fichas, y varios
  // partidos del mismo equipo deben actualizarla una sola vez.
  const porEquipo = new Map();
  const docs = snap.docs.map(d => ({ ref: d.ref, ...d.data() }));
  docs.forEach(r => {
    [[r.local, true], [r.visita, false]].forEach(([nombre, esLocal]) => {
      const k = normEquipo(nombre);
      if (!k) return;
      if (!porEquipo.has(k)) porEquipo.set(k, { nombre, lineas: [] });
      porEquipo.get(k).lineas.push(lineaDe(r, esLocal));
    });
  });

  const claves = [...porEquipo.keys()];
  const previas = await Promise.all(claves.map(k =>
    db.collection('combinadas_equipos').doc(k).get()));

  // Un partido toca dos fichas, así que 200 resultados pueden ser 600
  // escrituras y un lote de Firestore aguanta 500. Se parte en tandas.
  const ops = [];
  claves.forEach((k, i) => {
    const { nombre, lineas } = porEquipo.get(k);
    const prev = previas[i].exists ? previas[i].data() : null;
    ops.push(b => b.set(db.collection('combinadas_equipos').doc(k), {
      equipo: nombre,
      ...actualizarFicha(prev, lineas),
      actualizado: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true }));
  });
  docs.forEach(r => ops.push(b => b.update(r.ref, { procesado: true })));

  for (let i = 0; i < ops.length; i += 400) {
    const b = db.batch();
    ops.slice(i, i + 400).forEach(f => f(b));
    await b.commit();
  }

  // Avance del aprendizaje. Se cuenta con consultas de agregación, que cobran
  // como una lectura y no como una por equipo: el portal lee un solo documento
  // en vez de recorrer la colección cada vez que alguien abre la pestaña.
  const contar = async q => { try { return (await q.count().get()).data().count; } catch (_) { return null; } };
  const col = db.collection('combinadas_equipos');
  const [conFicha, listos, maduros] = await Promise.all([
    contar(col),
    contar(col.where('partidos', '>=', 8)),
    contar(col.where('partidos', '>=', 15))
  ]);

  const previo = await db.collection('trixibot_estado').doc('aprendizaje').get();
  const acumulado = (previo.exists && previo.data().partidosAprendidos) || 0;

  const resumen = {
    ok: true,
    corridoEn: new Date().toISOString(),
    procesados: docs.length,
    equipos: claves.length,
    quedanPendientes: docs.length === 200,     // si llegó al tope, falta otra vuelta
    partidosAprendidos: acumulado + docs.length,
    equiposConFicha: conFicha,
    equiposListos: listos,                     // 8 partidos o más
    equiposMaduros: maduros,                   // 15 o más
    cupones
  };
  await db.collection('trixibot_estado').doc('aprendizaje').set(resumen);
  return resumen;
}

// Cuatro veces al día, repartidas según cuándo terminan los partidos:
//   04:30 — cierra lo de Norteamérica y la madrugada
//   10:30 — Asia y Oceanía
//   16:30 — las ligas europeas de la tarde
//   22:30 — Colombia y Sudamérica
// Cada corrida cuesta una ejecución y unas 500 lecturas. Antes con una sola,
// un cupón que se definía a las 4 de la tarde no se veía resuelto hasta el
// otro día.
exports.cierreDiario = onSchedule(
  { schedule: '30 4,10,16,22 * * *', timeZone: 'America/Bogota' },
  async () => { console.log('cierre', JSON.stringify(await cerrarDia())); }
);

exports.cerrarAhora = onRequest(async (req, res) => {
  try { res.json(await cerrarDia()); }
  catch (e) { res.status(500).json({ ok:false, error:String(e && e.message || e) }); }
});

// ════════════════════════════════════════════════════════════════════════════
// CARGA DEL HISTÓRICO
// Llena las fichas con años de resultados publicados gratis, en vez de esperar
// meses a que se acumulen. Va a los contadores comprimidos: veinte mil partidos
// pesan lo mismo que doscientos.
// ════════════════════════════════════════════════════════════════════════════
async function cargarHistorico(anios) {
  const t0 = Date.now();
  const { partidos, informe } = await descargar(
    url => traer(url, { json: false }), anios || 3);
  if (!partidos.length) return { ok: false, motivo: 'no se descargó nada' };

  // Agrupar por equipo antes de escribir
  const porEquipo = new Map();
  partidos.forEach(({ equipo, linea }) => {
    const k = normEquipo(equipo);
    if (!k) return;
    if (!porEquipo.has(k)) porEquipo.set(k, { nombre: equipo, lineas: [] });
    porEquipo.get(k).lineas.push(linea);
  });

  const claves = [...porEquipo.keys()];
  let escritos = 0;
  // De a 200 equipos: leer los previos, sumar, escribir
  for (let i = 0; i < claves.length; i += 200) {
    const trozo = claves.slice(i, i + 200);
    const previas = await Promise.all(trozo.map(k =>
      db.collection('combinadas_equipos').doc(k).get()));
    const lote = db.batch();
    trozo.forEach((k, j) => {
      const { nombre, lineas } = porEquipo.get(k);
      const prev = previas[j].exists ? previas[j].data() : null;
      // No repetir si ya se cargó antes: cada partido tiene id propio
      const yaVistos = new Set((prev && prev.historicoIds) || []);
      const nuevas = lineas.filter(l => !yaVistos.has(l.id));
      if (!nuevas.length) return;
      let h = prev && prev.historico;
      nuevas.forEach(l => { h = sumarAlHistorico(h, l); });
      lote.set(db.collection('combinadas_equipos').doc(k), {
        equipo: prev && prev.equipo ? prev.equipo : nombre,
        historico: h,
        // Se guarda qué partidos ya se contaron, para poder recargar sin duplicar
        historicoIds: [...yaVistos, ...nuevas.map(l => l.id)].slice(-1200),
        historicoActualizado: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      escritos++;
    });
    await lote.commit();
  }

  const resumen = { ok: true, corridoEn: new Date().toISOString(),
                    lecturas: partidos.length / 2, equipos: claves.length,
                    actualizados: escritos, porArchivo: informe,
                    duracionMs: Date.now() - t0 };
  await db.collection('trixibot_estado').doc('historico').set(resumen);
  return resumen;
}

// Descarga 50 archivos y escribe cientos de equipos: necesita más aire que el
// resto de funciones.
exports.cargarHistoricoAhora = onRequest({ timeoutSeconds: 540, memory: '1GiB' }, async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.set('Access-Control-Allow-Methods', 'GET'); return res.status(204).send(''); }
  try { res.json(await cargarHistorico(parseInt(req.query.anios || '3', 10))); }
  catch (e) { res.status(500).json({ ok:false, error:String(e && e.message || e) }); }
});

// ════════════════════════════════════════════════════════════════════════════
// COMPACTACIÓN
// Los resultados en crudo se guardan 90 días. Pasado ese plazo se suman a los
// contadores del equipo y se borran: 200 partidos que pesaban 51 KB quedan en
// 140 bytes. El sistema puede recordar años sin crecer, porque lo que guarda
// son ocho números, no ocho mil partidos.
// ════════════════════════════════════════════════════════════════════════════
async function compactar() {
  const corte = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota',
    year:'numeric', month:'2-digit', day:'2-digit' })
    .format(new Date(Date.now() - DIAS_DETALLE * 864e5));

  const snap = await db.collection('trixibot_resultados')
    .where('procesado', '==', true).where('fecha', '<', corte).limit(300).get();
  if (snap.empty) {
    const vacio = { ok:true, corridoEn:new Date().toISOString(), corte, comprimidos:0, sinTrabajo:true };
    await db.collection('trixibot_estado').doc('compactacion').set(vacio);
    return vacio;
  }

  const docs = snap.docs.map(d => ({ ref: d.ref, ...d.data() }));
  const porEquipo = new Map();
  docs.forEach(r => {
    [[r.local, true], [r.visita, false]].forEach(([nombre, esLocal]) => {
      const k = normEquipo(nombre); if (!k) return;
      if (!porEquipo.has(k)) porEquipo.set(k, []);
      porEquipo.get(k).push(lineaDe(r, esLocal));
    });
  });

  const claves = [...porEquipo.keys()];
  const previas = await Promise.all(claves.map(k =>
    db.collection('combinadas_equipos').doc(k).get()));

  const ops = [];
  claves.forEach((k, i) => {
    let h = previas[i].exists ? previas[i].data().historico : null;
    porEquipo.get(k).forEach(l => { h = sumarAlHistorico(h, l); });
    ops.push(b => b.set(db.collection('combinadas_equipos').doc(k),
      { historico: h, comprimidoHasta: corte }, { merge: true }));
  });
  // Se borran solo después de sumarlos: si algo falla, quedan para la próxima
  docs.forEach(r => ops.push(b => b.delete(r.ref)));

  for (let i = 0; i < ops.length; i += 400) {
    const b = db.batch();
    ops.slice(i, i + 400).forEach(f => f(b));
    await b.commit();
  }

  const resumen = { ok:true, corridoEn:new Date().toISOString(), corte,
                    comprimidos: docs.length, equipos: claves.length,
                    quedanPendientes: docs.length === 300 };
  await db.collection('trixibot_estado').doc('compactacion').set(resumen);
  return resumen;
}

// Domingos a las 5 de la mañana, después del cierre diario
exports.compactacion = onSchedule(
  { schedule: '0 5 * * 0', timeZone: 'America/Bogota' },
  async () => { console.log('compactar', JSON.stringify(await compactar())); }
);

exports.compactarAhora = onRequest(async (req, res) => {
  try { res.json(await compactar()); }
  catch (e) { res.status(500).json({ ok:false, error:String(e && e.message || e) }); }
});

// Cada 3 minutos
exports.captador = onSchedule(
  { schedule: 'every 3 minutes', timeZone: 'America/Bogota' },
  async () => { const r = await capturar(); console.log('captador', JSON.stringify(r)); }
);

// Para dispararlo a mano y ver el resultado
exports.captarAhora = onRequest(async (req, res) => {
  try { res.json(await capturar()); }
  catch (e) { res.status(500).json({ ok: false, error: String(e && e.message || e) }); }
});
