// ════════════════════════════════════════════════════════════════════════════
// ANÁLISIS DE COMBINADAS
// ----------------------------------------------------------------------------
// Mira los cupones ya resueltos y compara, en cada corte que importa, lo que
// la casa decía (la cuota, convertida a probabilidad) contra lo que de verdad
// pasó. Es la misma pregunta una y otra vez: "¿en este grupo el bot acierta
// tanto como la cuota implica, o menos?"
//
// La lectura (analizarCombinadas) no toca nada. Lo único que escribe algo es
// tablaRendimiento cuando se le pide explícitamente aplicar — y lo que escribe
// es la misma tabla que ya vivía en trixibot_estado/rendimiento, solo que
// calculada con datos reales en vez de a ojo.
// ════════════════════════════════════════════════════════════════════════════

const BALDES_CUOTA = [
  { id: '< 1.30',      min: 0,    max: 1.30 },
  { id: '1.30 – 1.50', min: 1.30, max: 1.50 },
  { id: '1.50 – 1.75', min: 1.50, max: 1.75 },
  { id: '1.75 – 2.00', min: 1.75, max: 2.00 },
  { id: '2.00 – 2.50', min: 2.00, max: 2.50 },
  { id: '2.50 +',      min: 2.50, max: Infinity }
];
const baldeDe = c => BALDES_CUOTA.find(b => c >= b.min && c < b.max) || BALDES_CUOTA[BALDES_CUOTA.length - 1];

// Cuenta aciertos y compara con lo implícito en la cuota. n pequeño no dice
// nada, así que todo grupo lleva su tamaño de muestra para poder filtrarlo.
function resumirGrupo(legs) {
  const n = legs.length;
  if (!n) return null;
  const aciertos = legs.filter(l => l.acerto === true).length;
  const real = aciertos / n;
  const implicitaProm = legs.reduce((s, l) => s + (l.cuota ? 1 / l.cuota : 0), 0) / n;
  const se = Math.sqrt(implicitaProm * (1 - implicitaProm) / n) || 0;
  const z = se ? (real - implicitaProm) / se : null;

  // Cuántos partidos distintos hay detrás del número. Si un mismo partido se
  // jugó varias veces como pata de distintos cupones, "n" cuenta cada una por
  // separado y el error típico de arriba queda inflado — parece más seguro de
  // lo que es. Esto avisa cuando eso está pasando.
  const partidos = new Set(legs.map(l =>
    (l.local || '') + '|' + (l.visitante || '') + '|' + (l.inicio || '').slice(0, 10)));

  return {
    n, aciertos, partidosUnicos: partidos.size,
    realPct: +(real * 100).toFixed(1),
    implicitaPct: +(implicitaProm * 100).toFixed(1),
    rendimientoPct: implicitaProm ? +(((real / implicitaProm) - 1) * 100).toFixed(1) : null,
    erroresTipicos: z == null ? null : +z.toFixed(2),
    // "Confiable" ahora exige además que no sea uno o dos partidos repetidos
    // once veces: sin eso, Colombia se habría marcado confiable con 8 partidos.
    confiable: z != null && Math.abs(z) >= 2 && n >= 15 && partidos.size >= 8
  };
}

function agruparPor(legs, clave) {
  const grupos = new Map();
  legs.forEach(l => {
    const k = clave(l);
    if (k == null) return;
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(l);
  });
  const out = {};
  for (const [k, arr] of grupos) out[k] = resumirGrupo(arr);
  return out;
}

// Todos los legs con resultado firme, uno por cada opción de cada cupón
// resuelto. Se usa tanto para el informe como para calcular la tabla de
// rendimiento que consume el motor de Combinadas.
async function legsDe(db) {
  const snap = await db.collection('combinadas_cupones')
    .where('resuelto', '==', true).limit(3000).get();
  const cupones = snap.docs.map(d => d.data());
  const legs = [];
  cupones.forEach(c => (c.opciones || []).forEach(o => {
    if (o.acerto == null) return;
    if (!o.cuota) return;
    legs.push({
      ...o,
      casa: c.casa, estrategia: c.estrategia || 'libre',
      cuponEstado: c.estado, balde: baldeDe(o.cuota).id
    });
  }));
  return { cupones, legs };
}

