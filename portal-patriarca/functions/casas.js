// ════════════════════════════════════════════════════════════════════════════
// LECTORES DE CASAS — cada uno devuelve la misma forma:
//   { casa, local, visita, inicio (ISO UTC), liga, c:{'1','X','2'} }
// Si una casa falla, devuelve [] y no tumba a las demás.
// ════════════════════════════════════════════════════════════════════════════

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

async function traer(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, 'Accept-Language': 'es-CO,es;q=0.9', ...(opts.headers || {}) }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return opts.json ? await r.json() : await r.text();
  } finally { clearTimeout(t); }
}

// Ligas virtuales / esports: usan nombres de equipos reales y contaminarían el cruce
const VIRTUAL = /cyber|virtual|esoccer|e-?sports|\(\d+x\d+|fifa|efootball|simulat/i;

// ── KAMBI (Bet Play y Rushbet comparten plataforma) ────────────────────────
const MAPA_KAMBI = { OT_ONE: '1', OT_CROSS: 'X', OT_TWO: '2' };

// Mercados extra de Kambi. Obliga a una petición por partido, así que solo se
// pide para los que interesan y con un tope, para no dispararse en tiempo.
const MAPA_OU = { OT_OVER: 'OVER', OT_UNDER: 'UNDER' };
const MAPA_DC = { OT_ONE_OR_CROSS: '1X', OT_ONE_OR_TWO: '12', OT_CROSS_OR_TWO: 'X2' };

// Kambi publica el mismo mercado para el partido completo, para el primer
// tiempo y para el segundo, con el nombre casi idéntico. Mezclarlos produce
// "surebets" falsas enormes: ambos anotan del 1.º tiempo paga 3.30 mientras el
// del partido completo paga 1.43. Cualquier criterio con período se descarta.
const KAMBI_PERIODO = /\d\s*\.?\s*[ªa]?\s*parte|primera parte|segunda parte|primer tiempo|segundo tiempo|mitad|half|descanso|per[ií]odo|\bht\b/i;

async function leerKambiMercados(marca, eventoId) {
  const url = `https://us.offering-api.kambicdn.com/offering/v2018/${marca}` +
              `/betoffer/event/${eventoId}.json?lang=es_CO&market=CO`;
  const j = await traer(url, { json: true });
  const mercados = {};

  (j.betOffers || []).forEach(bo => {
    const etiqueta = bo.criterion?.label || '';
    const outs = bo.outcomes || [];
    if (KAMBI_PERIODO.test(etiqueta)) return;   // solo el partido completo

    // Total de goles del partido — se descartan los "de <equipo>"
    if (/^total de goles$/i.test(etiqueta)) {
      const linea = (outs[0]?.line || 0) / 1000;
      if (!linea) return;
      const m = {};
      outs.forEach(o => { const k = MAPA_OU[o.type]; if (k) m[k] = o.odds / 1000; });
      if (m.OVER && m.UNDER) mercados['GOL_OU|' + String(linea).replace('.', '_')] = m;
      return;
    }
    // Ambos equipos marcarán (solo el del partido completo)
    if (/^ambos equipos marcar[aá]n?$/i.test(etiqueta)) {
      const m = {};
      outs.forEach(o => {
        if (/^s[ií]$/i.test(o.label||'')) m['SI'] = o.odds / 1000;
        if (/^no$/i.test(o.label||''))    m['NO'] = o.odds / 1000;
      });
      if (m.SI && m.NO) mercados['BTTS'] = m;
      return;
    }
    // Doble oportunidad
    if (/^doble oportunidad$/i.test(etiqueta)) {
      const m = {};
      outs.forEach(o => { const k = MAPA_DC[o.type]; if (k) m[k] = o.odds / 1000; });
      if (m['1X'] && m['12'] && m['X2']) mercados['DC'] = m;
    }
  });
  return mercados;
}

// Kambi entrega la ruta completa del evento: Fútbol → País → Liga. El país es
// el nivel siguiente al deporte. Es mucho más confiable que deducirlo del
// nombre: "Liga Pro" existe en Ecuador y en Portugal, "Premier League" en
// Inglaterra y en Rusia.
function paisKambi(ev) {
  const p = ev.path || [];
  if (p.length < 2) return '';
  const i = p.findIndex(x => /^(f[uú]tbol|football|soccer)$/i.test(x.name || x.englishName || ''));
  const nodo = p[(i >= 0 ? i : 0) + 1];
  return (nodo && nodo.name) || '';
}

// La lista general de Kambi es una selección de destacados, no el catálogo.
// Medido: se dejaba por fuera 151 partidos, entre ellos toda la Liga BetPlay
// Dimayor. Cada país tiene su propio listado y hay que pedirlos aparte.
// Probados uno por uno; 'venezuela' y 'brasil' no existen como ruta —Brasil va
// en inglés— y pedirlos sería gastar por nada.
//
// Europa entraba solo de rebote, por la lista de destacados, y eso dejaba al
// modelo a ciegas: el histórico gratuito de football-data.co.uk cubre justo
// estas ligas europeas y ninguna sudamericana salvo Argentina, Brasil y México.
// Medido el 20/08/2026 sobre el catálogo real:
//
//   partidos con los dos equipos modelables · Latinoamérica  9.1%
//                                           · Europa        27.5%
//
// Desde Colombia se puede apostar a todos ellos; la casa solo los muestra en
// horario local. No había ninguna razón para no mirarlos.
const PAISES_LATAM = ['colombia','argentina','chile','peru','ecuador',
                      'uruguay','paraguay','mexico','bolivia','brazil'];

const PAISES_EUROPA = ['england','spain','italy','germany','france',
                       'netherlands','portugal','belgium','turkey','scotland',
                       'greece','denmark','sweden','norway','austria',
                       'poland','czech_republic','switzerland'];

const PAISES_KAMBI = [...PAISES_LATAM, ...PAISES_EUROPA];

async function leerKambi(casa, marca) {
  const base = `https://us.offering-api.kambicdn.com/offering/v2018/${marca}/listView/football`;
  const nc = Date.now();

  // Destacados primero, y después cada país. Un país que falle no tumba nada.
  const listas = await Promise.all([
    traer(`${base}.json?lang=es_CO&market=CO&ncid=${nc}`, { json: true }).catch(() => null),
    ...PAISES_KAMBI.map(p =>
      traer(`${base}/${p}.json?lang=es_CO&market=CO&ncid=${nc}`, { json: true }).catch(() => null))
  ]);

  // Unir sin repetir: un partido puede salir en destacados y en su país
  const porId = new Map();
  listas.forEach(j => (j && j.events || []).forEach(e => {
    if (e.event && e.event.id != null && !porId.has(e.event.id)) porId.set(e.event.id, e);
  }));

  const j = { events: [...porId.values()] };
  const out = [];
  (j.events || []).forEach(e => {
    const ev = e.event || {};
    if (VIRTUAL.test((ev.group || '') + ' ' + (ev.name || ''))) return;
    // Partido en curso: sus cuotas ya reflejan el marcador. Cruzarlas con las
    // de otra casa que todavía publica las de antes del pitazo inventa
    // surebets enormes que no se pueden jugar.
    if (ev.state && ev.state !== 'NOT_STARTED') return;
    const bo = (e.betOffers || []).find(b => (b.outcomes || []).some(o => MAPA_KAMBI[o.type]));
    if (!bo) return;
    const c = {};
    bo.outcomes.forEach(o => { const k = MAPA_KAMBI[o.type]; if (k) c[k] = o.odds / 1000; });
    if (!(c['1'] && c['X'] && c['2'])) return;
    out.push({ casa, local: ev.homeName, visita: ev.awayName,
               inicio: ev.start, liga: ev.group || '', pais: paisKambi(ev), c,
               kambiId: ev.id, kambiMarca: marca });
  });
  return out;
}

// ── YA JUEGOS (plataforma propia, endpoint feapi) ──────────────────────────
async function leerYaJuegos() {
  const V = '1.319.2.955';
  const url = `https://sports.yajuego.co/desktop/feapi/PalimpsestAjax/` +
              `GetEventsInDailyBundleV3?DISP=1000&DISPH=0&SPORTID=1&LIMIT=500&v_cache_version=${V}`;
  const j = await traer(url, { json: true, headers: { 'Referer': 'https://sports.yajuego.co/' } });
  if (j.R !== 'OK') throw new Error('respuesta ' + j.R);
  const G = (j.D && j.D.G) || {};
  const C = (j.D && (j.D.C || j.D.CAT)) || {};
  const out = [];
  (j.D.E || []).forEach(e => {
    const o = e.O || {};
    if (!(o.S_1X2_1 && o.S_1X2_X && o.S_1X2_2)) return;
    const p = String(e.N || '').split('||v||').map(s => s.replace(/\|/g, '').trim());
    if (p.length !== 2 || !p[0] || !p[1]) return;
    const g    = G[e.GID] || {};
    const liga = g.G_DESC || '';
    // El bundle agrupa las ligas bajo una categoría que es el país. Según la
    // versión del feed viene con uno u otro nombre, así que se prueban varios
    // y si ninguno está, se deja vacío y el país lo aporta otra casa.
    const pais = (C[g.CATID] || C[g.CID] || {}).C_DESC || g.C_DESC || g.CAT_DESC || '';
    if (VIRTUAL.test(liga + ' ' + e.N)) return;
    // Ya Juegos entrega hora de Colombia; se normaliza a UTC para comparar
    const inicio = new Date(String(e.D).replace(' ', 'T') + 'Z').getTime() + 5 * 3600 * 1000;
    // Mercados: el bundle ya los trae todos, no cuesta peticiones extra
    const mercados = { '1X2': { '1': +o.S_1X2_1, 'X': +o.S_1X2_X, '2': +o.S_1X2_2 } };

    // Over/Under de goles — una entrada por línea, la línea va en la clave
    Object.keys(o).forEach(k => {
      const m = /^S_OU@([\d.]+)_(U|O)$/.exec(k);
      if (!m) return;
      const clave = 'GOL_OU|' + m[1].replace('.', '_');
      mercados[clave] = mercados[clave] || {};
      mercados[clave][m[2] === 'O' ? 'OVER' : 'UNDER'] = +o[k];
    });

    // Ambos anotan
    if (o.S_GGNG_Y && o.S_GGNG_N) mercados['BTTS'] = { 'SI': +o.S_GGNG_Y, 'NO': +o.S_GGNG_N };

    // Doble oportunidad
    if (o.S_DC_1X && o.S_DC_12 && o.S_DC_X2)
      mercados['DC'] = { '1X': +o.S_DC_1X, '12': +o.S_DC_12, 'X2': +o.S_DC_X2 };

    // Solo dejar los mercados extra que quedaron completos. El 1X2 no se toca:
    // sin él la lectura no sirve para nada y ya viene validado arriba.
    Object.keys(mercados).forEach(k => {
      if (k === '1X2') return;
      const v = mercados[k];
      const n = Object.values(v).filter(x => x > 1).length;
      const esperados = k.startsWith('GOL_OU') ? 2 : k === 'BTTS' ? 2 : 3;
      if (n !== esperados) delete mercados[k];
    });

    out.push({ casa: 'YA JUEGOS', local: p[0], visita: p[1],
               inicio: new Date(inicio).toISOString(), liga, pais,
               c: mercados['1X2'], mercados });
  });
  return out;
}

// ── WPLAY (HTML del servidor, sin API) ─────────────────────────────────────
// Antes solo 4 rutas (3 ligas + el hub general). Wplay solo pinta el 1X2 en
// la página de la liga — los demás mercados viven detrás de "Número de
// mercados", en la página de cada partido, así que ampliar a más mercados
// significaría una petición por partido, no por liga. Eso queda para después.
// Por ahora se amplía lo barato: más ligas, la misma pata (1X2), calcado del
// listado de "ligas principales" de ligas.js para no traer basura de ligas
// juveniles/femeninas/reservas que igual se descartarían más adelante.
const LIGAS_WPLAY = [
  { ruta: '/es/t/19311/Colombia-Primera-A', liga: 'Liga BetPlay Dimayor' },
  { ruta: '/es/t/29698/Colombia-Copa-Colombia', liga: 'Copa Colombia' },
  { ruta: '/es/t/19462/Copa-Libertadores', liga: 'Copa Libertadores' },
  { ruta: '/es/t/19348/Copa-Sudamericana', liga: 'Copa Sudamericana' },
  { ruta: '/es/t/19296/Argentina-Liga-Profesional', liga: 'Liga Profesional Argentina' },
  { ruta: '/es/t/19303/Chile-Primera-Divisi%C3%B3n', liga: 'Primera Chile' },
  { ruta: '/es/t/2400790/Brasil-Serie-A', liga: 'Brasileirao Serie A' },
  { ruta: '/es/t/2434894/Liga-MX', liga: 'Liga MX' },
  { ruta: '/es/t/19302/USA-MLS', liga: 'MLS' },
  { ruta: '/es/t/19373/Ecuador-Primera-A', liga: 'Liga Pro' },
  { ruta: '/es/t/19398/Uruguay-Primera-Divisi%C3%B3n', liga: 'Campeonato Uruguayo' },
  { ruta: '/es/t/19359/Paraguay-Primera-Divisi%C3%B3n', liga: 'Division Profesional' },
  { ruta: '/es/t/19340/Per%C3%BA-Primera-Divisi%C3%B3n', liga: 'Liga 1' },
  { ruta: '/es/t/20080/Venezuela-Primera-Divisi%C3%B3n', liga: 'Liga FUTVE' },
  { ruta: '/es/t/19402/Costa-Rica-Primera-Divisi%C3%B3n', liga: 'Primera Division Costa Rica' },
  { ruta: '/es/t/19786/Bolivia-Liga-de-F%C3%BAtbol-Profesional', liga: 'Division Profesional Bolivia' },
  { ruta: '/es/t/27598/Panama-Liga-Panamena', liga: 'Liga Panameña de Fútbol' },
  { ruta: '/es/t/19469/Honduras-Liga-Nacional', liga: 'Liga Nacional Honduras' },
  { ruta: '/es/t/19919/Guatemala-Liga-Nacional', liga: 'Liga Nacional Guatemala' },
  { ruta: '/es/t/19161/UEFA-Champions-League', liga: 'Champions League' },
  { ruta: '/es/t/19162/UEFA-Liga-Europa', liga: 'Europa League' },
  { ruta: '/es/t/413776/UEFA-Europa-Conference-League', liga: 'Conference League' },
  { ruta: '/es/t/19160/La-Liga', liga: 'La Liga' },
  { ruta: '/es/t/19157/Inglaterra-Premier-League', liga: 'Premier League' },
  { ruta: '/es/t/19156/Inglaterra-Championship', liga: 'Championship' },
  { ruta: '/es/t/19207/Inglaterra-FA-Cup', liga: 'FA Cup' },
  { ruta: '/es/t/19163/Inglaterra-EFL-Cup', liga: 'EFL Cup' },
  { ruta: '/es/t/19208/Escocia-Premiership', liga: 'Premiership Escocia' },
  { ruta: '/es/t/19159/Serie-A', liga: 'Serie A' },
  { ruta: '/es/t/19328/Serie-B', liga: 'Serie B' },
  { ruta: '/es/t/19327/Ligue-1', liga: 'Ligue 1' },
  { ruta: '/es/t/19405/Ligue-2', liga: 'Ligue 2' },
  { ruta: '/es/t/19158/Bundesliga-1', liga: 'Bundesliga' },
  { ruta: '/es/t/19358/Holanda-Eredivisie', liga: 'Eredivisie' },
  { ruta: '/es/t/19211/Portugal-Primeira-Liga', liga: 'Primeira Liga' },
  { ruta: '/es/t/19372/B%C3%A9lgica-1ra-Divisi%C3%B3n-A', liga: 'Jupiler Pro League' },
  { ruta: '/es/t/19363/-Turqu%C3%ADa-Superliga', liga: 'Süper Lig' },
  { ruta: '/es/t/19209/Grecia-Super-League', liga: 'Super League Grecia' },
  { ruta: '/es/t/19347/Austria-Bundesliga', liga: 'Bundesliga Austria' },
  { ruta: '/es/t/19305/Suiza-Super-Liga', liga: 'Super League Suiza' },
  { ruta: '/es/t/19299/Dinamarca-Superliga', liga: 'Superligaen' },
  { ruta: '/es/t/19472/Noruega-Eliteserien', liga: 'Eliteserien' },
  { ruta: '/es/t/19308/Suecia-Allsvenskan', liga: 'Allsvenskan' },
  { ruta: '/es/t/19336/Polonia-Ekstraklasa', liga: 'Ekstraklasa' },
  { ruta: '/es/t/19403/Rep%C3%BAblica-Checa-1ra-Liga', liga: 'Fortuna Liga' },
  { ruta: '/es/t/19390/Croatia-HNL', liga: 'HNL' },
  { ruta: '/es/t/19386/Serbia-Super-Liga', liga: 'Super Liga Serbia' },
  { ruta: '/es/t/46019/Ruman%C3%ADa-Liga-1', liga: 'Liga I' },
  { ruta: '/es/t/19383/Ucrania-Premier-League', liga: 'Premier League Ucrania' },
  { ruta: '/es/t/19485/China-Super-Liga', liga: 'Super League China' },
  { ruta: '/es/t/19378/Jap%C3%B3n-Liga-J', liga: 'J1-League' },
  { ruta: '/es/t/19306/COREA-DEL-SUR-K-LEAGUE-1', liga: 'K League 1' },
  { ruta: '/es/t/19361/Arabia-Saudita-Professional-League', liga: 'Saudi Pro League' },
  { ruta: '/es/t/19421/Qatar-Stars-League', liga: 'Qatar Stars League' },
  { ruta: '/es/s/FOOT/F%C3%BAtbol', liga: '' }
];

// Wplay entrega la hora aparte, en un contenedor .ev-<id> con .time y .date.
// El id coincide con el ev-<id> de los botones de cuota, así se enlazan.
const MESES = { ene:0, feb:1, mar:2, abr:3, may:4, jun:5,
                jul:6, ago:7, sep:8, oct:9, nov:10, dic:11 };

// Wplay muestra las horas en la zona de quien consulta, no en la de Colombia:
// depende de la IP y de la cookie GN_TZ_MODE. Desde un navegador en Madrid la
// página marca GMT +2; desde los servidores de Google puede marcar otra cosa.
// En vez de suponerla, se lee del propio selector de la página.
function offsetWplay($) {
  const v = $('select[name="tz_offset"] option[selected]').attr('value');
  const n = parseFloat(v);
  return isNaN(n) ? -5 : n;            // sin dato, se asume Colombia
}

function fechaWplay(hora, fecha, offset) {
  // hora "21:00", fecha "22 Ago" en la zona que reporte la página → UTC
  const off = (typeof offset === 'number' && !isNaN(offset)) ? offset : -5;
  const mh = /^(\d{1,2}):(\d{2})$/.exec(String(hora || '').trim());
  const mf = /^(\d{1,2})\s+([A-Za-zÁÉÍÓÚáéíóú]{3})/.exec(String(fecha || '').trim());
  if (!mh || !mf) return null;
  const mes = MESES[mf[2].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')];
  if (mes == null) return null;

  const hoyCO = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()) + 'T00:00:00Z');
  let anio = hoyCO.getUTCFullYear();
  // Si el mes ya pasó, el partido es del año entrante (cambio de año)
  if (mes < hoyCO.getUTCMonth() - 6) anio++;

  const ms = Date.UTC(anio, mes, +mf[1], +mh[1], +mh[2]) - off * 3600 * 1000;
  return new Date(ms).toISOString();
}

