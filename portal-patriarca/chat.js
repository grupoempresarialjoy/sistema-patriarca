/* ============================================================================
   MENSAJERÍA DEL ECOSISTEMA AJ1.6
   ----------------------------------------------------------------------------
   Un solo archivo para los cuatro portales. Lo carga admin.html, patriarca.html
   y cajero.html; cada uno arranca con el rol que le corresponde.

   Cómo está organizada la conversación
   ------------------------------------
   · El administrador publica ANUNCIOS al ecosistema y elige quién los ve
     (todos / operadores / cajeros). Un anuncio puede ir FIJADO: se queda
     arriba de la pantalla hasta que la persona toca "Entendido", y el
     administrador ve en vivo cuántos lo leyeron y quién falta.
   · Cada operador y cada cajero tiene un HILO PRIVADO con el administrador.
     Nadie más lo ve. No existe un muro donde ellos se hablen entre sí: eso es
     a propósito, para que no circule información del negocio entre cuentas.
   · Un mensaje puede llevar CONTEXTO pegado (un cupón, una cuota, un
     movimiento de caja). El portal lo adjunta solo cuando el reporte sale
     desde el botón "Reportar" de ese objeto.

   Los chulitos
   ------------
   No se guarda un estado por mensaje —serían miles de escrituras—. Se guardan
   dos marcas de agua en el documento del hilo y el estado se deduce de ellas:

     ✓        enviado    · quedó escrito en Firestore
     ✓✓       recibido   · el otro portal lo recibió (entregadoHasta ≥ mensaje)
     ✓✓ azul  leído      · el otro abrió la conversación (leidoHasta ≥ mensaje)

   Un solo chulito quiere decir que esa persona todavía no ha abierto el
   portal. Eso es información útil, no una falla.

   Colecciones
   -----------
   patriarca_chat_hilos/{uid}                 un documento por persona
   patriarca_chat_hilos/{uid}/mensajes/{id}   la conversación viva
   patriarca_chat_archivo/{uid}/mensajes/{id} lo que pasó de 30 días
   patriarca_chat_anuncios/{id}               los avisos al ecosistema
============================================================================ */

