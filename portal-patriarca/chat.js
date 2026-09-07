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
const COL_TRIXI    = 'patriarca_chat_trixi';   // canal único de oportunidades de Trixi Bot
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
  trixi: [],                // el canal de oportunidades de Trixi Bot
  trixibotActivo: false,    // lado operador: ¿este uid tiene el canal habilitado?
  hilos: [],                // lado admin: todos los hilos
  personas: [],             // lado admin: usuarios activos, para el "X de Y"
  vista: 'chat',            // lado admin: 'chat' | 'anuncios' | 'trixi'
  vistaU: 'chat',           // lado operador: 'chat' | 'anuncios' | 'trixi'
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

// Para el buscador de conversaciones: minúsculas y sin tildes, con un mapa
// explícito en vez de normalize('NFD') + regex de marcas combinadas — ese
// regex necesita caracteres Unicode literales en el código fuente y es fácil
// que se dañe al pasar por herramientas de edición o el minificador.
const _MAPA_ACENTOS = { á:'a', é:'e', í:'i', ó:'o', ú:'u', ñ:'n', ü:'u' };
const norm = s => String(s || '').toLowerCase().replace(/[áéíóúñü]/g, c => _MAPA_ACENTOS[c] || c);

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
.ch-buscar-cont{padding:8px 10px;border-bottom:1px solid var(--border);position:relative}
.ch-buscar{width:100%;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:8px 10px 8px 30px;color:var(--text);font-size:12.5px;font-family:inherit;box-sizing:border-box}
.ch-buscar:focus{outline:none;border-color:var(--green)}
.ch-buscar-ico{position:absolute;left:19px;top:50%;transform:translateY(-50%);font-size:12px;color:var(--text2);pointer-events:none}
.ch-buscar-vacio{padding:22px 12px;color:var(--text2);font-size:12px;text-align:center}
.ch-lista-cab{display:flex;align-items:center;justify-content:space-between;gap:8px}
.ch-webpush-btn{background:var(--bg3);border:1px solid var(--border);border-radius:8px;min-width:26px;height:26px;padding:0 8px;font-size:12px;cursor:pointer;color:var(--text2);display:flex;align-items:center;justify-content:center;gap:4px;flex-shrink:0;white-space:nowrap}
.ch-webpush-btn:hover{border-color:var(--green)}
.ch-webpush-btn.activo{color:var(--green);border-color:var(--green)}
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
.ch-pdf-link{display:flex;align-items:center;gap:8px;margin-top:5px;padding:10px 12px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text);text-decoration:none;font-size:12px;font-weight:600}
.ch-pdf-link:hover{border-color:#4a9eff}
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

/* Botón "← Volver" del panel — solo existe visualmente en celular (ver abajo),
   para regresar de la conversación abierta a la lista de contactos. */
.ch-cab-volver{display:none;background:var(--bg3);border:1px solid var(--border);color:var(--text2);border-radius:8px;width:30px;height:30px;font-size:16px;cursor:pointer;flex-shrink:0;align-items:center;justify-content:center}
.ch-cab-volver:hover{color:var(--text);border-color:var(--green)}

/* En celular, la lista de contactos y la conversación abierta no caben lado a
   lado — en vez de apretarlas una encima de la otra (como pasaba antes),
   se muestra una sola a la vez, estilo WhatsApp: se arranca en la lista, y
   al tocar una conversación esa ocupa toda la ventana con un botón "←" para
   volver. #sec-mensajes.ch-panel-abierto es lo que decide cuál se ve — lo
   agregan/quitan mostrarPanelMovil()/volverListaMovil() (ver más abajo). */
@media(max-width:820px){
  .ch-wrap{flex-direction:column;height:calc(100vh - 190px);min-height:360px}
  .ch-msg{max-width:86%}
  #sec-mensajes .ch-lista{flex:1;min-height:0;max-height:none}
  #sec-mensajes .ch-panel{flex:1;min-height:0}
  #sec-mensajes:not(.ch-panel-abierto) .ch-panel{display:none}
  #sec-mensajes.ch-panel-abierto .ch-lista{display:none}
  #sec-mensajes.ch-panel-abierto .ch-cab-volver{display:flex}
}

/* Burbuja flotante, fija abajo a la derecha en todo el portal */
.ch-globo-flot{position:fixed;right:22px;bottom:22px;width:56px;height:56px;border-radius:50%;background:var(--green);color:#0d0f14;border:none;box-shadow:0 8px 22px rgba(0,0,0,.4);font-size:23px;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:9997;transition:transform .15s}
.ch-globo-flot:hover{transform:scale(1.06)}
.ch-globo-flot.ch-globo-oculto{display:none}
.ch-globo-badge{position:absolute;top:-3px;right:-3px;background:#e05050;color:#fff;border-radius:20px;min-width:19px;height:19px;padding:0 5px;font-size:10.5px;font-weight:700;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 2px var(--bg2)}

/* Botón de cerrar del panel flotante — invisible fuera de ese modo */
.ch-flot-cerrar{display:none;position:absolute;top:10px;right:12px;width:28px;height:28px;border-radius:50%;background:var(--bg3);border:1px solid var(--border);color:var(--text2);font-size:14px;align-items:center;justify-content:center;cursor:pointer;z-index:2}
.ch-flot-cerrar:hover{color:var(--text);border-color:var(--green)}

/* El chat como ventana flotante encima del portal, sin cambiar de pestaña.
   Fondo un poco más claro que el resto del portal (var(--bg3) en vez de
   var(--bg2), que es el mismo tono que usan las tarjetas del Dashboard) y un
   borde con un toque de verde, para que se note de un vistazo que es una
   ventana flotante y no una tarjeta más de la pantalla de atrás. */
#sec-mensajes.ch-flotante{display:flex !important;flex-direction:column;position:fixed !important;right:22px;bottom:90px;left:auto;top:auto;width:min(720px,calc(100vw - 44px));height:min(560px,calc(100vh - 130px));background:var(--bg3);border:1px solid rgba(53,204,47,.35);border-radius:16px;box-shadow:0 26px 70px rgba(0,0,0,.65),0 0 0 1px rgba(53,204,47,.06);z-index:9996;padding:16px;overflow:hidden}
#sec-mensajes.ch-flotante > .sec-header{flex-shrink:0}
#sec-mensajes.ch-flotante > #ch-montar{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}
#sec-mensajes.ch-flotante .ch-flot-cerrar{display:flex}
#sec-mensajes.ch-flotante .ch-wrap{flex:1;height:auto !important;min-height:0}
/* La lista de contactos queda más oscura (como una barra lateral) y el panel
   de la conversación abierta más claro (como la superficie "activa") — así
   se distinguen entre sí, no solo de la ventana flotante. */
#sec-mensajes.ch-flotante .ch-lista{background:var(--bg)}
#sec-mensajes.ch-flotante .ch-panel{background:var(--bg2)}
@media(max-width:820px){
  #sec-mensajes.ch-flotante{right:12px;left:12px;bottom:82px;width:auto;height:min(72vh,600px)}
  /* Dentro de la ventana flotante (ya con una altura fija propia) la lista y
     el panel se reparten con flex el espacio real que hay, no con la medida
     de arriba (calc(100vh - 190px)) pensada para la pestaña de pantalla
     completa — si no, el panel se sale por debajo tapando el fondo. */
  #sec-mensajes.ch-flotante .ch-wrap{flex-direction:column;height:auto !important;min-height:0}
  #sec-mensajes.ch-flotante .ch-lista{width:100%}
}

/* Aviso emergente cuando llega un mensaje nuevo de administración, mientras
   el operador/cajero no lo está viendo en ese momento. Se cierra sola o con
   la X; el globito de la burbuja se queda como recordatorio permanente. */
.ch-toast{position:fixed;right:22px;bottom:96px;width:380px;max-width:calc(100vw - 40px);background:var(--bg2);border:1px solid var(--border);border-left:4px solid var(--green);border-radius:14px;box-shadow:0 18px 46px rgba(0,0,0,.5);padding:18px 18px;z-index:9998;display:flex;gap:14px;align-items:flex-start;cursor:pointer;animation:chToastIn .25s ease}
.ch-toast:hover{border-color:var(--green)}
.ch-toast-ico{width:42px;height:42px;border-radius:50%;background:linear-gradient(135deg,#35CC2F,#24BF62);display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;color:#0d0f14;flex-shrink:0}
.ch-toast-txt{flex:1;min-width:0}
.ch-toast-tit{font-size:15px;font-weight:700;color:var(--text);margin-bottom:4px}
.ch-toast-prev{font-size:14px;color:var(--text2);line-height:1.45;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}
.ch-toast-x{background:none;border:none;color:var(--text2);font-size:19px;cursor:pointer;padding:0 2px;flex-shrink:0;line-height:1}
.ch-toast-x:hover{color:var(--text)}
@keyframes chToastIn{from{opacity:0;transform:translateY(14px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}
@media(max-width:820px){ .ch-toast{right:12px;bottom:86px;width:calc(100vw - 24px)} }

/* Aviso de versión nueva publicada — franja fija arriba de todo el portal */
.ch-banner-ver{position:fixed;top:0;left:0;right:0;z-index:99990;background:linear-gradient(90deg,#2a7fd8,#4a9eff);color:#fff;padding:9px 16px;font-size:12.5px;font-weight:600;display:flex;align-items:center;justify-content:center;gap:14px;flex-wrap:wrap;box-shadow:0 2px 10px rgba(0,0,0,.25)}
.ch-banner-ver button{background:#fff;color:#1a5fb4;border:none;border-radius:7px;padding:5px 14px;font-size:12px;font-weight:700;cursor:pointer}
.ch-banner-ver button:hover{filter:brightness(.96)}
.ch-banner-ver-x{background:none !important;color:#fff !important;opacity:.85;font-size:15px !important;padding:0 4px !important;box-shadow:none}`;

function inyectarEstilos() {
  if (document.getElementById('ch-css')) return;
  const s = document.createElement('style');
  s.id = 'ch-css'; s.textContent = CSS;
  document.head.appendChild(s);
}

/* ── burbuja flotante ───────────────────────────────────────────────────────
   El chat ya vivía en su propia pestaña, al final del menú. Para que se note
   sin tener que ir a buscarlo, se agrega un botón circular fijo abajo a la
   derecha (como WhatsApp/Intercom) que abre el mismo #sec-mensajes de siempre
   pero como ventana flotante encima del portal, sin cambiar de pestaña. La
   pestaña "💬 Chat" del menú se deja donde estaba — sigue funcionando igual. */

function crearGlobo() {
  if (!document.getElementById('ch-globo-flot')) {
    const b = document.createElement('button');
    b.id = 'ch-globo-flot'; b.className = 'ch-globo-flot'; b.title = 'Chat';
    b.innerHTML = '💬<span class="ch-globo-badge" id="ch-globo-badge" style="display:none">0</span>';
    b.onclick = () => toggleFlotante();
    document.body.appendChild(b);
  }
  const sec = document.getElementById('sec-mensajes');
  if (sec && !document.getElementById('ch-flot-cerrar')) {
    const x = document.createElement('button');
    x.id = 'ch-flot-cerrar'; x.className = 'ch-flot-cerrar'; x.title = 'Cerrar';
    x.innerHTML = '✕';
    x.onclick = () => toggleFlotante(false);
    sec.insertBefore(x, sec.firstChild);
  }
}

function actualizarGloboBadge(n) {
  const b = document.getElementById('ch-globo-badge');
  if (!b) return;
  if (n > 0) { b.style.display = 'flex'; b.textContent = n > 99 ? '99+' : n; }
  else b.style.display = 'none';
}

function toggleFlotante(forzar) {
  const sec = document.getElementById('sec-mensajes');
  if (!sec) return;
  const activar = typeof forzar === 'boolean' ? forzar : !sec.classList.contains('ch-flotante');
  sec.classList.toggle('ch-flotante', activar);
  const globo = document.getElementById('ch-globo-flot');
  if (globo) globo.classList.toggle('ch-globo-oculto', activar);
  // Si se cierra el flotante pero la pestaña Chat sigue activa de fondo,
  // no se marca como "cerrado" para efectos de leído.
  if (window.AJChat) AJChat.visible(activar || sec.classList.contains('active'));
}

/* ── navegación estilo WhatsApp en celular ─────────────────────────────────
   En pantalla angosta, la lista de contactos y la conversación abierta no
   caben lado a lado (ver CSS de #sec-mensajes.ch-panel-abierto). Estas dos
   funciones son las que deciden cuál se ve: se llaman desde cada función que
   abre una conversación (mostrarPanelMovil) y desde el botón "←" del panel
   (volverListaMovil). En pantallas anchas la clase no cambia nada — el CSS
   que la usa solo existe dentro de la media query. */
function mostrarPanelMovil() {
  const sec = document.getElementById('sec-mensajes');
  if (sec) sec.classList.add('ch-panel-abierto');
}
function volverListaMovil() {
  const sec = document.getElementById('sec-mensajes');
  if (sec) sec.classList.remove('ch-panel-abierto');
}

/* ── aviso de versión nueva publicada ──────────────────────────────────────
   Las pestañas se quedan abiertas todo el día; el navegador no vuelve a
   pedir el código nuevo hasta que alguien recarga. Cada portal trae de
   entrada su propio sello (window.__BUILD__, lo inyecta construir.js en el
   <head>) y esto lo compara cada tanto contra version.json — un archivo
   chiquito, sin caché, que sí se vuelve a pedir en cada revisión. Si no
   coinciden, alguien publicó una versión más nueva mientras esa pestaña
   seguía abierta: se avisa arriba, sin forzar la recarga — que decida cuándo. */

let _verChequeoTimer = null;

function iniciarChequeoVersion() {
  if (_verChequeoTimer || typeof window.__BUILD__ !== 'number') return;
  const revisar = () => {
    fetch('/version.json?_=' + Date.now(), { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d && d.v && d.v !== window.__BUILD__) {
          mostrarBannerVersion();
          clearInterval(_verChequeoTimer); _verChequeoTimer = null;   // ya se avisó, no hace falta seguir preguntando
        }
      }).catch(() => {});
  };
  setTimeout(revisar, 30000);                       // primera revisión a los 30s de abrir
  _verChequeoTimer = setInterval(revisar, 5 * 60000); // luego cada 5 minutos
}

function mostrarBannerVersion() {
  if (document.getElementById('ch-banner-ver')) return;
  const b = document.createElement('div');
  b.id = 'ch-banner-ver'; b.className = 'ch-banner-ver';
  b.innerHTML = `
    <span>🔄 Hay una actualización del sistema disponible.</span>
    <button onclick="location.reload()">Actualizar ahora</button>
    <button class="ch-banner-ver-x" title="Recordar más tarde" onclick="this.parentElement.remove()">✕</button>`;
  document.body.appendChild(b);
}

/* ── notificaciones push del administrador, vía Web Push estándar ─────────
   Sin pasar por Apple Developer ni por la app nativa: cualquier navegador
   que soporte Service Worker + Push (Chrome, y Safari en iPhone SIEMPRE que
   la página esté agregada a la pantalla de Inicio) puede suscribirse. La
   llave pública VAPID no es secreta, viaja tal cual al navegador; la privada
   solo vive en functions/notificaciones.js, nunca acá. */

const VAPID_PUBLICA = 'BNKCUmJbV1mD-59zIg0DSOmk9g_uFwEXKIivRTQfUb6Tie8IjVhwnKsoBbbS0_g4bQrbUNxHTSpsbqiJsG39FCc';

function _base64UrlAUint8Array(base64) {
  const relleno = '='.repeat((4 - base64.length % 4) % 4);
  const normal = (base64 + relleno).replace(/-/g, '+').replace(/_/g, '/');
  const cruda = atob(normal);
  const salida = new Uint8Array(cruda.length);
  for (let i = 0; i < cruda.length; i++) salida[i] = cruda.charCodeAt(i);
  return salida;
}

async function estadoWebPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'no-soportado';
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return 'inactivo';
    const sub = await reg.pushManager.getSubscription();
    return sub ? 'activo' : 'inactivo';
  } catch (e) { return 'inactivo'; }
}

async function activarWebPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    alert('Este navegador no soporta notificaciones.\n\nEn iPhone: abre esta página en Safari, toca "Compartir" → "Agregar a Inicio", y ábrela desde ese ícono (no desde la pestaña normal de Safari) — ahí sí funciona.');
    return;
  }
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    const permiso = await Notification.requestPermission();
    if (permiso !== 'granted') {
      if (global.toast) toast('No diste permiso de notificaciones — no se pudo activar.', 'error');
      return;
    }
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: _base64UrlAUint8Array(VAPID_PUBLICA)
      });
    }
    const uid = CH.uid || (CH.auth && CH.auth.currentUser && CH.auth.currentUser.uid);
    if (!uid || !CH.db) return;
    await CH.db.collection('admin_webpush_subs').doc(uid).set(
      Object.assign(sub.toJSON(), { actualizado: ahora() }),
      { merge: true }
    );
    if (global.toast) toast('🔔 Notificaciones activadas en este dispositivo', 'success');
    Admin.actualizarBotonWebPush();
  } catch (e) {
    if (global.toast) toast('No se pudo activar: ' + (e.message || e), 'error');
    else alert('No se pudo activar: ' + (e.message || e));
  }
}

// El número rojo sobre el ícono de la PWA: se limpia solo al abrir/enfocar
// la app (no hace falta que el admin toque nada). Si el navegador no
// soporta la Badging API (Safari fuera de una PWA instalada, por ejemplo)
// esto simplemente no hace nada — no rompe el resto del chat.
let _badgeYaLimpio = false;
function limpiarBadgePush() {
  if (_badgeYaLimpio) return;
  _badgeYaLimpio = true;
  try { if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {}); } catch (e) {}
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ tipo: 'limpiarBadge' });
    }
  } catch (e) {}
}
function iniciarBadgePush() {
  if (!('setAppBadge' in navigator)) return;
  limpiarBadgePush();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { _badgeYaLimpio = false; limpiarBadgePush(); }
  });
}