function parsearWplay(html, cheerio, liga) {
  const $ = cheerio.load(html);
  const off = offsetWplay($);

  // Mapa id de evento → hora de inicio. Los partidos en curso traen el
  // cronómetro en ese mismo campo ("45:00 1ª Mitad") y no tienen fecha, así
  // que se descartan: sus cuotas ya reflejan el marcador.
  const horas = {};
  const envivo = new Set();
  $('.ev').each((_, el) => {
    const id = (String($(el).attr('class') || '').match(/ev-(\d+)/) || [])[1];
    if (!id) return;
    const t = $(el).find('.time').first().text().trim();
    const f = $(el).find('.date').first().text().trim();
    if (!/^\d{1,2}:\d{2}$/.test(t) || !f) { envivo.add(id); return; }
    const iso = fechaWplay(t, f, off);
    if (iso) horas[id] = iso; else envivo.add(id);
  });

  const grupos = {};
  $('button.price').each((_, el) => {
    const cls = $(el).attr('class') || '';
    const ev = (cls.match(/ev-(\d+)/) || [])[1];
    const mk = (cls.match(/mkt-(\d+)/) || [])[1];
    const cuota = parseFloat($(el).find('.price.dec').first().text().trim());
    const nombre = ($(el).attr('title') || '').trim();
    if (!ev || !mk || !cuota || !nombre) return;
    const tdCls = $(el).closest('td').attr('class') || '';
    const empate = tdCls.includes('seln_sort-D') || /^empate$/i.test(nombre);
    const k = ev + '|' + mk;
    if (!grupos[k]) grupos[k] = { ev, sel: [] };
    grupos[k].sel.push({ nombre, cuota, empate });
  });
  const out = [];
  Object.values(grupos).forEach(g => {
    const s = g.sel;
    if (s.length !== 3) return;
    const X = s.find(x => x.empate);
    const otros = s.filter(x => !x.empate);
    if (!X || otros.length !== 2) return;   // sin empate identificable → se descarta
    if (envivo.has(g.ev) || !horas[g.ev]) return;   // en vivo o sin hora → fuera
    out.push({ casa: 'WPLAY', local: otros[0].nombre, visita: otros[1].nombre,
               inicio: horas[g.ev], liga: liga || '',
               c: { '1': otros[0].cuota, 'X': X.cuota, '2': otros[1].cuota } });
  });
  return out;
}