(function (global) {
'use strict';

const COL_HILOS    = 'patriarca_chat_hilos';
const COL_ANUNCIOS = 'patriarca_chat_anuncios';
const COL_ARCHIVO  = 'patriarca_chat_archivo';
const MAX_MENSAJES = 200;   // cuántos trae el hilo vivo de una vez

const CH = {
  db: null, auth: null,
  uid: '', nombre: '', rol: '', oficina: '',
  esAdmin: false,
  hilo: null,               // datos del hilo abierto
  hiloUid: '',              // de quién es el hilo abierto (lado admin)
  mensajes: [],
  anuncios: [],
  hilos: [],                // lado admin: todos los hilos
  personas: [],             // lado admin: usuarios activos, para el "X de Y"
  vista: 'chat',            // lado admin: 'chat' | 'anuncios'
  contexto: null,           // adjunto pendiente de enviar
  abierto: false,           // ¿la pantalla de mensajes está a la vista?
  _off: []                  // suscripciones para poder soltarlas
};

/* ── utilidades ─────────────────────────────────────────────────────────── */

const esc = s => String(s == null ? '' : s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;').replace(/'/g,'&#39;');

const ms = t => !t ? 0 : (typeof t.toMillis === 'function' ? t.toMillis()
                        : (t.seconds ? t.seconds * 1000 : +new Date(t) || 0));

function hora(t) {
  const d = new Date(ms(t)); if (!ms(t)) return '';
  return d.toLocaleTimeString('es-CO', { hour:'2-digit', minute:'2-digit' });
}

function dia(t) {
  const v = ms(t); if (!v) return '';
  const d = new Date(v), hoy = new Date();
  const mismo = (a,b) => a.toDateString() === b.toDateString();
  if (mismo(d, hoy)) return 'Hoy';
  const ayer = new Date(hoy); ayer.setDate(ayer.getDate()-1);
  if (mismo(d, ayer)) return 'Ayer';
  return d.toLocaleDateString('es-CO', { day:'numeric', month:'long' });
}

// Hace cuánto, en palabras — para la lista de hilos del administrador
function hace(t) {
  const v = ms(t); if (!v) return '';
  const s = (Date.now() - v) / 1000;
  if (s < 60)    return 'ahora';
  if (s < 3600)  return Math.floor(s/60) + ' min';
  if (s < 86400) return Math.floor(s/3600) + ' h';
  if (s < 604800)return Math.floor(s/86400) + ' d';
  return new Date(v).toLocaleDateString('es-CO', { day:'numeric', month:'short' });
}

const ahora = () => firebase.firestore.FieldValue.serverTimestamp();
const sumar = n => firebase.firestore.FieldValue.increment(n);

/* ── el chulito ─────────────────────────────────────────────────────────── */
// Se deduce comparando la fecha del mensaje contra las dos marcas de agua
// del hilo. No hay ningún campo de estado guardado en el mensaje.

function estadoDe(m) {
  const h = CH.hilo || {};
  const mio  = CH.esAdmin ? 'admin' : 'usuario';
  if (m.de !== mio) return '';                       // solo marco lo que yo mandé
  const leido     = CH.esAdmin ? h.leidoHastaUsuario     : h.leidoHastaAdmin;
  const entregado = CH.esAdmin ? h.entregadoHastaUsuario : h.entregadoHastaAdmin;
  const t = ms(m.ts);
  if (!t) return 'enviado';                          // aún sin fecha del servidor
  if (ms(leido)     >= t) return 'leido';
  if (ms(entregado) >= t) return 'entregado';
  return 'enviado';
}

function pintarChulito(m) {
  const e = estadoDe(m);
  if (!e) return '';
  const t = { enviado:'Enviado', entregado:'Recibido', leido:'Leído' }[e];
  const doble = e !== 'enviado';
  return `<span class="ch-tick ch-tick-${e}" title="${t}">`
       + `<svg viewBox="0 0 20 12" width="18" height="11" aria-label="${t}">`
       + `<path d="M1 6.5 L4.6 10 L11 2.6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>`
       + (doble ? `<path d="M8.4 10 L14.8 2.6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>` : '')
       + `</svg></span>`;
}

/* ── estilos ────────────────────────────────────────────────────────────── */

const CSS = `
.ch-wrap{display:flex;gap:14px;height:calc(100vh - 210px);min-height:420px}
.ch-lista{width:290px;flex-shrink:0;background:var(--bg2);border:1px solid var(--border);border-radius:10px;display:flex;flex-direction:column;overflow:hidden}
.ch-lista-cab{padding:10px 12px;border-bottom:1px solid var(--border);font-size:11px;font-weight:700;color:var(--text2);letter-spacing:.4px;text-transform:uppercase}
.ch-lista-scroll{flex:1;overflow-y:auto}
.ch-item{padding:11px 12px;border-bottom:1px solid var(--border);cursor:pointer;display:flex;gap:10px;align-items:flex-start}
.ch-item:hover{background:var(--row-hover)}
.ch-item.act{background:rgba(53,204,47,.10);border-left:3px solid var(--green);padding-left:9px}
.ch-ava{width:34px;height:34px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#0d0f14;background:linear-gradient(135deg,#35CC2F,#24BF62)}
.ch-ava-caj{background:linear-gradient(135deg,#4a9eff,#2a7fd8)}
.ch-item-txt{flex:1;min-width:0}
.ch-item-nom{font-size:13px;font-weight:600;color:var(--text);display:flex;justify-content:space-between;gap:6px;align-items:center}
.ch-item-fec{font-size:10px;color:var(--text2);font-weight:400;flex-shrink:0}
.ch-item-ult{font-size:11.5px;color:var(--text2);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ch-glob{background:var(--green);color:#0d0f14;border-radius:20px;min-width:19px;height:19px;padding:0 6px;font-size:10.5px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}

.ch-panel{flex:1;background:var(--bg2);border:1px solid var(--border);border-radius:10px;display:flex;flex-direction:column;overflow:hidden;min-width:0}
.ch-cab{padding:11px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;flex-shrink:0}
.ch-cab-nom{font-size:14px;font-weight:600;color:var(--text)}
.ch-cab-sub{font-size:11px;color:var(--text2)}
.ch-cuerpo{flex:1;overflow-y:auto;padding:16px 14px;display:flex;flex-direction:column;gap:3px}
.ch-dia{align-self:center;font-size:10.5px;color:var(--text2);background:var(--bg3);padding:3px 12px;border-radius:20px;margin:10px 0 6px}

.ch-msg:has(.ch-ctx-img){max-width:380px}
.ch-msg{max-width:74%;padding:8px 11px 6px;border-radius:12px;font-size:13.5px;line-height:1.45;color:var(--text);position:relative;word-wrap:break-word}
.ch-msg-mio{align-self:flex-end;background:rgba(53,204,47,.14);border:1px solid rgba(53,204,47,.28);border-bottom-right-radius:4px}
.ch-msg-otro{align-self:flex-start;background:var(--bg3);border:1px solid var(--border);border-bottom-left-radius:4px}
.ch-msg-autor{font-size:10.5px;font-weight:700;color:var(--green);margin-bottom:3px}
.ch-msg-pie{display:flex;align-items:center;justify-content:flex-end;gap:5px;margin-top:3px;font-size:10px;color:var(--text2)}
.ch-tick{display:inline-flex;align-items:center;color:var(--text2)}
.ch-tick-leido{color:#4a9eff}
.ch-fij{position:absolute;top:-7px;right:8px;font-size:10px}
.ch-msg-acc{opacity:0;transition:opacity .15s;position:absolute;top:4px;left:-26px;cursor:pointer;font-size:12px;color:var(--text2)}
.ch-msg:hover .ch-msg-acc{opacity:1}
.ch-msg-mio .ch-msg-acc{left:auto;right:-26px}

.ch-ctx{background:rgba(74,158,255,.10);border-left:3px solid #4a9eff;border-radius:6px;padding:6px 9px;margin-bottom:6px;font-size:11.5px}
.ch-ctx-tit{font-weight:700;color:#4a9eff;font-size:10px;text-transform:uppercase;letter-spacing:.3px;margin-bottom:2px}
.ch-ctx-txt{color:var(--text2);line-height:1.4}
.ch-ctx-img{padding:7px 8px 8px}
.ch-img{display:block;width:100%;max-width:330px;border-radius:6px;margin-top:5px;cursor:zoom-in;border:1px solid var(--border)}
.ch-img-cargando{margin-top:5px;padding:26px 10px;text-align:center;font-size:11px;color:var(--text2);background:var(--bg2);border-radius:6px}
.ch-lupa{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.88);display:flex;align-items:center;justify-content:center;padding:26px;cursor:zoom-out}
.ch-lupa img{max-width:100%;max-height:100%;border-radius:8px;box-shadow:0 18px 60px rgba(0,0,0,.6)}

.ch-pie{border-top:1px solid var(--border);padding:10px 12px;flex-shrink:0}
.ch-ctx-prev{display:flex;align-items:center;gap:8px;background:rgba(74,158,255,.10);border-left:3px solid #4a9eff;border-radius:6px;padding:6px 9px;margin-bottom:8px;font-size:11.5px}
.ch-ctx-prev-x{margin-left:auto;cursor:pointer;color:var(--text2);font-size:14px;padding:0 4px}
.ch-fila{display:flex;gap:8px;align-items:flex-end}
.ch-txt{flex:1;background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:9px 12px;color:var(--text);font-size:13.5px;font-family:inherit;resize:none;max-height:130px;min-height:38px;line-height:1.45}
.ch-txt:focus{outline:none;border-color:var(--green)}
.ch-env{background:var(--green);color:#0d0f14;border:none;border-radius:10px;width:38px;height:38px;font-size:16px;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center}
.ch-env:disabled{opacity:.4;cursor:default}

.ch-vacio{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--text2);gap:8px;text-align:center;padding:24px}
.ch-vacio-ico{font-size:34px;opacity:.5}

/* Anuncios */
.ch-an{background:var(--bg3);border:1px solid var(--border);border-left:3px solid var(--green);border-radius:8px;padding:11px 13px;margin-bottom:10px}
.ch-an-cab{display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap}
.ch-an-pub{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.3px;padding:2px 7px;border-radius:20px;background:rgba(53,204,47,.15);color:var(--green)}
.ch-an-fec{font-size:10.5px;color:var(--text2);margin-left:auto}
.ch-an-txt{font-size:13px;color:var(--text);line-height:1.5;white-space:pre-wrap}
.ch-an-pie{margin-top:8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ch-an-cont{font-size:11px;color:var(--text2);cursor:pointer;text-decoration:underline dotted}

/* Ventana flotante — el anuncio se ve sí o sí al entrar */
.ch-modal{position:fixed;inset:0;z-index:99998;background:rgba(6,8,12,.82);display:flex;align-items:center;justify-content:center;padding:22px;backdrop-filter:blur(3px)}
.ch-modal-caja{background:var(--bg2);border:1px solid var(--border);border-radius:14px;width:min(540px,100%);max-height:86vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 70px rgba(0,0,0,.55)}
.ch-modal-imp{border-color:rgba(53,204,47,.5)}
.ch-modal-cab{padding:16px 20px 13px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:11px}
.ch-modal-ico{width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;background:rgba(53,204,47,.14)}
.ch-modal-tit{font-size:15px;font-weight:700;color:var(--text)}
.ch-modal-sub{font-size:11px;color:var(--text2);margin-top:1px}
.ch-modal-x{margin-left:auto;background:none;border:none;color:var(--text2);font-size:19px;cursor:pointer;padding:2px 6px;line-height:1}
.ch-modal-cuerpo{padding:20px;overflow-y:auto;font-size:14px;line-height:1.6;color:var(--text);white-space:pre-wrap}
.ch-modal-pie{padding:13px 20px 16px;border-top:1px solid var(--border);display:flex;align-items:center;gap:12px}
.ch-modal-cuenta{font-size:11.5px;color:var(--text2)}
.ch-modal-ok{margin-left:auto;background:var(--green);color:#0d0f14;border:none;border-radius:9px;padding:10px 24px;font-size:13px;font-weight:700;cursor:pointer}
.ch-modal-ok:hover{filter:brightness(1.08)}

/* La franja del anuncio fijado, arriba de todo el portal */
.ch-fijado{background:linear-gradient(90deg,rgba(53,204,47,.16),rgba(36,191,98,.10));border-bottom:1px solid rgba(53,204,47,.35);padding:11px 18px;display:flex;align-items:center;gap:14px;flex-shrink:0}
.ch-fijado-ico{font-size:19px;flex-shrink:0}
.ch-fijado-txt{flex:1;font-size:13px;color:var(--text);line-height:1.45;white-space:pre-wrap}
.ch-fijado-tit{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--green);margin-bottom:2px}
.ch-fijado-ok{background:var(--green);color:#0d0f14;border:none;border-radius:7px;padding:7px 16px;font-size:12px;font-weight:700;cursor:pointer;flex-shrink:0}

/* Globo de no leídos sobre la pestaña del portal */
.ch-nav-glob{background:#e05050;color:#fff;border-radius:20px;min-width:17px;height:17px;padding:0 5px;font-size:10px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;margin-left:5px;vertical-align:middle}

/* Redactar anuncio */
.ch-form label{display:block;font-size:11px;font-weight:600;color:var(--text2);margin:12px 0 5px;text-transform:uppercase;letter-spacing:.3px}
.ch-form textarea,.ch-form select{width:100%;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:9px 11px;color:var(--text);font-size:13px;font-family:inherit}
.ch-form textarea{min-height:96px;resize:vertical;line-height:1.5}
.ch-check{display:flex;align-items:flex-start;gap:9px;margin-top:12px;cursor:pointer;font-size:12.5px;color:var(--text)}
.ch-check input{margin-top:2px;width:15px;height:15px;accent-color:var(--green);cursor:pointer}
.ch-check-sub{font-size:11px;color:var(--text2);margin-top:2px;line-height:1.4}

.ch-quien{margin-top:8px;padding:9px 11px;background:var(--bg2);border:1px solid var(--border);border-radius:7px;font-size:11.5px}
.ch-quien-fila{display:flex;justify-content:space-between;padding:3px 0;color:var(--text2)}
.ch-quien-si{color:var(--green)}

@media(max-width:820px){
  .ch-wrap{flex-direction:column;height:auto}
  .ch-lista{width:100%;max-height:230px}
  .ch-panel{height:65vh}
  .ch-msg{max-width:86%}
}`;

function inyectarEstilos() {
  if (document.getElementById('ch-css')) return;
  const s = document.createElement('style');
  s.id = 'ch-css'; s.textContent = CSS;
  document.head.appendChild(s);
}

/* ── contexto adjunto ───────────────────────────────────────────────────── */

const CTX_TITULO = {
  cupon:      'Combinada',
  cuota:      'Cuota de Trixi',
  movimiento: 'Movimiento de caja',
  cierre:     'Cierre',
  evento:     'Evento',
  informeAmc: 'Informe AMC',
  informeCorr:'Informe Corresponsal',
  otro:       'Referencia'
};

// Las imágenes no viajan dentro del mensaje: irían en cada instantánea del
// hilo y se pagarían una y otra vez. Van en un documento aparte y se traen
// solo cuando la burbuja se va a pintar. La caché evita repetir la lectura.
const _imgCache = new Map();

// `coleccion`+`docId` dicen DÓNDE vive la subcolección `imagenes`: el hilo
// del usuario (COL_HILOS/uid) para mensajes normales, o el anuncio mismo
// (COL_ANUNCIOS/id) cuando lo publica un operador con permiso de transmitir.
function pintarContexto(c, coleccion, docId) {
  if (!c) return '';
  const titulo = esc(CTX_TITULO[c.tipo] || CTX_TITULO.otro);
  coleccion = coleccion || COL_HILOS;

  // Con imagen: se ve el cupón de un vistazo. El texto queda de respaldo
  // por si la imagen no carga, en una sola línea.
  if (c.imagenRef) {
    const clave = coleccion + '/' + docId + '/' + c.imagenRef;
    const cache = _imgCache.get(clave);
    const cuerpo = cache
      ? `<img class="ch-img" src="${cache}" alt="${titulo}" onclick="AJChat.ampliar(this.src)">`
      : `<div class="ch-img-cargando" data-img="${esc(c.imagenRef)}"
           data-col="${esc(coleccion)}" data-doc="${esc(docId||'')}">Cargando imagen…</div>`;
    const linea = String(c.resumen || '').split('\n')[0];
    return `<div class="ch-ctx ch-ctx-img">`
         + `<div class="ch-ctx-tit">${titulo}</div>${cuerpo}`
         + (linea ? `<div class="ch-ctx-txt" style="margin-top:5px">${esc(linea)}</div>` : '')
         + `</div>`;
  }

  return `<div class="ch-ctx">`
       + `<div class="ch-ctx-tit">${titulo}</div>`
       + `<div class="ch-ctx-txt">${esc(c.resumen || '')}</div></div>`;
}

// Trae las imágenes que quedaron pendientes en lo que se acaba de pintar
function cargarImagenes() {
  document.querySelectorAll('.ch-img-cargando').forEach(async el => {
    const ref = el.dataset.img, col = el.dataset.col || COL_HILOS, doc = el.dataset.doc;
    if (!ref || !doc || el.dataset.pedida) return;
    el.dataset.pedida = '1';
    const clave = col + '/' + doc + '/' + ref;
    try {
      const d = await CH.db.collection(col).doc(doc).collection('imagenes').doc(ref).get();
      const datos = d.exists ? d.data().datos : '';
      if (!datos) { el.textContent = 'La imagen ya no está disponible'; return; }
      _imgCache.set(clave, datos);
      const img = document.createElement('img');
      img.className = 'ch-img'; img.src = datos;
      img.onclick = () => AJChat.ampliar(datos);
      el.replaceWith(img);
    } catch (e) { el.textContent = 'No se pudo cargar la imagen'; }
  });
}

/* ── lectura de datos ───────────────────────────────────────────────────── */

function refHilo(uid) { return CH.db.collection(COL_HILOS).doc(uid); }

// Marca de agua de RECIBIDO: se escribe cuando este portal realmente recibió
// mensajes del otro lado. Una escritura por tanda, no una por mensaje.
const _ultimoEntregado = {};
function marcarEntregado(uid, msgs) {
  const mio   = CH.esAdmin ? 'admin' : 'usuario';
  const campo = CH.esAdmin ? 'entregadoHastaAdmin' : 'entregadoHastaUsuario';
  const previo = ms((CH.hilo || {})[campo]);
  const ultimo = msgs.reduce((mx, m) => (m.de !== mio && ms(m.ts) > mx) ? ms(m.ts) : mx, 0);
  if (!ultimo || ultimo <= previo) return;
  if (_ultimoEntregado[uid] >= ultimo) return;      // ya se escribió esta misma marca
  _ultimoEntregado[uid] = ultimo;
  refHilo(uid).set({ [campo]: new Date(ultimo) }, { merge:true }).catch(()=>{});
}

// Marca de agua de LEÍDO: al abrir la conversación. Pone el contador en cero.
//
// Ojo con el bucle: serverTimestamp llega vacío en la primera instantánea
// local, así que el guardia de «ya estaba al día» no lo ve y volvería a
// escribir, disparando otra instantánea, y así sin parar. La espera corta por
// hilo corta esa cadena mientras el servidor confirma la fecha real.
const _ultimoLeido = {};
function marcarLeido(uid) {
  if (Date.now() - (_ultimoLeido[uid] || 0) < 4000) return;
  const campo   = CH.esAdmin ? 'leidoHastaAdmin' : 'leidoHastaUsuario';
  const campoNo = CH.esAdmin ? 'noLeidosAdmin'   : 'noLeidosUsuario';
  const h = CH.hilo || {};
  if (!(h[campoNo] > 0) && ms(h[campo]) >= ms(h.ultimoTs)) return;   // ya estaba al día
  _ultimoLeido[uid] = Date.now();
  refHilo(uid).set({ [campo]: ahora(), [campoNo]: 0 }, { merge:true }).catch(()=>{});
}

function escucharMensajes(uid, alPintar) {
  return CH.db.collection(COL_HILOS).doc(uid).collection('mensajes')
    .orderBy('ts', 'desc').limit(MAX_MENSAJES)
    .onSnapshot(snap => {
      CH.mensajes = snap.docs.map(d => ({ id:d.id, ...d.data() })).reverse();
      marcarEntregado(uid, CH.mensajes);
      if (CH.abierto) marcarLeido(uid);
      alPintar();
    }, e => console.warn('mensajes:', e.message));
}

function escucharHilo(uid, alPintar) {
  return refHilo(uid).onSnapshot(d => {
    CH.hilo = d.exists ? d.data() : {};
    alPintar();
  }, e => console.warn('hilo:', e.message));
}

function escucharAnuncios(publicos, alPintar) {
  return CH.db.collection(COL_ANUNCIOS).orderBy('ts', 'desc').limit(60)
    .onSnapshot(snap => {
      CH.anuncios = snap.docs.map(d => ({ id:d.id, ...d.data() }))
        .filter(a => !publicos || publicos.includes(a.publico || 'todos'));
      alPintar();
    }, e => console.warn('anuncios:', e.message));
}

/* ── envío ─────────────────────────────────────────────────────────────── */

async function enviar(uidHilo, texto, contexto) {
  texto = String(texto || '').trim();
  if (!texto && !contexto) return;
  const de = CH.esAdmin ? 'admin' : 'usuario';

  const msg = {
    de, autorUid: CH.uid, autorNombre: CH.nombre,
    texto, ts: ahora(), fijado: false
  };
  const hilo = refHilo(uidHilo);

  // Si viene imagen, se guarda en su propio documento y el mensaje solo
  // se queda con la referencia. Así el hilo sigue siendo liviano de leer.
  let ctx = contexto;
  if (ctx && ctx.imagen) {
    const { imagen, ...resto } = ctx;
    try {
      const ref = await hilo.collection('imagenes').add({ datos: imagen, ts: ahora() });
      ctx = { ...resto, imagenRef: ref.id };
    } catch (e) {
      console.warn('imagen del reporte:', e.message);
      ctx = resto;                       // sin imagen, pero el reporte sale igual
    }
  }
  if (ctx) msg.contexto = ctx;

  await hilo.collection('mensajes').add(msg);

  // Resumen del hilo: lo que ve el administrador en su lista sin abrir nada
  const cab = {
    uid: uidHilo,
    ultimoTexto: texto || ('📎 ' + ((ctx && CTX_TITULO[ctx.tipo]) || 'Referencia')),
    ultimoTs: ahora(),
    ultimoDe: de
  };
  cab[CH.esAdmin ? 'noLeidosUsuario' : 'noLeidosAdmin'] = sumar(1);
  // Quien escribe, por definición ya leyó todo lo suyo
  cab[CH.esAdmin ? 'leidoHastaAdmin' : 'leidoHastaUsuario'] = ahora();
  if (!CH.esAdmin) { cab.nombre = CH.nombre; cab.rol = CH.rol; cab.oficina = CH.oficina; }
  await hilo.set(cab, { merge:true });
}

// ── Transmitir a todos los operadores ───────────────────────────────────────
// Distinto de "reportar": eso arma un mensaje privado hacia el administrador,
// listo para que el operador lo revise y lo mande a mano. Esto va directo,
// como anuncio, a todos los operadores a la vez — pensado para que el dueño
// (o quien tenga el permiso) comparta algo puntual, como una cuota positiva.
// Nunca queda fijado: a diferencia del anuncio importante del administrador,
// este siempre se puede cerrar. El permiso real se valida en las reglas de
// Firestore; aquí solo se arma y se guarda el documento.
async function transmitir(ctx) {
  if (!ctx) return;
  const ref = CH.db.collection(COL_ANUNCIOS).doc();
  let c = ctx;
  if (c && c.imagen) {
    const { imagen, ...resto } = c;
    try {
      const img = await ref.collection('imagenes').add({ datos: imagen, ts: ahora() });
      c = { ...resto, imagenRef: img.id };
    } catch (e) {
      console.warn('imagen de la transmisión:', e.message);
      c = resto;                         // sin imagen, pero la transmisión sale igual
    }
  }
  await ref.set({
    texto: '', publico: 'operadores', fijado: false,
    autorUid: CH.uid, autorNombre: CH.nombre,
    origenOperador: true, contexto: c,
    ts: ahora(), leidoPor: {}
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   LADO OPERADOR Y CAJERO
   ══════════════════════════════════════════════════════════════════════════ */

const DIAS_MODAL = 15;      // más viejo que esto no abre ventana
let _modalAbierto = false;
let _primeraTanda = true;   // la primera vez sí se muestran todos

const Usuario = {

  montar(sel) {
    const cont = document.querySelector(sel);
    if (!cont) return;
    cont.innerHTML = `
      <div class="ch-wrap">
        <div class="ch-lista">
          <div class="ch-lista-cab">📢 Anuncios del ecosistema</div>
          <div class="ch-lista-scroll" id="ch-anuncios" style="padding:10px"></div>
        </div>
        <div class="ch-panel">
          <div class="ch-cab">
            <div class="ch-ava">A</div>
            <div>
              <div class="ch-cab-nom">Administración</div>
              <div class="ch-cab-sub">Conversación privada — solo tú y el administrador</div>
            </div>
          </div>
          <div class="ch-cuerpo" id="ch-cuerpo"></div>
          <div class="ch-pie">
            <div id="ch-ctx-prev"></div>
            <div class="ch-fila">
              <textarea class="ch-txt" id="ch-txt" rows="1" placeholder="Escribe tu mensaje o reporte…"></textarea>
              <button class="ch-env" id="ch-env" title="Enviar">➤</button>
            </div>
          </div>
        </div>
      </div>`;

    const txt = cont.querySelector('#ch-txt');
    const crecer = () => { txt.style.height='auto'; txt.style.height = Math.min(txt.scrollHeight,130)+'px'; };
    txt.addEventListener('input', crecer);
    txt.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); Usuario.enviar(); }
    });
    cont.querySelector('#ch-env').onclick = () => Usuario.enviar();
  },

  async enviar() {
    const txt = document.getElementById('ch-txt');
    if (!txt) return;
    const v = txt.value.trim();
    const ctx = CH.contexto;
    if (!v && !ctx) return;
    txt.value = ''; txt.style.height = 'auto';
    CH.contexto = null; Usuario.pintarCtx();
    try { await enviar(CH.uid, v, ctx); }
    catch (e) { console.error(e); if (global.toast) toast('No se pudo enviar: ' + e.message, 'error'); }
  },

  pintarCtx() {
    const c = document.getElementById('ch-ctx-prev'); if (!c) return;
    if (!CH.contexto) { c.innerHTML = ''; return; }
    const x = CH.contexto;
    const linea = String(x.resumen || '').split('\n')[0];
    c.innerHTML = `<div class="ch-ctx-prev">
      <div style="flex:1;min-width:0">
        <div class="ch-ctx-tit">${esc(CTX_TITULO[x.tipo] || CTX_TITULO.otro)}</div>
        ${x.imagen ? `<img class="ch-img" style="max-width:190px;margin-top:4px" src="${x.imagen}" alt="">` : ''}
        <div class="ch-ctx-txt" style="margin-top:3px">${esc(x.imagen ? linea : (x.resumen || ''))}</div>
      </div>
      <span class="ch-ctx-prev-x" onclick="AJChat.quitarContexto()" title="Quitar">✕</span></div>`;
  },

  pintarMensajes() {
    const c = document.getElementById('ch-cuerpo'); if (!c) return;
    if (!CH.mensajes.length) {
      c.innerHTML = `<div class="ch-vacio"><div class="ch-vacio-ico">💬</div>
        <div>Aquí hablas directo con la administración.</div>
        <div style="font-size:11.5px">Nadie más ve esta conversación.</div></div>`;
      return;
    }
    const pegado = c.scrollHeight - c.scrollTop - c.clientHeight < 90;
    let ultimoDia = '';
    c.innerHTML = CH.mensajes.map(m => {
      const d = dia(m.ts);
      const sep = d && d !== ultimoDia ? (ultimoDia = d, `<div class="ch-dia">${esc(d)}</div>`) : '';
      const mio = m.de === 'usuario';
      return sep + `<div class="ch-msg ${mio ? 'ch-msg-mio' : 'ch-msg-otro'}">`
        + (m.fijado ? '<span class="ch-fij" title="Fijado — no se archiva">📌</span>' : '')
        + `<span class="ch-msg-acc" onclick="AJChat.fijar('${CH.uid}','${m.id}',${!m.fijado})"
             title="${m.fijado ? 'Quitar de fijados' : 'Fijar — no se archiva'}">📌</span>`
        + (mio ? '' : '<div class="ch-msg-autor">Administración</div>')
        + pintarContexto(m.contexto, COL_HILOS, CH.uid)
        + (m.texto ? esc(m.texto).replace(/\n/g,'<br>') : '')
        + `<div class="ch-msg-pie">${esc(hora(m.ts))}${pintarChulito(m)}</div></div>`;
    }).join('');
    if (pegado) c.scrollTop = c.scrollHeight;
    cargarImagenes();
  },

  pintarAnuncios() {
    const c = document.getElementById('ch-anuncios'); if (!c) return;
    if (!CH.anuncios.length) {
      c.innerHTML = `<div style="color:var(--text2);font-size:12px;text-align:center;padding:20px 8px">
        Todavía no hay anuncios.</div>`;
    } else {
      c.innerHTML = CH.anuncios.map(a => `<div class="ch-an">
        <div class="ch-an-cab">
          ${a.fijado ? '<span class="ch-an-pub">📌 Importante</span>' : ''}
          ${a.origenOperador ? `<span class="ch-an-pub">📢 ${esc(a.autorNombre || 'Un compañero')}</span>` : ''}
          <span class="ch-an-fec">${esc(hace(a.ts))}</span>
        </div>
        ${pintarContexto(a.contexto, COL_ANUNCIOS, a.id)}
        ${a.texto ? `<div class="ch-an-txt">${esc(a.texto).replace(/\n/g,'<br>')}</div>` : ''}
      </div>`).join('');
      cargarImagenes();
    }
    Usuario.pintarFranja();
    Usuario.pintarModal();
  },

  // ── La ventana flotante ───────────────────────────────────────────────
  // Todo anuncio sin leer se muestra al entrar, uno detrás de otro. La
  // diferencia entre importante y normal se mantiene, y es a propósito:
  //
  //   · Importante  → no se puede cerrar. Solo sale con «Entendido».
  //   · Normal      → se cierra con la ✕ o con Escape.
  //
  // Si todo bloqueara, en dos semanas cerrarían sin leer por reflejo y el
  // anuncio importante dejaría de significar algo.

  pintarModal() {
    if (_modalAbierto) return;
    const desde = Date.now() - DIAS_MODAL * 86400 * 1000;

    let pend = CH.anuncios
      .filter(a => !(a.leidoPor || {})[CH.uid])
      // Un operador nuevo no puede recibir de golpe todos los anuncios de la
      // historia. Lo viejo se queda en la lista de Mensajes, sin ventana.
      .filter(a => ms(a.ts) >= desde || a.fijado);

    // Ya estando adentro, solo interrumpe lo importante. Un aviso de rutina
    // que aparece encima mientras están registrando una apuesta se cierra sin
    // leer, y de paso enseña a cerrar sin leer.
    if (!_primeraTanda) pend = pend.filter(a => a.fijado);
    _primeraTanda = false;

    pend.sort((a,b) => ms(a.ts) - ms(b.ts));        // el más viejo primero
    if (!pend.length) return;
    Usuario.mostrarModal(pend, 0);
  },

  mostrarModal(cola, i) {
    const a = cola[i];
    if (!a) { _modalAbierto = false; return; }
    _modalAbierto = true;

    const previo = document.getElementById('ch-modal');
    if (previo) previo.remove();

    const imp = !!a.fijado;
    const capa = document.createElement('div');
    capa.className = 'ch-modal'; capa.id = 'ch-modal';
    capa.innerHTML = `
      <div class="ch-modal-caja ${imp ? 'ch-modal-imp' : ''}">
        <div class="ch-modal-cab">
          <div class="ch-modal-ico">${imp ? '📌' : (a.origenOperador ? '📢' : '📢')}</div>
          <div>
            <div class="ch-modal-tit">${imp ? 'Anuncio importante' : (a.origenOperador ? 'Compartido por un compañero' : 'Anuncio del ecosistema')}</div>
            <div class="ch-modal-sub">${esc(a.autorNombre || 'Administración')} · ${esc(hace(a.ts))}</div>
          </div>
          ${imp ? '' : '<button class="ch-modal-x" title="Cerrar">✕</button>'}
        </div>
        <div class="ch-modal-cuerpo">
          ${pintarContexto(a.contexto, COL_ANUNCIOS, a.id)}
          ${a.texto ? esc(a.texto).replace(/\n/g,'<br>') : ''}
        </div>
        <div class="ch-modal-pie">
          <span class="ch-modal-cuenta">${cola.length > 1 ? (i+1) + ' de ' + cola.length : ''}</span>
          <button class="ch-modal-ok">${imp ? 'Entendido' : (i + 1 < cola.length ? 'Siguiente' : 'Entendido')}</button>
        </div>
      </div>`;

    const siguiente = () => {
      AJChat.confirmarAnuncio(a.id);              // queda marcado como leído
      capa.remove();
      _modalAbierto = false;
      Usuario.mostrarModal(cola, i + 1);
    };
    const cerrarTodo = () => {
      cola.slice(i).forEach(x => { if (!x.fijado) AJChat.confirmarAnuncio(x.id); });
      capa.remove(); _modalAbierto = false;
      const quedan = cola.slice(i).filter(x => x.fijado);
      if (quedan.length) Usuario.mostrarModal(quedan, 0);   // los importantes siguen
    };

    capa.querySelector('.ch-modal-ok').onclick = siguiente;
    const x = capa.querySelector('.ch-modal-x');
    if (x) x.onclick = cerrarTodo;
    if (!imp) {
      capa.onclick = e => { if (e.target === capa) cerrarTodo(); };
      document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape' && document.body.contains(capa)) {
          cerrarTodo(); document.removeEventListener('keydown', esc);
        }
      });
    }
    document.body.appendChild(capa);
    cargarImagenes();
  },

  // El anuncio fijado que todavía no ha confirmado: franja arriba del portal
  pintarFranja() {
    const pend = CH.anuncios.find(a => a.fijado && !(a.leidoPor || {})[CH.uid]);
    let f = document.getElementById('ch-franja');
    if (!pend) { if (f) f.remove(); return; }
    if (!f) {
      f = document.createElement('div');
      f.id = 'ch-franja'; f.className = 'ch-fijado';
      const app = document.getElementById('app') || document.body;
      const hdr = app.querySelector('header');
      hdr && hdr.nextSibling ? app.insertBefore(f, hdr.nextSibling) : app.insertBefore(f, app.firstChild);
    }
    f.innerHTML = `<div class="ch-fijado-ico">📌</div>
      <div class="ch-fijado-txt"><div class="ch-fijado-tit">Anuncio importante</div>${esc(pend.texto).replace(/\n/g,'<br>')}</div>
      <button class="ch-fijado-ok" onclick="AJChat.confirmarAnuncio('${pend.id}')">Entendido</button>`;
  },

  pintarGlobo() {
    const n = (CH.hilo || {}).noLeidosUsuario || 0;
    if (global.AJChatGlobo) global.AJChatGlobo(n);
    const t = document.getElementById('tab-mensajes');
    if (t) {
      const base = '💬 Mensajes';
      t.innerHTML = n > 0 ? `${base}<span class="ch-nav-glob">${n > 99 ? '99+' : n}</span>` : base;
    }
  },

  pintar() { Usuario.pintarMensajes(); Usuario.pintarGlobo(); }
};

