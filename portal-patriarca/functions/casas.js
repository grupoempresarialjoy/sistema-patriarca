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

async function leerKambi(casa, marca) {
  const url = `https://us.offering-api.kambicdn.com/offering/v2018/${marca}` +
              `/listView/football.json?lang=es_CO&market=CO&ncid=${Date.now()}`;
  const j = await traer(url, { json: true });
  const out = [];
  (j.events || []).forEach(e => {
    const ev = e.event || {};
    if (VIRTUAL.test((ev.group || '') + ' ' + (ev.name || ''))) return;
    const bo = (e.betOffers || []).find(b => (b.outcomes || []).some(o => MAPA_KAMBI[o.type]));
    if (!bo) return;
    const c = {};
    bo.outcomes.forEach(o => { const k = MAPA_KAMBI[o.type]; if (k) c[k] = o.odds / 1000; });
    if (!(c['1'] && c['X'] && c['2'])) return;
    out.push({ casa, local: ev.homeName, visita: ev.awayName,
               inicio: ev.start, liga: ev.group || '', c });
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
  const out = [];
  (j.D.E || []).forEach(e => {
    const o = e.O || {};
    if (!(o.S_1X2_1 && o.S_1X2_X && o.S_1X2_2)) return;
    const p = String(e.N || '').split('||v||').map(s => s.replace(/\|/g, '').trim());
    if (p.length !== 2 || !p[0] || !p[1]) return;
    const liga = (G[e.GID] || {}).G_DESC || '';
    if (VIRTUAL.test(liga + ' ' + e.N)) return;
    // Ya Juegos entrega hora de Colombia; se normaliza a UTC para comparar
    const inicio = new Date(String(e.D).replace(' ', 'T') + 'Z').getTime() + 5 * 3600 * 1000;
    out.push({ casa: 'YA JUEGOS', local: p[0], visita: p[1],
               inicio: new Date(inicio).toISOString(), liga,
               c: { '1': +o.S_1X2_1, 'X': +o.S_1X2_X, '2': +o.S_1X2_2 } });
  });
  return out;
}

// ── WPLAY (HTML del servidor, sin API) ─────────────────────────────────────
const LIGAS_WPLAY = [
  '/es/t/19311/Colombia-Primera-A',
  '/es/t/19462/Copa-Libertadores',
  '/es/t/19348/Copa-Sudamericana',
  '/es/s/FOOT/F%C3%BAtbol'
];

// Wplay entrega la hora aparte, en un contenedor .ev-<id> con .time y .date.
// El id coincide con el ev-<id> de los botones de cuota, así se enlazan.
const MESES = { ene:0, feb:1, mar:2, abr:3, may:4, jun:5,
                jul:6, ago:7, sep:8, oct:9, nov:10, dic:11 };

function fechaWplay(hora, fecha) {
  // hora "21:00", fecha "22 Ago" — hora de Colombia, se devuelve en UTC
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

  const ms = Date.UTC(anio, mes, +mf[1], +mh[1], +mh[2]) + 5 * 3600 * 1000;
  return new Date(ms).toISOString();
}

function parsearWplay(html, cheerio) {
  const $ = cheerio.load(html);

  // Mapa id de evento → hora de inicio
  const horas = {};
  $('.ev').each((_, el) => {
    const id = (String($(el).attr('class') || '').match(/ev-(\d+)/) || [])[1];
    if (!id) return;
    const iso = fechaWplay($(el).find('.time').first().text(), $(el).find('.date').first().text());
    if (iso) horas[id] = iso;
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
    out.push({ casa: 'WPLAY', local: otros[0].nombre, visita: otros[1].nombre,
               inicio: horas[g.ev] || null, liga: '',
               c: { '1': otros[0].cuota, 'X': X.cuota, '2': otros[1].cuota } });
  });
  return out;
}

async function leerWplay(cheerio) {
  const todos = [];
  for (const ruta of LIGAS_WPLAY) {
    try {
      const html = await traer('https://apuestas.wplay.co' + ruta);
      todos.push(...parsearWplay(html, cheerio));
    } catch (e) { /* una liga que falle no tumba las demás */ }
  }
  // Deduplicar por partido
  const vistos = new Set(), out = [];
  todos.forEach(x => { const k = x.local + '|' + x.visita;
    if (!vistos.has(k)) { vistos.add(k); out.push(x); } });
  return out;
}

module.exports = { leerKambi, leerYaJuegos, leerWplay, parsearWplay, fechaWplay, VIRTUAL };