// Antes esto era un for..of secuencial con 4 rutas — con ~50 ahora, uno por
// uno se hubiera vuelto lento y arriesgaba el timeout del captador. Pero
// tampoco se disparan las 50 a la vez: un estallido de peticiones simultáneas
// al mismo sitio parece un bot y puede terminar bloqueado, que sería peor que
// como estaba. CUPO limita cuántas viajan al tiempo; una liga que falle
// (try/catch) no tumba a las demás.
const WPLAY_CUPO = 6;

async function leerWplay(cheerio) {
  const todos = [];
  const cola = LIGAS_WPLAY.slice();

  async function trabajador() {
    let item;
    while ((item = cola.shift())) {
      try {
        const html = await traer('https://apuestas.wplay.co' + item.ruta);
        todos.push(...parsearWplay(html, cheerio, item.liga));
      } catch (e) { /* una liga que falle no tumba las demás */ }
    }
  }

  await Promise.all(Array.from({ length: WPLAY_CUPO }, trabajador));

  // Deduplicar por partido — el hub general y las ligas puntuales se pisan
  const vistos = new Set(), out = [];
  todos.forEach(x => { const k = x.local + '|' + x.visita;
    if (!vistos.has(k)) { vistos.add(k); out.push(x); } });
  return out;
}

module.exports = { traer, leerKambi, paisKambi, offsetWplay, leerKambiMercados, leerYaJuegos, leerWplay, parsearWplay, fechaWplay, VIRTUAL };