/* ══════════════════════════════════════════════════════════════════════════
   LADO ADMINISTRADOR
   ══════════════════════════════════════════════════════════════════════════ */

const Admin = {

  montar(sel) {
    const cont = document.querySelector(sel);
    if (!cont) return;
    cont.innerHTML = `
      <div class="ch-wrap">
        <div class="ch-lista">
          <div class="ch-lista-cab">Conversaciones</div>
          <div class="ch-lista-scroll">
            <div class="ch-item" id="ch-item-anuncios" onclick="AJChat.verAnuncios()">
              <div class="ch-ava" style="background:linear-gradient(135deg,#f0a050,#d88020)">📢</div>
              <div class="ch-item-txt">
                <div class="ch-item-nom">Anuncios del ecosistema</div>
                <div class="ch-item-ult">Publicar un aviso a todos</div>
              </div>
            </div>
            <div id="ch-hilos"></div>
          </div>
        </div>
        <div class="ch-panel" id="ch-panel"></div>
      </div>`;
    Admin.verAnuncios();
  },

  pintarHilos() {
    const c = document.getElementById('ch-hilos'); if (!c) return;
    const orden = [...CH.hilos].sort((a,b) => ms(b.ultimoTs) - ms(a.ultimoTs));
    if (!orden.length) {
      c.innerHTML = `<div style="padding:18px 12px;color:var(--text2);font-size:12px;text-align:center">
        Nadie ha escrito todavía.</div>`;
      return;
    }
    c.innerHTML = orden.map(h => {
      const n = h.noLeidosAdmin || 0;
      const ini = (h.nombre || '?').trim().charAt(0).toUpperCase();
      const caj = h.rol === 'cajero';
      return `<div class="ch-item ${CH.hiloUid === h.uid ? 'act' : ''}" onclick="AJChat.abrirHilo('${h.uid}')">
        <div class="ch-ava ${caj ? 'ch-ava-caj' : ''}">${esc(ini)}</div>
        <div class="ch-item-txt">
          <div class="ch-item-nom">
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(h.nombre || h.uid)}</span>
            <span class="ch-item-fec">${esc(hace(h.ultimoTs))}</span>
          </div>
          <div class="ch-item-ult">
            <span style="opacity:.7">${caj ? '🏦' : '🎯'} ${esc(h.oficina || (caj ? 'Cajero' : 'Operador'))}</span>
          </div>
          <div class="ch-item-ult" style="display:flex;gap:6px;align-items:center">
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${
              (h.ultimoDe === 'admin' ? 'Tú: ' : '') + esc(h.ultimoTexto || '')}</span>
            ${n > 0 ? `<span class="ch-glob">${n > 99 ? '99+' : n}</span>` : ''}
          </div>
        </div>
      </div>`;
    }).join('');
  },

  async abrirHilo(uid) {
    CH.vista = 'chat'; CH.hiloUid = uid; CH.contexto = null; CH.mensajes = [];
    Admin.soltarHilo();
    const h = CH.hilos.find(x => x.uid === uid) || {};
    const caj = h.rol === 'cajero';
    const p = document.getElementById('ch-panel');
    p.innerHTML = `
      <div class="ch-cab">
        <div class="ch-ava ${caj ? 'ch-ava-caj' : ''}">${esc((h.nombre||'?').charAt(0).toUpperCase())}</div>
        <div style="flex:1">
          <div class="ch-cab-nom">${esc(h.nombre || uid)}</div>
          <div class="ch-cab-sub">${caj ? 'Cajero' : 'Operador'}${h.oficina ? ' · ' + esc(h.oficina) : ''}</div>
        </div>
        <button class="btn btn-sm" style="background:var(--bg3);border:1px solid var(--border);color:var(--text2);border-radius:7px;padding:6px 11px;font-size:11.5px;cursor:pointer"
          onclick="AJChat.verArchivo('${uid}')">🗄 Archivo</button>
      </div>
      <div class="ch-cuerpo" id="ch-cuerpo"></div>
      <div class="ch-pie">
        <div class="ch-fila">
          <textarea class="ch-txt" id="ch-txt" rows="1" placeholder="Responder a ${esc(h.nombre||'')}…"></textarea>
          <button class="ch-env" id="ch-env" title="Enviar">➤</button>
        </div>
      </div>`;

    const txt = p.querySelector('#ch-txt');
    txt.addEventListener('input', () => { txt.style.height='auto'; txt.style.height=Math.min(txt.scrollHeight,130)+'px'; });
    txt.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); Admin.enviar(); }
    });
    p.querySelector('#ch-env').onclick = () => Admin.enviar();

    CH._hiloOff = [
      escucharHilo(uid, () => { Admin.pintarMensajes(); if (CH.abierto) marcarLeido(uid); }),
      escucharMensajes(uid, Admin.pintarMensajes)
    ];
    Admin.pintarHilos();
  },

  soltarHilo() { (CH._hiloOff || []).forEach(f => { try { f(); } catch(_){} }); CH._hiloOff = []; },

  async enviar() {
    const txt = document.getElementById('ch-txt'); if (!txt || !CH.hiloUid) return;
    const v = txt.value.trim(); if (!v) return;
    txt.value = ''; txt.style.height = 'auto';
    try { await enviar(CH.hiloUid, v, null); }
    catch (e) { console.error(e); if (global.toast) toast('No se pudo enviar: ' + e.message, 'error'); }
  },

  pintarMensajes() {
    if (CH.vista !== 'chat') return;
    const c = document.getElementById('ch-cuerpo'); if (!c) return;
    if (!CH.mensajes.length) {
      c.innerHTML = `<div class="ch-vacio"><div class="ch-vacio-ico">💬</div>
        <div>Sin mensajes en esta conversación.</div></div>`;
      return;
    }
    const pegado = c.scrollHeight - c.scrollTop - c.clientHeight < 90;
    let ultimoDia = '';
    c.innerHTML = CH.mensajes.map(m => {
      const d = dia(m.ts);
      const sep = d && d !== ultimoDia ? (ultimoDia = d, `<div class="ch-dia">${esc(d)}</div>`) : '';
      const mio = m.de === 'admin';
      return sep + `<div class="ch-msg ${mio ? 'ch-msg-mio' : 'ch-msg-otro'}">`
        + (m.fijado ? '<span class="ch-fij" title="Fijado — no se archiva">📌</span>' : '')
        + `<span class="ch-msg-acc" onclick="AJChat.fijar('${CH.hiloUid}','${m.id}',${!m.fijado})"
             title="${m.fijado ? 'Quitar de fijados' : 'Fijar — no se archiva'}">📌</span>`
        + (mio ? '' : `<div class="ch-msg-autor">${esc(m.autorNombre || '')}</div>`)
        + pintarContexto(m.contexto, COL_HILOS, CH.hiloUid)
        + (m.texto ? esc(m.texto).replace(/\n/g,'<br>') : '')
        + `<div class="ch-msg-pie">${esc(hora(m.ts))}${pintarChulito(m)}</div></div>`;
    }).join('');
    if (pegado) c.scrollTop = c.scrollHeight;
    cargarImagenes();
  },

  /* ── anuncios ── */

  verAnuncios() {
    CH.vista = 'anuncios'; CH.hiloUid = ''; Admin.soltarHilo();
    const p = document.getElementById('ch-panel');
    p.innerHTML = `
      <div class="ch-cab">
        <div class="ch-ava" style="background:linear-gradient(135deg,#f0a050,#d88020)">📢</div>
        <div><div class="ch-cab-nom">Anuncios del ecosistema</div>
          <div class="ch-cab-sub">Lo que publiques aquí lo leen todos los que elijas</div></div>
      </div>
      <div class="ch-cuerpo" style="gap:0">
        <div class="ch-form" style="border-bottom:1px solid var(--border);padding-bottom:16px;margin-bottom:16px">
          <label>Mensaje</label>
          <textarea id="ch-an-txt" placeholder="Ej: En unos días vamos a hacer un cuadre del sistema. Tengan todo anotado y al día, como si fuera un cierre de mes."></textarea>
          <label>Quién lo ve</label>
          <select id="ch-an-pub">
            <option value="todos">Todos — operadores y cajeros</option>
            <option value="operadores">Solo los operadores</option>
            <option value="cajeros">Solo los cajeros</option>
          </select>
          <label class="ch-check">
            <input type="checkbox" id="ch-an-fij">
            <span>Fijar como importante
              <div class="ch-check-sub">Se queda arriba de su pantalla hasta que toquen «Entendido», y tú ves quién ya lo leyó.</div></span>
          </label>
          <button class="ch-fijado-ok" style="margin-top:14px;padding:9px 20px" onclick="AJChat.publicar()">📢 Publicar</button>
        </div>
        <div id="ch-an-lista"></div>
      </div>`;
    Admin.pintarAnuncios();
  },

  pintarAnuncios() {
    if (CH.vista !== 'anuncios') return;
    const c = document.getElementById('ch-an-lista'); if (!c) return;
    if (!CH.anuncios.length) {
      c.innerHTML = `<div style="color:var(--text2);font-size:12px;text-align:center;padding:20px">
        Todavía no has publicado ningún anuncio.</div>`;
      return;
    }
    const NOMBRE = { todos:'Todos', operadores:'Operadores', cajeros:'Cajeros' };
    c.innerHTML = CH.anuncios.map(a => {
      const publico = a.publico || 'todos';
      const total = Admin.destinatarios(publico).length;
      const leyeron = Object.keys(a.leidoPor || {}).length;
      return `<div class="ch-an">
        <div class="ch-an-cab">
          <span class="ch-an-pub">${a.fijado ? '📌 ' : ''}${esc(NOMBRE[publico] || publico)}</span>
          ${a.origenOperador ? `<span class="ch-an-pub">📢 ${esc(a.autorNombre || 'Operador')}</span>` : ''}
          <span class="ch-an-fec">${esc(hace(a.ts))}</span>
        </div>
        ${pintarContexto(a.contexto, COL_ANUNCIOS, a.id)}
        ${a.texto ? `<div class="ch-an-txt">${esc(a.texto).replace(/\n/g,'<br>')}</div>` : ''}
        <div class="ch-an-pie">
          <span class="ch-an-cont" onclick="AJChat.verQuien('${a.id}')">
            👁 Leído por ${leyeron} de ${total}${leyeron < total ? ' — ver quién falta' : ''}</span>
          <span style="margin-left:auto;font-size:11px;color:var(--text2);cursor:pointer"
            onclick="AJChat.borrarAnuncio('${a.id}')">🗑 Borrar</span>
        </div>
        <div id="ch-quien-${a.id}"></div>
      </div>`;
    }).join('');
    cargarImagenes();
  },

  destinatarios(publico) {
    return CH.personas.filter(p =>
      publico === 'todos' ? true :
      publico === 'operadores' ? p.rol === 'operador' :
      publico === 'cajeros' ? p.rol === 'cajero' : false);
  },

  verQuien(id) {
    const caja = document.getElementById('ch-quien-' + id); if (!caja) return;
    if (caja.innerHTML) { caja.innerHTML = ''; return; }
    const a = CH.anuncios.find(x => x.id === id); if (!a) return;
    const leidos = a.leidoPor || {};
    const lista = Admin.destinatarios(a.publico || 'todos')
      .sort((x,y) => (!!leidos[x.uid] - !!leidos[y.uid]) || String(x.nombre).localeCompare(y.nombre));
    caja.innerHTML = `<div class="ch-quien">` + (lista.length ? lista.map(p =>
      `<div class="ch-quien-fila"><span>${esc(p.nombre)}</span>
       <span class="${leidos[p.uid] ? 'ch-quien-si' : ''}">${
         leidos[p.uid] ? '✓ ' + hace(leidos[p.uid]) : 'sin leer'}</span></div>`).join('')
      : '<div class="ch-quien-fila">Sin destinatarios activos</div>') + `</div>`;
  },

  async publicar() {
    const txt = document.getElementById('ch-an-txt');
    const v = (txt.value || '').trim();
    if (!v) { if (global.toast) toast('Escribe el anuncio primero', 'error'); return; }
    const publico = document.getElementById('ch-an-pub').value;
    const fijado  = document.getElementById('ch-an-fij').checked;
    try {
      await CH.db.collection(COL_ANUNCIOS).add({
        texto: v, publico, fijado,
        autorUid: CH.uid, autorNombre: CH.nombre,
        ts: ahora(), leidoPor: {}
      });
      txt.value = ''; document.getElementById('ch-an-fij').checked = false;
      if (global.toast) toast('📢 Anuncio publicado', 'success');
    } catch (e) { if (global.toast) toast('No se pudo publicar: ' + e.message, 'error'); }
  },

  async borrarAnuncio(id) {
    if (!confirm('¿Borrar este anuncio? Desaparece de todos los portales.')) return;
    try { await CH.db.collection(COL_ANUNCIOS).doc(id).delete(); }
    catch (e) { if (global.toast) toast('No se pudo borrar: ' + e.message, 'error'); }
  },

  /* ── archivo ── */

  async verArchivo(uid) {
    const c = document.getElementById('ch-cuerpo'); if (!c) return;
    c.innerHTML = `<div class="ch-vacio"><div>Abriendo el archivo…</div></div>`;
    try {
      const snap = await CH.db.collection(COL_ARCHIVO).doc(uid).collection('mensajes')
        .orderBy('ts','desc').limit(500).get();
      const msgs = snap.docs.map(d => ({ id:d.id, ...d.data() })).reverse();
      if (!msgs.length) {
        c.innerHTML = `<div class="ch-vacio"><div class="ch-vacio-ico">🗄</div>
          <div>El archivo está vacío.</div>
          <div style="font-size:11.5px">Aquí van los mensajes de más de 30 días.</div>
          <button class="ch-fijado-ok" style="margin-top:10px" onclick="AJChat.abrirHilo('${uid}')">Volver</button></div>`;
        return;
      }
      let ud = '';
      c.innerHTML = `<div style="text-align:center;margin-bottom:10px">
          <span class="ch-dia">🗄 Archivo — ${msgs.length} mensajes</span>
          <button class="ch-fijado-ok" style="margin-left:8px;padding:4px 12px;font-size:11px"
            onclick="AJChat.abrirHilo('${uid}')">Volver a la conversación</button></div>`
        + msgs.map(m => {
          const d = dia(m.ts);
          const sep = d && d !== ud ? (ud = d, `<div class="ch-dia">${esc(d)}</div>`) : '';
          const mio = m.de === 'admin';
          return sep + `<div class="ch-msg ${mio ? 'ch-msg-mio' : 'ch-msg-otro'}">`
            + (mio ? '' : `<div class="ch-msg-autor">${esc(m.autorNombre||'')}</div>`)
            + pintarContexto(m.contexto, COL_HILOS, CH.hiloUid)
            + (m.texto ? esc(m.texto).replace(/\n/g,'<br>') : '')
            + `<div class="ch-msg-pie">${esc(hora(m.ts))}</div></div>`;
        }).join('');
      cargarImagenes();
    } catch (e) {
      c.innerHTML = `<div class="ch-vacio">No se pudo abrir el archivo: ${esc(e.message)}</div>`;
    }
  },

  pintarGlobo() {
    const n = CH.hilos.reduce((s,h) => s + (h.noLeidosAdmin || 0), 0);
    const t = document.getElementById('tab-mensajes');
    if (t) t.innerHTML = n > 0 ? `💬 Mensajes<span class="ch-nav-glob">${n>99?'99+':n}</span>` : '💬 Mensajes';
    if (global.AJChatGlobo) global.AJChatGlobo(n);
  }
};