/* ── aviso emergente de mensaje nuevo (solo lado operador/cajero) ─────────── */
// Una tarjeta genérica: se reutiliza tanto para un mensaje de Administración
// como para una oportunidad de Trixi Bot — mismo look, mismo tiempo en
// pantalla, cada una con su ícono/título/acción al hacer clic.

let _toastMsgTimer = null;

function mostrarToast({ ico, tit, texto, alClic }) {
  let t = document.getElementById('ch-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'ch-toast'; t.className = 'ch-toast';
    document.body.appendChild(t);
  }
  t.innerHTML = `
    <div class="ch-toast-ico">${ico}</div>
    <div class="ch-toast-txt">
      <div class="ch-toast-tit"></div>
      <div class="ch-toast-prev"></div>
    </div>
    <button class="ch-toast-x" title="Cerrar">✕</button>`;
  t.querySelector('.ch-toast-tit').textContent = tit;
  t.querySelector('.ch-toast-prev').textContent = texto;   // por texto, no por HTML: evita inyección
  t.querySelector('.ch-toast-x').onclick = e => { e.stopPropagation(); cerrarToastMensaje(); };
  t.onclick = () => { cerrarToastMensaje(); alClic(); };
  clearTimeout(_toastMsgTimer);
  _toastMsgTimer = setTimeout(cerrarToastMensaje, 13000);
}

