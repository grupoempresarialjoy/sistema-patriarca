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

const { leerKambi, leerYaJuegos, leerWplay } = require('./casas');
const { agrupar } = require('./emparejar');

admin.initializeApp();
const db = admin.firestore();
setGlobalOptions({ region: 'us-central1', memory: '512MiB', timeoutSeconds: 120 });

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

const DIAS_VENTANA = 3;

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
    return !isNaN(t) && t > ahora - 3600 * 1000 && t < limite;
  });

  // Escribir. Un documento por partido, con id estable para que se actualice
  // en vez de duplicarse. Se borra lo que ya no aparece.
  const lote = db.batch();
  const vivos = new Set();
  utiles.forEach(e => {
    const id = (e.local + '_' + e.visita + '_' + (e.inicio || ''))
      .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]/g, '_').slice(0, 400);
    vivos.add(id);
    lote.set(db.collection('trixibot_eventos').doc(id), {
      fecha: e.inicio ? hoyBogota(new Date(e.inicio)) : hoyBogota(),
      hora: horaBogota(e.inicio),
      inicioUTC: e.inicio || null,
      deporte: 'Fútbol',
      liga: e.liga || '—',
      local: e.local,
      visitante: e.visita,
      cuotas: { '1X2': e.cuotas },
      casas: Object.keys(e.cuotas),
      fuente: 'captador',
      actualizado: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: false });
  });

  // Limpiar los que dejaron de estar
  const previos = await db.collection('trixibot_eventos').get();
  let borrados = 0;
  previos.docs.forEach(d => {
    if (!vivos.has(d.id)) { lote.delete(d.ref); borrados++; }
  });

  await lote.commit();

  const resumen = {
    ok: true,
    corridoEn: new Date().toISOString(),
    fechaBogota: hoyBogota(),
    porCasa: informe,
    lecturas: lecturas.length,
    eventosUnicos: eventos.length,
    guardados: utiles.length,
    borrados,
    duracionMs: Date.now() - inicio
  };
  await db.collection('trixibot_estado').doc('captador').set(resumen);
  return resumen;
}

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
