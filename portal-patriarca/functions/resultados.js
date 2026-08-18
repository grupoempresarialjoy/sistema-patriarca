// ════════════════════════════════════════════════════════════════════════════
// VIGILANTE DE RESULTADOS
// Kambi borra el partido en cuanto lo liquida: no hay dónde consultar cómo
// quedó. Así que se mira el feed de partidos en curso cada minuto y se anota
// el marcador; cuando el partido desaparece, lo último anotado es el resultado.
//
// Solo lee resultados. Ninguna cuota de aquí entra al armado de cupones ni al
// bot de surebets, que siguen trabajando únicamente con prematch.
// ════════════════════════════════════════════════════════════════════════════

const URL_VIVO = marca =>
  `https://us.offering-api.kambicdn.com/offering/v2018/${marca}` +
  `/event/live/open.json?lang=es_CO&market=CO`;

// El fútbol virtual usa nombres reales con el jugador entre paréntesis:
// "Braga (hotShot) vs Porto (Kray)". Si entra, ensucia la ficha de los equipos
// de verdad con resultados de partidos que nunca se jugaron.
const VIRTUAL_RES = /virtual|cyber|esoccer|e-?sports|simulad/i;
function esVirtual(ev) {
  const txt = (ev.event?.group || '') + ' ' + (ev.event?.name || '') +
              ' ' + (ev.event?.path || []).map(p => p.name).join(' ');
  return VIRTUAL_RES.test(txt) || /\([^)]+\)/.test(ev.event?.homeName || '');
}

function esFutbol(ev) {
  if (esVirtual(ev)) return false;
  return (ev.event?.path || []).some(p =>
    /f[uú]tbol|football|soccer/i.test(p.name || p.englishName || ''));
}

// Lo que interesa de cada partido en curso
function fotoDe(e) {
  const ld = e.liveData || {};
  const st = ld.statistics?.football || {};
  const rel = ld.matchClock || {};
  const n = v => { const x = parseInt(v, 10); return isNaN(x) ? null : x; };
  return {
    id: e.event.id,
    local: e.event.homeName,
    visita: e.event.awayName,
    liga: e.event.group || '',
    inicio: e.event.start || null,
    golesLocal:  n(ld.score?.home),
    golesVisita: n(ld.score?.away),
    minuto: n(rel.minute),
    periodo: rel.periodId || null,
    amarillasLocal:  n(st.home?.yellowCards),
    amarillasVisita: n(st.away?.yellowCards),
    rojasLocal:      n(st.home?.redCards),
    rojasVisita:     n(st.away?.redCards),
    cornersLocal:    n(st.home?.corners),
    cornersVisita:   n(st.away?.corners)
  };
}

async function leerEnVivo(traer) {
  const vistos = new Map();
  // Las dos marcas de Kambi comparten motor, pero no siempre los mismos
  // partidos: se juntan y gana la foto con más minutos jugados.
  for (const marca of ['betplay', 'rsico']) {
    try {
      const j = await traer(URL_VIVO(marca), { json: true });
      (j.liveEvents || []).filter(esFutbol).forEach(e => {
        const f = fotoDe(e);
        if (f.golesLocal == null || f.golesVisita == null) return;
        const previo = vistos.get(f.id);
        if (!previo || (f.minuto || 0) > (previo.minuto || 0)) vistos.set(f.id, f);
      });
    } catch (_) { /* si una marca falla, la otra sigue */ }
  }
  return [...vistos.values()];
}

// Un partido cuenta como terminado si llegó al final del tiempo reglamentario.
// Los que desaparecen antes (suspendidos, o que el feed soltó) quedan marcados
// como dudosos para que la ficha del equipo no aprenda de datos malos.
function esFirme(f) {
  return (f.minuto || 0) >= 90 || /FINISH|ENDED|FULL/i.test(f.periodo || '');
}

module.exports = { leerEnVivo, fotoDe, esFirme, esFutbol, esVirtual };
