// ════════════════════════════════════════════════════════════════════════════
// PROMOBOT — radar de promociones por casa
// ────────────────────────────────────────────────────────────────────────────
// Objetivo: que ninguna promoción nueva (bono de bienvenida, cashback, giros,
// mejora de cuota...) se pase por alto por no estar mirando la página justo
// cuando sale. Cada casa se lee aparte; si una falla, no tumba a las demás
// — mismo criterio que functions/casas.js.
//
// RUSHBET: tiene una API pública sin sesión que ya usa su propio sitio para
// pintar el lobby de promociones (mfe-promo-lobby). Confirmado a mano:
//   GET https://www.rushbet.co/api/service/promolobby/cage/57/lightVersion
//       ?clientType=WEB&cageCode=57
// Devuelve JSON con cada promoción (id, name, badge, title, subtitle,
// categorías). No hace falta ni sesión ni parsear HTML.
//
// YA JUEGOS: mismo hallazgo, subdominio aparte (promociones.yajuego.co) con
// su propio feed JSON público:
//   GET https://promociones.yajuego.co/promotions/feapi/JsObjectAjax
// Devuelve cada promo con P_ID, P_TITLE, P_DESCRIPTION, P_CTA_LINK_DESKTOP.
//
// Casas revisadas y descartadas por ahora:
//   · WPLAY: su Promociones vive en www.wplay.co (no en apuestas.wplay.co,
//     de donde casas.js ya lee cuotas sin problema). www.wplay.co está detrás
//     de un reto de Cloudflare que bloqueó incluso una visita normal de
//     navegador.
//   · BET PLAY: tiene una API (apicms.betplay.com.co/api/v3/promotions) pero
//     exige un token de autorización — no es contenido abierto, así que no
//     se usa.
// Sus promociones se cargan a mano desde el panel de administración. Si
// alguna consigue una vía pública más adelante, se agrega aquí igual que
// Rushbet o Ya Juegos.
// ════════════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

async function traerJSON(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, 'Accept-Language': 'es-CO,es;q=0.9', ...(opts.headers || {}) }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

// ── RUSHBET ──────────────────────────────────────────────────────────────
async function leerRushbetPromos() {
  const url = 'https://www.rushbet.co/api/service/promolobby/cage/57/lightVersion' +
              '?clientType=WEB&cageCode=57';
  const j = await traerJSON(url);
  const out = [];
  (j.components || []).forEach(c => {
    const d = c.data;
    if (!d || !d.configuration) return;
    const cfg = d.configuration;
    // hideFromLobby: la propia casa la retiró del lobby aunque el registro
    // siga existiendo en su sistema — no cuenta como promoción vigente.
    if (cfg.hideFromLobby) return;
    const titulo = (cfg.title || '').trim();
    if (!titulo) return;
    out.push({
      casa: 'RUSHBET',
      promoId: 'RUSHBET_' + d.id,
      codigo: d.name || '',
      titulo,
      subtitulo: (cfg.subtitle || '').trim(),
      badge: (cfg.badge || '').trim(),
      categorias: (cfg.categories || []).map(x => x.name).filter(Boolean),
      url: 'https://www.rushbet.co/?page=promotions'
    });
  });
  return out;
}

// ── YA JUEGOS ────────────────────────────────────────────────────────────
// Mismo hallazgo que Rushbet: su propio sitio de promociones (subdominio
// aparte) pinta las tarjetas con un feed JSON público, sin sesión:
//   GET https://promociones.yajuego.co/promotions/feapi/JsObjectAjax
// Referer copiado del mismo criterio que ya usa leerYaJuegos() en casas.js
// para las cuotas — por si el servidor lo exige aunque en la prueba a mano
// respondió igual sin él.
async function leerYaJuegosPromos() {
  const url = 'https://promociones.yajuego.co/promotions/feapi/JsObjectAjax';
  const j = await traerJSON(url, { headers: { 'Referer': 'https://promociones.yajuego.co/' } });
  if (j.R !== 'OK') throw new Error('respuesta ' + j.R);
  const promos = (j.D && j.D.promotions && j.D.promotions.promos) || [];
  const out = [];
  promos.forEach(p => {
    const titulo = (p.P_TITLE || '').trim();
    if (!titulo || p.P_ID == null) return;
    out.push({
      casa: 'YA JUEGOS',
      promoId: 'YAJUEGOS_' + p.P_ID,
      codigo: String(p.P_ID),
      titulo,
      subtitulo: (p.P_DESCRIPTION || '').trim(),
      badge: (p.P_CTA_TEXT || '').trim(),
      categorias: [],
      url: p.P_CTA_LINK_DESKTOP || 'https://promociones.yajuego.co'
    });
  });
  return out;
}

