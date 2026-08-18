// ════════════════════════════════════════════════════════════════════════════
// EMPAREJADOR
// Un falso emparejamiento no da cero: da una apuesta que parece cubierta y no
// lo está. Por eso exige nombre parecido Y hora de inicio coincidente cuando
// ambas casas la reportan.
// ════════════════════════════════════════════════════════════════════════════

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(fc|cf|cd|sc|ac|se|ec|ad|cs|club|deportivo|deportes|atletico|de|del|la|el|los|sp|rj|mg|ltda|sa)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function parecido(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length > 4 && b.length > 4 && (a.includes(b) || b.includes(a))) return 0.93;
  const A = new Set(a.match(/.{1,3}/g) || []);
  const B = new Set(b.match(/.{1,3}/g) || []);
  let i = 0; A.forEach(x => { if (B.has(x)) i++; });
  return (2 * i) / (A.size + B.size);
}

const TOLERANCIA_MS = 15 * 60 * 1000;   // ±15 min
const UMBRAL_NOMBRE = 0.75;

// Cuando NO hay hora en una de las dos, el umbral sube: el nombre carga solo
// con toda la responsabilidad de no equivocarse.
const UMBRAL_SIN_HORA = 0.88;

// El fútbol virtual usa nombres reales con el jugador entre paréntesis:
// "River Plate (Jackson)". Si uno los trae y el otro no, no son el mismo partido.
function tieneAlias(x) { return /\([^)]+\)/.test(String(x || '')); }

// Sufijos de categoría. El mismo club juega el mismo día con varios equipos:
// "Samsunspor U19" en la liga juvenil y "Samsunspor" en la de mayores. Al
// normalizar los nombres quedan casi idénticos, así que si uno lo trae y el
// otro no, son partidos distintos. Fusionarlos cruza cuotas de dos encuentros.
const CATEGORIA = /\b(u\s?\d{2}|sub\s?-?\s?\d{2}|s\d{2}|ii|b|reservas?|reserves?|juvenil|youth|fem(eni[nl]o?)?|women|amateur)\b/i;
function categoriaDe(x) {
  const m = String(x || '').match(CATEGORIA);
  return m ? m[0].toLowerCase().replace(/[\s-]/g, '') : '';
}

function mismoPartido(a, b) {
  const aliasA = tieneAlias(a.local) || tieneAlias(a.visita);
  const aliasB = tieneAlias(b.local) || tieneAlias(b.visita);
  if (aliasA !== aliasB) return 0;

  // La categoría tiene que coincidir en los dos equipos
  if (categoriaDe(a.local)  !== categoriaDe(b.local))  return 0;
  if (categoriaDe(a.visita) !== categoriaDe(b.visita)) return 0;

  // Sin hora en alguno de los dos no se empareja. Es la única forma de
  // distinguir dos partidos del mismo club el mismo día, y una fusión errada
  // no da cero: da una apuesta que parece cubierta y no lo está.
  if (!a.inicio || !b.inicio) return 0;
  const dif = Math.abs(Date.parse(a.inicio) - Date.parse(b.inicio));
  if (isNaN(dif) || dif > TOLERANCIA_MS) return 0;

  const s = (parecido(a.local, b.local) + parecido(a.visita, b.visita)) / 2;
  return s >= UMBRAL_NOMBRE ? s : 0;
}

// ── LLAVE DURA ─────────────────────────────────────────────────────────────
// Concatena hora redondeada + prefijos normalizados de los dos equipos.
// Al quitar el ruido, "CD Junior" y "Club Deportivo Junior" quedan iguales.
// Sirve como coincidencia exacta y barata; lo que no encaje pasa al difuso.
const BUCKET_MIN = 15;

function claveDura(x) {
  if (!x.inicio) return null;
  const t = Date.parse(x.inicio);
  if (isNaN(t)) return null;
  const bucket = Math.round(t / (BUCKET_MIN * 60000));
  const a = norm(x.local).slice(0, 6);
  const b = norm(x.visita).slice(0, 6);
  if (!a || !b) return null;
  const cat = categoriaDe(x.local) + categoriaDe(x.visita);
  return bucket + '|' + a + '|' + b + '|' + cat;
}

// Las casas nombran distinto el mismo torneo, así que la liga no sirve como
// llave. Sí sirve como veto: si ambas la reportan y hablan de países
// distintos, no es el mismo partido.
const PAISES = /(colombia|argentina|brasil|chile|peru|ecuador|mexico|espana|england|italia|francia|alemania|portugal|japon|australia)/i;

function ligaContradice(a, b) {
  if (!a || !b) return false;
  const pa = (String(a).normalize('NFD').replace(/[\u0300-\u036f]/g,'').match(PAISES) || [])[1];
  const pb = (String(b).normalize('NFD').replace(/[\u0300-\u036f]/g,'').match(PAISES) || [])[1];
  return !!(pa && pb && pa.toLowerCase() !== pb.toLowerCase());
}

// Agrupa lecturas de varias casas en eventos únicos con sus cuotas por casa
function agrupar(lecturas) {
  const eventos = [];
  const porClave = new Map();          // llave dura → evento
  let exactos = 0, difusos = 0;

  lecturas.forEach(l => {
    let destino = null, mejor = 0;

    // 1) Llave dura: coincidencia exacta
    const k = claveDura(l);
    if (k && porClave.has(k)) { destino = porClave.get(k); exactos++; }

    // 2) Difuso solo si la llave no resolvió
    if (!destino) {
      for (const ev of eventos) {
        if (ligaContradice(ev.liga, l.liga)) continue;
        const s = mismoPartido(ev, l);
        if (s > mejor) { mejor = s; destino = ev; }
      }
      if (destino) difusos++;
    }

    if (destino) {
      destino.cuotas[l.casa] = l.c;
      if (l.mercados) destino.mercados[l.casa] = l.mercados;
      if (l.kambiId) destino.refs.push({ casa: l.casa, id: l.kambiId, marca: l.kambiMarca });
      if (!destino.inicio && l.inicio) destino.inicio = l.inicio;
      if (!destino.liga && l.liga) destino.liga = l.liga;
      if (!destino.pais && l.pais) destino.pais = l.pais;
    } else {
      const nuevo = { local: l.local, visita: l.visita, inicio: l.inicio,
                      liga: l.liga, pais: l.pais || '', cuotas: { [l.casa]: l.c },
                      mercados: l.mercados ? { [l.casa]: l.mercados } : {},
                      refs: l.kambiId ? [{ casa: l.casa, id: l.kambiId, marca: l.kambiMarca }] : [] };
      eventos.push(nuevo);
      if (k) porClave.set(k, nuevo);
    }
  });
  eventos._exactos = exactos;
  eventos._difusos = difusos;
  return eventos;
}

module.exports = { norm, parecido, mismoPartido, agrupar, tieneAlias, categoriaDe, claveDura, ligaContradice, TOLERANCIA_MS };
