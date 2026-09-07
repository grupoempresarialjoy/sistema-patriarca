// ════════════════════════════════════════════════════════════════════════════
// NOTIFICACIONES PUSH — App AJ1.6 (por ahora, solo administradores)
// ────────────────────────────────────────────────────────────────────────────
// Dos canales, ambos apuntando a los mismos dos eventos:
//
//   · admin_fcm_tokens     — token de Firebase Cloud Messaging. Lo llenaría
//     la app nativa (mobile-admin), pero esa requiere que la cuenta de Apple
//     Developer sea de pago para agregar la capacidad Push Notifications, y
//     por ahora no la tenemos — así que HOY este canal no tiene nada que
//     mandar (queda listo para cuando algún día se pague esa cuenta).
//   · admin_webpush_subs   — suscripción de Web Push estándar (el navegador,
//     o la PWA agregada a Inicio en iPhone, se suscribe directo desde
//     admin.html vía chat.js/activarWebPush()). Este es el que sí funciona
//     hoy, gratis, sin pasar por Apple.
//
// Se manda a los dos por si acaso; el que no tenga suscriptores simplemente
// no hace nada.
//
//   · Un operador o cajero le escribe a administración por el chat
//   · Trixi Bot encuentra una oportunidad nueva
//
// Las solicitudes de eliminación/corrección YA llegan como mensaje de chat
// (ver patriarca.html/cajero.html), así que el primer disparador las cubre
// solas — no hace falta un trigger aparte para eso.
//
// Si un token/suscripción ya no sirve (se desinstaló, expiró...) se borra
// solo, la primera vez que el envío falla con ese motivo — así la lista no
// se va llenando de cosas muertas con el tiempo.
// ════════════════════════════════════════════════════════════════════════════

const admin   = require('firebase-admin');
const webpush = require('web-push');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');

// La llave pública no es secreta — viaja tal cual al navegador (ver chat.js,
// VAPID_PUBLICA). La privada, en cambio, solo debe vivir acá. Si algún día
// se quiere rotar, hay que generar un par nuevo (`npx web-push generate-vapid-keys`)
// y actualizar las dos puntas a la vez, o las suscripciones viejas dejarán
// de servir hasta que cada quien vuelva a tocar "Activar notificaciones".
const VAPID_PUBLICA  = 'BNKCUmJbV1mD-59zIg0DSOmk9g_uFwEXKIivRTQfUb6Tie8IjVhwnKsoBbbS0_g4bQrbUNxHTSpsbqiJsG39FCc';
const VAPID_PRIVADA  = 'HmTOU7LgOkx728LSCd1bZP9vVV2vZyFAtuAJvy-FL4E';
webpush.setVapidDetails('mailto:ronaldo140294@gmail.com', VAPID_PUBLICA, VAPID_PRIVADA);

async function tokensDeAdmins(db) {
  const snap = await db.collection('admin_fcm_tokens').get();
  return snap.docs
    .map(d => ({ id: d.id, token: (d.data() || {}).token }))
    .filter(t => t.token);
}

const CODIGOS_TOKEN_MUERTO = [
  'messaging/registration-token-not-registered',
  'messaging/invalid-argument',
  'messaging/invalid-registration-token'
];

async function enviarPush(db, { titulo, cuerpo, datos }) {
  const tokens = await tokensDeAdmins(db);
  if (!tokens.length) return { enviados: 0, motivo: 'sin tokens registrados' };

  const mensaje = {
    notification: { title: titulo, body: cuerpo },
    data: datos || {},
    apns: { payload: { aps: { sound: 'default' } } },
    tokens: tokens.map(t => t.token)
  };

  const r = await admin.messaging().sendEachForMulticast(mensaje);

  const lote = db.batch();
  let borrados = 0;
  r.responses.forEach((resp, i) => {
    if (!resp.success && resp.error && CODIGOS_TOKEN_MUERTO.includes(resp.error.code)) {
      lote.delete(db.collection('admin_fcm_tokens').doc(tokens[i].id));
      borrados++;
    }
  });
  if (borrados) await lote.commit();

  return { enviados: r.successCount, fallidos: r.failureCount, tokensBorrados: borrados };
}

async function suscripcionesWebPush(db) {
  const snap = await db.collection('admin_webpush_subs').get();
  return snap.docs
    .map(d => ({ id: d.id, sub: d.data() }))
    .filter(x => x.sub && x.sub.endpoint && x.sub.keys);
}

async function enviarWebPush(db, { titulo, cuerpo, datos }) {
  const subs = await suscripcionesWebPush(db);
  if (!subs.length) return { enviados: 0, motivo: 'sin suscripciones web push' };

  const payload = JSON.stringify({ titulo, cuerpo, datos: datos || {} });
  let enviados = 0, borrados = 0;

  await Promise.all(subs.map(async ({ id, sub }) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys },
        payload
      );
      enviados++;
    } catch (e) {
      // 404/410 = el navegador canceló la suscripción (desinstaló la PWA,
      // borró datos, etc.) — cualquier otro código puede ser algo pasajero,
      // no se borra por las dudas.
      if (e && (e.statusCode === 404 || e.statusCode === 410)) {
        await db.collection('admin_webpush_subs').doc(id).delete();
        borrados++;
      }
    }
  }));

  return { enviados, suscripcionesBorradas: borrados };
}

// Manda por los dos canales a la vez; si uno falla del todo (por ejemplo,
// FCM sin tokens porque la app nativa no está activa) no debe tumbar al otro.
async function enviarNotificacion(db, payload) {
  const [fcm, web] = await Promise.allSettled([
    enviarPush(db, payload),
    enviarWebPush(db, payload)
  ]);
  return {
    fcm: fcm.status === 'fulfilled' ? fcm.value : { error: String(fcm.reason) },
    webpush: web.status === 'fulfilled' ? web.value : { error: String(web.reason) }
  };
}

// Un operador o cajero le escribió a administración. Los mensajes que manda
// el propio admin (de:'admin') no generan push — ya los está viendo él mismo.
const alMensajeUsuario = onDocumentCreated(
  'patriarca_chat_hilos/{uid}/mensajes/{msgId}',
  async event => {
    const doc = event.data;
    if (!doc) return;
    const m = doc.data();
    if (m.de !== 'usuario') return;
    const db = admin.firestore();
    await enviarNotificacion(db, {
      titulo: '📩 ' + (m.autorNombre || 'Mensaje nuevo'),
      cuerpo: (m.texto || '').slice(0, 120) || '📎 Envió un adjunto',
      datos: { tipo: 'chat', uid: event.params.uid }
    });
  }
);

// Trixi Bot encontró una oportunidad — mismo canal único que ve el portal.
const alTrixiNuevo = onDocumentCreated(
  'patriarca_chat_trixi/{id}',
  async event => {
    const doc = event.data;
    if (!doc) return;
    const t = doc.data();
    const resumen = (t.contexto && t.contexto.resumen) || t.texto || 'Nueva oportunidad detectada';
    const db = admin.firestore();
    await enviarNotificacion(db, {
      titulo: '🎰 Trixi Bot',
      cuerpo: String(resumen).slice(0, 120),
      datos: { tipo: 'trixi' }
    });
  }
);

module.exports = { alMensajeUsuario, alTrixiNuevo, enviarPush, enviarWebPush, enviarNotificacion };