/* ══════════════════════════════════════════════════════════════════════════
   ARRANQUE
   ══════════════════════════════════════════════════════════════════════════ */

global.AJChat = {

  // Operador y cajero
  iniciarUsuario(o) {
    inyectarEstilos();
    Object.assign(CH, {
      db:o.db, auth:o.auth, uid:o.uid, nombre:o.nombre || '',
      rol:o.rol || 'operador', oficina:o.oficina || '', esAdmin:false
    });
    if (o.montarEn) Usuario.montar(o.montarEn);

    // El hilo se crea solo la primera vez, sin pisar los contadores
    refHilo(CH.uid).set({
      uid: CH.uid, nombre: CH.nombre, rol: CH.rol, oficina: CH.oficina
    }, { merge:true }).catch(()=>{});

    const publicos = ['todos', CH.rol === 'cajero' ? 'cajeros' : 'operadores'];
    CH._off = [
      escucharHilo(CH.uid, Usuario.pintar),
      escucharMensajes(CH.uid, Usuario.pintar),
      escucharAnuncios(publicos, Usuario.pintarAnuncios)
    ];
  },

  // Administrador
  iniciarAdmin(o) {
    inyectarEstilos();
    Object.assign(CH, {
      db:o.db, auth:o.auth, uid:o.uid, nombre:o.nombre || 'Administración', esAdmin:true
    });
    if (o.montarEn) Admin.montar(o.montarEn);

    CH._off = [
      CH.db.collection(COL_HILOS).onSnapshot(snap => {
        CH.hilos = snap.docs.map(d => ({ uid:d.id, ...d.data() }));
        Admin.pintarHilos(); Admin.pintarGlobo();
        if (CH.hiloUid) {                       // refrescar el encabezado del hilo abierto
          const h = CH.hilos.find(x => x.uid === CH.hiloUid);
          if (h) CH.hilo = Object.assign({}, CH.hilo, h);
        }
      }, e => console.warn('hilos:', e.message)),

      escucharAnuncios(null, Admin.pintarAnuncios),

      // Los destinatarios posibles, para el contador "leído por X de Y"
      CH.db.collection('admin_usuarios').onSnapshot(snap => {
        CH.personas = snap.docs.map(d => d.data())
          .filter(u => u.uid && u.rol !== 'admin' && (u.estado||'activo').toLowerCase() !== 'inactivo')
          .map(u => ({ uid:u.uid, nombre:u.nombre || u.email || u.uid, rol:u.rol || 'operador' }));
        Admin.pintarAnuncios();
      }, e => console.warn('personas:', e.message))
    ];
  },

  // Avisar que la pantalla de mensajes entró o salió de la vista
  // (de eso depende marcar como leído)
  visible(v) {
    CH.abierto = !!v;
    if (v) {
      const uid = CH.esAdmin ? CH.hiloUid : CH.uid;
      if (uid) marcarLeido(uid);
    }
  },

  /* Reportar con contexto. El portal lo llama desde el botón del objeto:
       AJChat.reportar({ tipo:'cupon', ref:id, resumen:'...' })            */
  reportar(ctx) {
    CH.contexto = ctx || null;
    if (global.AJChatIrAMensajes) global.AJChatIrAMensajes();
    Usuario.pintarCtx();
    setTimeout(() => { const t = document.getElementById('ch-txt'); if (t) t.focus(); }, 120);
  },

  quitarContexto() { CH.contexto = null; Usuario.pintarCtx(); },

  /* Transmitir a todos los operadores. Distinto de reportar(): no navega a
     mensajes ni espera que se escriba algo, manda el anuncio directamente.
     El portal debe confirmar con el operador ANTES de llamar esto — aquí ya
     no hay vuelta atrás. Devuelve una promesa para poder mostrar el toast
     de éxito/error desde donde se llamó. */
  transmitir(ctx) { return transmitir(ctx); },

  /* Manda un mensaje directo al propio hilo, SIN pasar por el compositor
     manual (a diferencia de reportar(), que solo deja el contexto listo
     para que la persona escriba y le dé enviar). Pensado para cosas que el
     portal genera y envía solas, como el informe diario del cajero.
       AJChat.enviarAutomatico('texto...', { tipo:'informeAmc', imagen })  */
  enviarAutomatico(texto, contexto) { return enviar(CH.uid, texto, contexto); },

  // Ver la imagen en grande — un cupón en miniatura no se alcanza a leer
  ampliar(src) {
    const capa = document.createElement('div');
    capa.className = 'ch-lupa';
    capa.innerHTML = '<img src="' + src + '" alt="">';
    capa.onclick = () => capa.remove();
    document.addEventListener('keydown', function cerrar(e) {
      if (e.key === 'Escape') { capa.remove(); document.removeEventListener('keydown', cerrar); }
    });
    document.body.appendChild(capa);
  },

  async confirmarAnuncio(id) {
    try {
      await CH.db.collection(COL_ANUNCIOS).doc(id)
        .update({ ['leidoPor.' + CH.uid]: new Date() });
    } catch (e) { console.warn('confirmar anuncio:', e.message); }
  },

  async fijar(uid, msgId, valor) {
    try {
      await CH.db.collection(COL_HILOS).doc(uid).collection('mensajes').doc(msgId)
        .update({ fijado: !!valor, fijadoPor: CH.nombre });
      if (global.toast) toast(valor ? '📌 Fijado — este mensaje no se archiva' : 'Ya no está fijado', 'success');
    } catch (e) { if (global.toast) toast('No se pudo fijar: ' + e.message, 'error'); }
  },

  abrirHilo: uid => Admin.abrirHilo(uid),
  verAnuncios: () => Admin.verAnuncios(),
  verQuien: id => Admin.verQuien(id),
  publicar: () => Admin.publicar(),
  borrarAnuncio: id => Admin.borrarAnuncio(id),
  verArchivo: uid => Admin.verArchivo(uid),

  soltar() {
    (CH._off || []).forEach(f => { try { f(); } catch(_){} });
    Admin.soltarHilo(); CH._off = [];
  }
};

})(window);