function mostrarToastMensaje(m) {
  mostrarToast({
    ico: 'A', tit: '📩 Administración',
    texto: (m.texto || '').trim() || '📎 Envió un adjunto',
    alClic: () => toggleFlotante(true)
  });
}

function mostrarToastTrixi(ev) {
  const texto = (ev.contexto && ev.contexto.resumen) || ev.texto || 'Nueva oportunidad detectada';
  mostrarToast({
    ico: '🎰', tit: '🎰 Trixi Bot',
    texto,
    alClic: () => {
      toggleFlotante(true);
      if (window.AJChat && AJChat.verUsuario) AJChat.verUsuario('trixi');
    }
  });
}

function cerrarToastMensaje() {
  clearTimeout(_toastMsgTimer);
  const t = document.getElementById('ch-toast');
  if (t) t.remove();
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
  informePdf: 'Informe (PDF)',
  trixiOportunidad: 'Oportunidad de Trixi Bot',
  otro:       'Referencia'
};

// Tipos de contexto cuyo "imagenRef" en realidad guarda un PDF (dataURI
// application/pdf) en vez de una imagen — se pintan como enlace de descarga,
// no como <img>.
const CTX_ES_PDF = { informePdf: true };

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
    const esPdf = !!CTX_ES_PDF[c.tipo];
    // tipo/ref/claveMercado viajan como data-* para que un click sepa, sin
    // volver a tocar el servidor, si esta tarjeta se puede montar en Trixi.
    const datos = `data-tipo="${esc(c.tipo||'')}" data-ref="${esc(c.ref||'')}" data-clave="${esc(c.claveMercado||'')}"`;
    let cuerpo;
    if (cache) {
      cuerpo = esPdf
        ? `<a class="ch-pdf-link" href="${cache}" target="_blank" download="${esc(c.nombreArchivo||'informe.pdf')}">📄 Abrir / descargar PDF</a>`
        : `<img class="ch-img" src="${cache}" alt="${titulo}" ${datos} onclick="AJChat.tocarTarjeta(this)">`;
    } else {
      cuerpo = `<div class="ch-img-cargando" data-img="${esc(c.imagenRef)}" ${datos}
           data-col="${esc(coleccion)}" data-doc="${esc(docId||'')}" data-pdf="${esPdf?'1':''}" data-nombre="${esc(c.nombreArchivo||'informe.pdf')}">Cargando ${esPdf?'PDF':'imagen'}…</div>`;
    }
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
      if (!datos) { el.textContent = `El ${el.dataset.pdf === '1' ? 'archivo' : 'imagen'} ya no está disponible`; return; }
      _imgCache.set(clave, datos);
      if (el.dataset.pdf === '1') {
        const a = document.createElement('a');
        a.className = 'ch-pdf-link';
        a.href = datos; a.target = '_blank';
        a.download = el.dataset.nombre || 'informe.pdf';
        a.textContent = '📄 Abrir / descargar PDF';
        el.replaceWith(a);
        return;
      }
      const img = document.createElement('img');
      img.className = 'ch-img'; img.src = datos;
      img.dataset.tipo = el.dataset.tipo || ''; img.dataset.ref = el.dataset.ref || ''; img.dataset.clave = el.dataset.clave || '';
      img.onclick = () => AJChat.tocarTarjeta(img);
      el.replaceWith(img);
    } catch (e) { el.textContent = 'No se pudo cargar el archivo'; }
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