// ── Lista de lectores activos. Agregar una casa nueva = agregar una entrada
// aquí, siempre que devuelva la misma forma de objeto. ─────────────────────
const LECTORES = [
  { casa: 'RUSHBET',   fn: leerRushbetPromos },
  { casa: 'YA JUEGOS', fn: leerYaJuegosPromos }
];

function idDoc(p) {
  return (p.casa + '_' + p.promoId).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 400);
}

// ── Corrida completa: lee cada casa, compara contra lo guardado, avisa lo
// nuevo, y marca como no vigente lo que ya no aparece (sin borrarlo, por si
// vuelve a salir o hace falta revisar el historial). ────────────────────────
async function vigilarPromociones(db) {
  const { enviarNotificacion } = require('./notificaciones');

  const informe = {};
  const leidas = [];
  await Promise.all(LECTORES.map(async l => {
    try {
      const r = await l.fn();
      leidas.push(...r);
      informe[l.casa] = r.length;
    } catch (e) {
      informe[l.casa] = 'ERROR: ' + (e.message || e);
    }
  }));

  const previos = await db.collection('patriarca_promociones').get();
  const guardado = new Map();
  previos.docs.forEach(d => guardado.set(d.id, d.data()));

  const vivos = new Set();
  const nuevas = [];
  const lote = db.batch();

  leidas.forEach(p => {
    const id = idDoc(p);
    vivos.add(id);
    const antes = guardado.get(id);
    const doc = {
      casa: p.casa, promoId: p.promoId, codigo: p.codigo || '',
      titulo: p.titulo, subtitulo: p.subtitulo || '', badge: p.badge || '',
      categorias: p.categorias || [], url: p.url || '',
      vigente: true,
      vistaEn: admin.firestore.FieldValue.serverTimestamp()
    };
    if (!antes) {
      doc.detectadaEn = admin.firestore.FieldValue.serverTimestamp();
      nuevas.push(p);
    } else if (antes.vigente === false) {
      // había desaparecido y volvió — cuenta como novedad otra vez
      doc.detectadaEn = admin.firestore.FieldValue.serverTimestamp();
      nuevas.push(p);
    }
    lote.set(db.collection('patriarca_promociones').doc(id), doc, { merge: true });
  });

  // Lo que ya no aparece en la lectura de hoy: se marca no vigente, no se borra
  let expiradas = 0;
  previos.docs.forEach(d => {
    if (!vivos.has(d.id) && d.data().vigente !== false) {
      lote.set(d.ref, { vigente: false, expiradaEn: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      expiradas++;
    }
  });

  await lote.commit();

  // Aviso por push a los administradores — tope de 5 por corrida para no
  // inundar si un día aparecen muchas de golpe (mismo criterio que Trixi Bot).
  let avisadas = 0;
  if (nuevas.length) {
    const primeras = nuevas.slice(0, 5);
    const cuerpo = primeras.map(p => `${p.casa}: ${p.titulo}${p.subtitulo ? ' — ' + p.subtitulo : ''}`).join('\n');
    try {
      await enviarNotificacion(db, {
        titulo: nuevas.length === 1 ? '🎁 Promoción nueva' : `🎁 ${nuevas.length} promociones nuevas`,
        cuerpo: cuerpo.slice(0, 180),
        datos: { tipo: 'promocion' }
      });
      avisadas = nuevas.length;
    } catch (e) { console.warn('promobot aviso ->', e.message); }
  }

  const resumen = {
    corridoEn: new Date().toISOString(),
    porCasa: informe,
    leidas: leidas.length,
    nuevas: nuevas.length,
    expiradas,
    avisadas
  };
  await db.collection('trixibot_estado').doc('promobot').set(resumen);
  return resumen;
}

module.exports = { vigilarPromociones, leerRushbetPromos };