async function analizarCombinadas(db) {
  const { cupones, legs } = await legsDe(db);

  const general = resumirGrupo(legs);

  const porMercado    = agruparPor(legs, l => l.mercado || '—');
  const porViaMdo     = agruparPor(legs, l => (l.mercado || '—') + ' · ' + (l.via || '—'));
  const porViaLinea   = agruparPor(legs.filter(l => l.mercado === 'GOL_OU'),
                                    l => 'Goles · ' + (l.via || '—') + ' ' + (l.linea || '—').replace('_', '.'));
  const porCuota      = agruparPor(legs, l => l.balde);
  const porEstrategia = agruparPor(legs, l => l.estrategia);
  const porCasa       = agruparPor(legs, l => l.casa || '—');
  const porPais       = agruparPor(legs, l => l.pais || '—');
  const porLiga       = agruparPor(legs, l => l.liga || '—');

  const cruce = {};
  Object.keys(porMercado).forEach(m => {
    const sub = agruparPor(legs.filter(l => (l.mercado || '—') === m), l => l.balde);
    const conDatos = Object.entries(sub).filter(([, v]) => v && v.n >= 8);
    if (conDatos.length) cruce[m] = Object.fromEntries(conDatos);
  });

  const resueltos = cupones.filter(c => c.resuelto);
  const ganados   = resueltos.filter(c => c.estado === 'ganado');
  const cupon = {
    n: resueltos.length,
    ganados: ganados.length,
    perdidos: resueltos.length - ganados.length,
    aciertoPct: resueltos.length ? +(ganados.length * 100 / resueltos.length).toFixed(1) : null,
    rendimientoPct: resueltos.length
      ? +(((ganados.reduce((s, c) => s + (c.cuotaTotal || 0), 0) - resueltos.length)
           / resueltos.length) * 100).toFixed(1)
      : null
  };

  const ranking = [];
  const nombrar = (grupo, prefijo) => Object.entries(grupo).forEach(([k, v]) => {
    if (v && v.n >= 12) ranking.push({ corte: prefijo + ': ' + k, ...v });
  });
  nombrar(porViaMdo, 'Mercado');
  nombrar(porCuota, 'Rango de cuota');
  nombrar(porEstrategia, 'Estrategia');
  nombrar(porPais, 'País');
  ranking.sort((a, b) => (b.rendimientoPct ?? -999) - (a.rendimientoPct ?? -999));

  const auditoriaPais = pais => legs
    .filter(l => (l.pais || '') === pais)
    .map(l => ({ local: l.local, visitante: l.visitante, fecha: (l.inicio || '').slice(0, 10),
                 mercado: l.mercado, via: l.via, linea: l.linea, cuota: l.cuota,
                 golesLocal: l.golesLocal, golesVisita: l.golesVisita, acerto: l.acerto,
                 liga: l.liga }))
    .sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));

  return {
    generadoEn: new Date().toISOString(),
    legsAnalizados: legs.length,
    cuponesResueltos: resueltos.length,
    general, cupon,
    porMercado, porViaMdo, porViaLinea, porCuota, porEstrategia, porCasa, porPais, porLiga,
    cruceMercadoCuota: cruce,
    mejores: ranking.filter(r => r.erroresTipicos == null || r.erroresTipicos >= -0.3).slice(0, 8),
    peores: ranking.slice(-8).reverse(),
    auditoriaColombia: auditoriaPais('Colombia')
  };
}

// ── Tabla de rendimiento por mercado y vía ──────────────────────────────────
// Antes CP_RENDIMIENTO solo distinguía el mercado (GOL_OU), no la vía: "Más
// de" y "Menos de" compartían la misma curva aunque rindan distinto. Ahora se
// calcula una para cada combinación mercado|vía, y el motor (cpRendimiento en
// patriarca.html) busca primero esa, y si no existe cae a la del mercado.
//
// Por cada tramo de cuota se usa el rendimiento de ESE tramo si hay muestra
// (10 patas, en partidos distintos); si no, el de la vía completa; si tampoco,
// el del mercado completo. Encadenar así evita huecos en la tabla sin inventar
// números donde no hay datos.
function tablaRendimiento(legs) {
  const porMercado = agruparPor(legs, l => l.mercado || '—');
  const porVia     = agruparPor(legs, l => (l.mercado || '—') + '|' + (l.via || '—'));

  const tramosDe = (subset, general) => BALDES_CUOTA.map(b => {
    const enTramo = subset.filter(l => l.cuota >= b.min && l.cuota < b.max);
    const r = resumirGrupo(enTramo);
    const val = (r && r.n >= 10 && r.partidosUnicos >= 6) ? r.rendimientoPct
              : (general ? general.rendimientoPct : 0);
    return { desde: b.min, val: val ?? 0 };
  });

  const tabla = {};
  Object.entries(porMercado).forEach(([mid, g]) => {
    if (!g) return;
    tabla[mid] = tramosDe(legs.filter(l => (l.mercado || '—') === mid), g);
  });
  Object.entries(porVia).forEach(([clave, g]) => {
    if (!g) return;
    const [mid, via] = clave.split('|');
    tabla[clave] = tramosDe(legs.filter(l => (l.mercado || '—') === mid && (l.via || '—') === via), g);
  });

  const general = resumirGrupo(legs);
  tabla['_otros'] = [{ desde: 0, val: general ? general.rendimientoPct : 0 }];
  return tabla;
}

async function calcularTablaRendimiento(db) {
  const { legs } = await legsDe(db);
  return { tabla: tablaRendimiento(legs), legsUsados: legs.length,
           calculadoEn: new Date().toISOString() };
}

module.exports = { analizarCombinadas, calcularTablaRendimiento };