// El canal de Trixi Bot: un documento por oportunidad, lo escribe solo la
// función de vigilancia (nunca una persona), así que aquí no hay nada que
// publicar — solo escuchar.
function escucharTrixi(alPintar) {
  return CH.db.collection(COL_TRIXI).orderBy('ts', 'desc').limit(60)
    .onSnapshot(snap => {
      CH.trixi = snap.docs.map(d => ({ id:d.id, ...d.data() }));
      alPintar();
    }, e => console.warn('trixi:', e.message));
}

// Feed de solo lectura, compartido por el canal de Trixi Bot en los dos
// lados (operador y administrador) y por la vista de Anuncios del operador.
// Es la misma tarjeta '.ch-an' que ya se usaba para anuncios, sin el pie de
// "leído por X de Y" que solo tiene sentido cuando quien la ve es el propio
// administrador que la publicó.
function pintarFeed(contenedorId, lista, coleccion, vacio) {
  const c = document.getElementById(contenedorId); if (!c) return;
  if (!lista.length) {
    c.innerHTML = `<div class="ch-vacio"><div class="ch-vacio-ico">📭</div><div>${esc(vacio)}</div></div>`;
    return;
  }
  c.innerHTML = lista.map(a => `<div class="ch-an">
    <div class="ch-an-cab">
      ${a.fijado ? '<span class="ch-an-pub">📌 Importante</span>' : ''}
      <span class="ch-an-fec">${esc(hace(a.ts))}</span>
    </div>
    ${pintarContexto(a.contexto, coleccion, a.id)}
    ${a.texto ? `<div class="ch-an-txt">${esc(a.texto).replace(/\n/g,'<br>')}</div>` : ''}
  </div>`).join('');
  cargarImagenes();
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

  // La lista de la izquierda ahora es una lista de conversaciones de verdad
  // (como la del administrador), no un panel fijo. Administración siempre
  // está; Anuncios también; Trixi Bot solo aparece si este uid lo tiene
  // habilitado — el operador ni se entera de que existe si no le toca.
  montar(sel) {
    const cont = document.querySelector(sel);
    if (!cont) return;
    cont.innerHTML = `
      <div class="ch-wrap">
        <div class="ch-lista">
          <div class="ch-lista-cab">Conversaciones</div>
          <div class="ch-lista-scroll" id="ch-u-lista"></div>
        </div>
        <div class="ch-panel" id="ch-panel"></div>
      </div>`;
    CH.vistaU = 'chat';
    Usuario.pintarLista();
    Usuario.verAdministracion();
  },

  pintarLista() {
    const c = document.getElementById('ch-u-lista'); if (!c) return;
    const nAdmin = (CH.hilo || {}).noLeidosUsuario || 0;
    const filas = [
      { key:'chat', icono:'A', fondo:'', nombre:'Administración', sub:'Conversación privada', badge:nAdmin },
      { key:'anuncios', icono:'📢', fondo:'background:linear-gradient(135deg,#f0a050,#d88020)', nombre:'Anuncios del ecosistema', sub:'Avisos de la administración', badge:0 }
    ];
    if (CH.trixibotActivo) filas.push({ key:'trixi', icono:'🎰', fondo:'background:linear-gradient(135deg,#35CC2F,#24BF62)', nombre:'Trixi Bot', sub:'Oportunidades detectadas', badge:0 });
    c.innerHTML = filas.map(f => `<div class="ch-item ${CH.vistaU===f.key?'act':''}" onclick="AJChat.verUsuario('${f.key}')">
      <div class="ch-ava" style="${f.fondo}">${f.icono}</div>
      <div class="ch-item-txt">
        <div class="ch-item-nom"><span>${esc(f.nombre)}</span></div>
        <div class="ch-item-ult">${f.badge>0 ? `<span class="ch-glob">${f.badge>99?'99+':f.badge}</span> ` : ''}${esc(f.sub)}</div>
      </div>
    </div>`).join('');
  },

  // Llamado siempre desde un clic real (lista de conversaciones) — por eso
  // acá sí se pasa siempre al panel en celular, a diferencia de
  // verAdministracion(), que montar() también llama sola al abrir el chat.
  ver(vista) {
    if (vista === 'trixi' && !CH.trixibotActivo) return;
    if (vista === 'anuncios') Usuario.verAnuncios();
    else if (vista === 'trixi') Usuario.verTrixiPanel();
    else Usuario.verAdministracion();
    mostrarPanelMovil();
  },

  verAdministracion() {
    CH.vistaU = 'chat';
    Usuario.pintarLista();
    const p = document.getElementById('ch-panel'); if (!p) return;
    p.innerHTML = `
      <div class="ch-cab">
        <button class="ch-cab-volver" onclick="AJChat.volverListaMovil()" title="Volver a la lista">←</button>
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
      </div>`;

    const txt = p.querySelector('#ch-txt');
    const crecer = () => { txt.style.height='auto'; txt.style.height = Math.min(txt.scrollHeight,130)+'px'; };
    txt.addEventListener('input', crecer);
    txt.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); Usuario.enviar(); }
    });
    p.querySelector('#ch-env').onclick = () => Usuario.enviar();
    Usuario.pintarCtx();
    Usuario.pintarMensajes();
    if (CH.abierto) marcarLeido(CH.uid);
  },

  verAnuncios() {
    CH.vistaU = 'anuncios';
    Usuario.pintarLista();
    const p = document.getElementById('ch-panel'); if (!p) return;
    p.innerHTML = `
      <div class="ch-cab">
        <button class="ch-cab-volver" onclick="AJChat.volverListaMovil()" title="Volver a la lista">←</button>
        <div class="ch-ava" style="background:linear-gradient(135deg,#f0a050,#d88020)">📢</div>
        <div><div class="ch-cab-nom">Anuncios del ecosistema</div>
          <div class="ch-cab-sub">Avisos de la administración para todo el equipo</div></div>
      </div>
      <div class="ch-cuerpo" id="ch-feed-anuncios"></div>`;
    Usuario.pintarAnunciosFeed();
  },

  verTrixiPanel() {
    if (!CH.trixibotActivo) return;
    CH.vistaU = 'trixi';
    Usuario.pintarLista();
    const p = document.getElementById('ch-panel'); if (!p) return;
    p.innerHTML = `
      <div class="ch-cab">
        <button class="ch-cab-volver" onclick="AJChat.volverListaMovil()" title="Volver a la lista">←</button>
        <div class="ch-ava" style="background:linear-gradient(135deg,#35CC2F,#24BF62)">🎰</div>
        <div><div class="ch-cab-nom">Trixi Bot</div>
          <div class="ch-cab-sub">Oportunidades que el bot va encontrando — toca una para editarla</div></div>
      </div>
      <div class="ch-cuerpo" id="ch-feed-trixi"></div>`;
    Usuario.pintarTrixiFeed();
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
    if (CH.vistaU !== 'chat') return;
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

  pintarAnunciosFeed() {
    pintarFeed('ch-feed-anuncios', CH.anuncios, COL_ANUNCIOS, 'Todavía no hay anuncios.');
  },

  pintarTrixiFeed() {
    pintarFeed('ch-feed-trixi', CH.trixi, COL_TRIXI, 'Trixi Bot no ha encontrado oportunidades todavía.');
  },

  // Se llama en cada cambio del canal de anuncios, se esté mirando esa
  // pantalla o no: la franja fijada y la ventana emergente son un aviso de
  // todo el portal, no solo de la pestaña de Chat.
  alCambiarAnuncios() {
    Usuario.pintarFranja();
    Usuario.pintarModal();
    if (CH.vistaU === 'anuncios') Usuario.pintarAnunciosFeed();
  },

  // El canal de Trixi Bot es informativo, pero una cuota buena se acaba
  // rápido — si nadie ve el aviso a tiempo, se pierde. Por eso sí avisa con
  // el mismo toast flotante que un mensaje de administración (mismo criterio:
  // solo lo nuevo desde que se abrió el portal, y no si ya lo está viendo).
  alCambiarTrixi() {
    if (CH.vistaU === 'trixi') Usuario.pintarTrixiFeed();
    Usuario.avisarNuevoTrixi();
  },

  avisarNuevoTrixi() {
    (CH.trixi || []).forEach(ev => {
      if (CH._trixiVistoIds.has(ev.id)) return;
      CH._trixiVistoIds.add(ev.id);
      if (CH.vistaU === 'trixi') return;
      if (ms(ev.ts) > CH._sesionInicio) mostrarToastTrixi(ev);
    });
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
      const base = '💬 Chat';
      t.innerHTML = n > 0 ? `${base}<span class="ch-nav-glob">${n > 99 ? '99+' : n}</span>` : base;
    }
  },

  // Aviso emergente: solo para mensajes de administración que llegan DESPUÉS
  // de abrir el portal (no el atraso viejo al iniciar sesión) y solo si en
  // ese momento no está ya viendo la conversación (si la tiene abierta, ya
  // lo está leyendo en vivo, avisarle encima sería redundante).
  avisarNuevos() {
    (CH.mensajes || []).forEach(m => {
      if (m.de !== 'admin' || CH._vistoIds.has(m.id)) return;
      CH._vistoIds.add(m.id);
      if (CH.abierto) return;
      if (ms(m.ts) > CH._sesionInicio) mostrarToastMensaje(m);
    });
  },

  pintar() { Usuario.pintarMensajes(); Usuario.pintarGlobo(); Usuario.pintarLista(); }
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
          <div class="ch-lista-cab">
            <span>Conversaciones</span>
            <button class="ch-webpush-btn" id="ch-webpush-btn" onclick="AJChat.activarWebPush()">🔔</button>
          </div>
          <div class="ch-buscar-cont">
            <span class="ch-buscar-ico">🔍</span>
            <input class="ch-buscar" id="ch-buscar" type="text" placeholder="Buscar operador o cajero…"
              oninput="AJChat.filtrarHilos(this.value)">
          </div>
          <div class="ch-lista-scroll">
            <div class="ch-item" id="ch-item-anuncios" onclick="AJChat.verAnuncios()">
              <div class="ch-ava" style="background:linear-gradient(135deg,#f0a050,#d88020)">📢</div>
              <div class="ch-item-txt">
                <div class="ch-item-nom">Anuncios del ecosistema</div>
                <div class="ch-item-ult">Publicar un aviso a todos</div>
              </div>
            </div>
            <div class="ch-item" id="ch-item-trixi" onclick="AJChat.verTrixi()">
              <div class="ch-ava" style="background:linear-gradient(135deg,#35CC2F,#24BF62)">🎰</div>
              <div class="ch-item-txt">
                <div class="ch-item-nom">Trixi Bot</div>
                <div class="ch-item-ult">Oportunidades detectadas — un solo canal, no por operador</div>
              </div>
            </div>
            <div id="ch-hilos"></div>
          </div>
        </div>
        <div class="ch-panel" id="ch-panel"></div>
      </div>`;
    Admin.verAnuncios();
    Admin.actualizarBotonWebPush();
  },

  // Estado del botón 🔔: si este dispositivo/navegador ya tiene una
  // suscripción push activa, se lo muestra en verde. iPhone solo puede
  // suscribirse si esta página se abrió desde el ícono de Inicio (PWA
  // agregada con Safira → Compartir → Agregar a inicio) — en Safari normal
  // el navegador no ofrece esa API, así que el botón lo explica al tocarlo.
  async actualizarBotonWebPush() {
    const btn = document.getElementById('ch-webpush-btn');
    if (!btn) return;
    const estado = await estadoWebPush();
    if (estado === 'activo') {
      btn.classList.add('activo');
      btn.innerHTML = '🔔 Activas';
      btn.title = 'Notificaciones activas en este dispositivo';
    } else {
      btn.classList.remove('activo');
      btn.innerHTML = '🔔';
      btn.title = 'Activar notificaciones en este dispositivo';
    }
  },

  // Filtro de la búsqueda tipo WhatsApp: se guarda para que sobreviva a los
  // repintados en vivo del listado (cada vez que llega un mensaje nuevo,
  // pintarHilos() se vuelve a llamar solo — si no se conservara el texto acá,
  // la búsqueda se borraría sola en cuanto alguien escribiera).
  _filtro: '',
  filtrarHilos(valor) {
    Admin._filtro = (valor || '').toLowerCase().trim();
    const f = norm(Admin._filtro);
    const anuncios = document.getElementById('ch-item-anuncios');
    const trixi = document.getElementById('ch-item-trixi');
    if (anuncios) anuncios.style.display = !f || norm('Anuncios del ecosistema').includes(f) ? '' : 'none';
    if (trixi) trixi.style.display = !f || norm('Trixi Bot').includes(f) ? '' : 'none';
    Admin.pintarHilos();
  },

  pintarHilos() {
    const c = document.getElementById('ch-hilos'); if (!c) return;
    const f = norm(Admin._filtro || '');
    let orden = [...CH.hilos].sort((a,b) => ms(b.ultimoTs) - ms(a.ultimoTs));
    if (f) orden = orden.filter(h => norm(h.nombre).includes(f) || norm(h.oficina).includes(f));
    if (!orden.length) {
      c.innerHTML = f
        ? `<div class="ch-buscar-vacio">Nadie coincide con "${esc(Admin._filtro)}".</div>`
        : `<div style="padding:18px 12px;color:var(--text2);font-size:12px;text-align:center">
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
        <button class="ch-cab-volver" onclick="AJChat.volverListaMovil()" title="Volver a la lista">←</button>
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
    mostrarPanelMovil();
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

  /* ── canal de Trixi Bot ── */
  // Solo lectura para el administrador también: lo escribe la vigilancia
  // automática, nadie compone nada aquí. Es el mismo feed que ve el
  // operador, para que quede claro que ya no hay una copia por persona.

  verTrixi() {
    CH.vista = 'trixi'; CH.hiloUid = ''; Admin.soltarHilo();
    const p = document.getElementById('ch-panel');
    p.innerHTML = `
      <div class="ch-cab">
        <button class="ch-cab-volver" onclick="AJChat.volverListaMovil()" title="Volver a la lista">←</button>
        <div class="ch-ava" style="background:linear-gradient(135deg,#35CC2F,#24BF62)">🎰</div>
        <div><div class="ch-cab-nom">Trixi Bot</div>
          <div class="ch-cab-sub">Oportunidades que el bot va encontrando — un solo canal para todos</div></div>
      </div>
      <div class="ch-cuerpo" id="ch-feed-trixi"></div>`;
    Admin.pintarTrixi();
    mostrarPanelMovil();
  },

  pintarTrixi() {
    if (CH.vista !== 'trixi') return;
    pintarFeed('ch-feed-trixi', CH.trixi, COL_TRIXI, 'Trixi Bot no ha encontrado oportunidades todavía.');
  },

  /* ── anuncios ── */

  // porClicUsuario: true cuando viene de un clic real (lista de contactos o
  // el botón AJChat.verAnuncios) — ahí sí se pasa al panel en celular. Falso
  // cuando lo llama montar() para dejar algo seleccionado por defecto al
  // abrir el chat: eso no debe tapar la lista de conversaciones en celular.
  verAnuncios(porClicUsuario) {
    CH.vista = 'anuncios'; CH.hiloUid = ''; Admin.soltarHilo();
    const p = document.getElementById('ch-panel');
    p.innerHTML = `
      <div class="ch-cab">
        <button class="ch-cab-volver" onclick="AJChat.volverListaMovil()" title="Volver a la lista">←</button>
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
    if (porClicUsuario) mostrarPanelMovil();
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
    if (t) t.innerHTML = n > 0 ? `💬 Chat<span class="ch-nav-glob">${n>99?'99+':n}</span>` : '💬 Chat';
    if (global.AJChatGlobo) global.AJChatGlobo(n);
  }
};

/* ══════════════════════════════════════════════════════════════════════════
   ARRANQUE
   ══════════════════════════════════════════════════════════════════════════ */

// Contador de no leídos sobre la burbuja flotante (Usuario.pintarGlobo y
// Admin.pintarGlobo ya llaman esto si existe; antes no hacía nada).
global.AJChatGlobo = actualizarGloboBadge;

global.AJChat = {

  // Operador y cajero
  iniciarUsuario(o) {
    inyectarEstilos();
    crearGlobo();
    iniciarChequeoVersion();
    Object.assign(CH, {
      db:o.db, auth:o.auth, uid:o.uid, nombre:o.nombre || '',
      rol:o.rol || 'operador', oficina:o.oficina || '', esAdmin:false,
      vistaU:'chat', trixibotActivo:false, trixi:[],
      // Para el aviso emergente: solo avisa de mensajes que lleguen de aquí
      // en adelante, nunca del atraso que ya traía al entrar.
      _sesionInicio: Date.now(), _vistoIds: new Set(), _trixiVistoIds: new Set()
    });
    if (o.montarEn) Usuario.montar(o.montarEn);

    // El hilo se crea solo la primera vez, sin pisar los contadores
    refHilo(CH.uid).set({
      uid: CH.uid, nombre: CH.nombre, rol: CH.rol, oficina: CH.oficina
    }, { merge:true }).catch(()=>{});

    const publicos = ['todos', CH.rol === 'cajero' ? 'cajeros' : 'operadores'];
    CH._off = [
      escucharHilo(CH.uid, Usuario.pintar),
      escucharMensajes(CH.uid, () => { Usuario.avisarNuevos(); Usuario.pintar(); }),
      escucharAnuncios(publicos, Usuario.alCambiarAnuncios)
    ];

    // El canal de Trixi Bot solo se conecta si de verdad le toca — ni
    // siquiera se piden los datos si el operador no lo tiene habilitado.
    // Los cajeros nunca lo tienen, así que ni se consulta.
    if (CH.rol !== 'cajero') {
      CH.db.collection('patriarca_config').doc(CH.uid).get().then(s => {
        CH.trixibotActivo = !!(s.exists && s.data().trixibot && s.data().trixibot.activo);
        if (CH.trixibotActivo) CH._off.push(escucharTrixi(Usuario.alCambiarTrixi));
        Usuario.pintarLista();
      }).catch(() => {});
    }
  },

  // Administrador
  iniciarAdmin(o) {
    inyectarEstilos();
    crearGlobo();
    iniciarChequeoVersion();
    iniciarBadgePush();
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
      escucharTrixi(() => Admin.pintarTrixi()),

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

  // Abrir/cerrar el chat como ventana flotante (burbuja abajo a la derecha),
  // sin tocar la pestaña "Chat" del menú. toggleFlotante(true/false) fuerza
  // el estado; sin argumento, alterna.
  toggleFlotante(forzar) { toggleFlotante(forzar); },

  /* Reportar con contexto. El portal lo llama desde el botón del objeto:
       AJChat.reportar({ tipo:'cupon', ref:id, resumen:'...' })            */
  reportar(ctx) {
    CH.contexto = ctx || null;
    // Si estaba mirando Anuncios o Trixi Bot, «Reportar» siempre debe volver
    // a la conversación con administración — es la única que se compone.
    if (!CH.esAdmin) { Usuario.verAdministracion(); mostrarPanelMovil(); }
    if (global.AJChatIrAMensajes) global.AJChatIrAMensajes();
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

  // Click sobre la tarjeta de una oportunidad de Trixi Bot: en vez de solo
  // ampliar la imagen, la monta en la calculadora del portal (si esa función
  // existe en la página, p. ej. patriarca.html) para que quede editable con
  // cuotas frescas. Cualquier otro tipo de tarjeta se comporta como siempre.
  tocarTarjeta(el) {
    const tipo = el.dataset.tipo, ref = el.dataset.ref, clave = el.dataset.clave;
    if (tipo === 'trixiOportunidad' && ref && clave && typeof window.tbMontarDesdeChat === 'function') {
      window.tbMontarDesdeChat(ref, clave);
      return;
    }
    AJChat.ampliar(el.src);
  },

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
  verAnuncios: () => Admin.verAnuncios(true),
  verTrixi: () => Admin.verTrixi(),
  volverListaMovil: () => volverListaMovil(),
  verQuien: id => Admin.verQuien(id),
  publicar: () => Admin.publicar(),
  borrarAnuncio: id => Admin.borrarAnuncio(id),
  verArchivo: uid => Admin.verArchivo(uid),

  // Lado operador: cambia entre Administración / Anuncios / Trixi Bot en su
  // propia lista de conversaciones.
  verUsuario: vista => Usuario.ver(vista),
  filtrarHilos: valor => Admin.filtrarHilos(valor),
  activarWebPush: () => activarWebPush(),

  soltar() {
    (CH._off || []).forEach(f => { try { f(); } catch(_){} });
    Admin.soltarHilo(); CH._off = [];
  }
};

})(window);
