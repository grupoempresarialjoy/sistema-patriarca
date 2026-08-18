// ════════════════════════════════════════════════════════════════════════════
// COMBINADAS PRO — AUTOAPRENDIZAJE
// Corre una vez al día, de madrugada, cuando ya terminó todo. Toma los
// resultados que el vigilante fue anotando y arma la ficha de cada equipo.
//
// Guarda los últimos partidos en vez de solo acumulados: un equipo que hace
// dos meses metía tres goles y ahora no mete ninguno no es el mismo equipo, y
// un promedio de toda la temporada lo esconde.
// ════════════════════════════════════════════════════════════════════════════

const VENTANA = 20;          // partidos que se recuerdan por equipo

function normEquipo(s) {
  return String(s || '')
    .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(fc|cf|cd|sc|ac|se|ec|ad|cs|club|deportivo|deportes|atletico|de|del|la|el|los)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// Una línea del historial, desde el punto de vista de un equipo
function lineaDe(r, esLocal) {
  return {
    id: String(r.id),
    fecha: r.fecha || null,
    rival: esLocal ? r.visita : r.local,
    casa: esLocal,
    gf: esLocal ? r.golesLocal : r.golesVisita,
    gc: esLocal ? r.golesVisita : r.golesLocal,
    amarillas: (esLocal ? r.amarillasLocal : r.amarillasVisita) ?? null,
    corners:   (esLocal ? r.cornersLocal   : r.cornersVisita)   ?? null
  };
}

// Resume el historial en los números que Combinadas Pro necesita
function resumir(ultimos) {
  const n = ultimos.length;
  if (!n) return { partidos: 0 };
  const prom = f => +(ultimos.reduce((s, x) => s + (f(x) || 0), 0) / n).toFixed(2);
  const pct  = f => +(ultimos.filter(f).length / n).toFixed(3);
  const conStat = k => ultimos.filter(x => x[k] != null);
  const promStat = k => {
    const c = conStat(k);
    return c.length ? +(c.reduce((s, x) => s + x[k], 0) / c.length).toFixed(2) : null;
  };
  return {
    partidos: n,
    golesFavor:  prom(x => x.gf),
    golesContra: prom(x => x.gc),
    // Lo que alimenta los tres mercados que acordamos
    pctMas25: pct(x => (x.gf + x.gc) > 2.5),
    pctMas15: pct(x => (x.gf + x.gc) > 1.5),
    pctAmbosAnotan: pct(x => x.gf > 0 && x.gc > 0),
    pctGana:   pct(x => x.gf > x.gc),
    pctEmpata: pct(x => x.gf === x.gc),
    // Y el perfil que preguntabas: ¿gana apretado o goleando?
    pctGanaPorUno: pct(x => x.gf - x.gc === 1),
    pctGanaPorDosOMas: pct(x => x.gf - x.gc >= 2),
    amarillas: promStat('amarillas'),
    corners:   promStat('corners'),
    // Con pocos partidos el número existe pero no significa nada. El motor de
    // cupones usa esto para decidir cuánto caso hacerle a la ficha.
    confianza: Math.min(1, +(n / VENTANA).toFixed(2))
  };
}

// Mezcla los partidos nuevos con lo que ya había, sin repetir
function actualizarFicha(fichaPrevia, nuevas) {
  const vistos = new Set();
  const todos = [...nuevas, ...((fichaPrevia && fichaPrevia.ultimos) || [])]
    .filter(x => { if (vistos.has(x.id)) return false; vistos.add(x.id); return true; })
    .sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')))
    .slice(0, VENTANA);
  return { ultimos: todos, ...resumir(todos) };
}


// ── MEMORIA LARGA ───────────────────────────────────────────────────────────
// La ficha recuerda los últimos 20 partidos con detalle. Eso es la memoria
// corta: sirve para saber cómo está el equipo AHORA.
//
// Pasados 90 días el detalle ya no le aporta a nadie, pero tirarlo sería
// perder historia. Así que se comprime: de N documentos con marcador, minuto y
// estadísticas, quedan ocho números que ocupan lo mismo tenga 40 partidos o
// 4.000. Es lo que permite que el sistema recuerde años sin pesar más.
const DIAS_DETALLE = 90;

function sumarAlHistorico(hist, linea) {
  const h = hist || { partidos:0, gf:0, gc:0, over25:0, over15:0, btts:0, gana:0, empata:0, amarillas:0, corners:0, conStats:0 };
  h.partidos++;
  h.gf += linea.gf || 0;
  h.gc += linea.gc || 0;
  if ((linea.gf + linea.gc) > 2.5) h.over25++;
  if ((linea.gf + linea.gc) > 1.5) h.over15++;
  if (linea.gf > 0 && linea.gc > 0) h.btts++;
  if (linea.gf > linea.gc) h.gana++;
  else if (linea.gf === linea.gc) h.empata++;
  if (linea.amarillas != null) { h.amarillas += linea.amarillas; h.corners += (linea.corners || 0); h.conStats++; }
  return h;
}

// Los contadores vueltos porcentajes, en el mismo formato que la memoria corta
function leerHistorico(h) {
  if (!h || !h.partidos) return null;
  const n = h.partidos, r = x => +(x / n).toFixed(3);
  return {
    partidos: n,
    golesFavor: +(h.gf / n).toFixed(2),
    golesContra: +(h.gc / n).toFixed(2),
    pctMas25: r(h.over25), pctMas15: r(h.over15),
    pctAmbosAnotan: r(h.btts), pctGana: r(h.gana), pctEmpata: r(h.empata),
    amarillas: h.conStats ? +(h.amarillas / h.conStats).toFixed(2) : null,
    corners:   h.conStats ? +(h.corners   / h.conStats).toFixed(2) : null
  };
}

// Cómo se combinan las dos memorias. Con pocos partidos recientes, la historia
// larga sostiene el número; con muchos, manda lo reciente porque refleja mejor
// el momento del equipo.
function mezclar(corta, larga) {
  if (!larga) return corta;
  if (!corta || !corta.partidos) return { ...larga, confianza: Math.min(1, larga.partidos / 20), fuente: 'historico' };
  const peso = corta.confianza;                 // 0 a 1 según cuántos recientes hay
  const mix = (a, b) => (a == null || b == null) ? (a ?? b) : +(a * peso + b * (1 - peso)).toFixed(3);
  return {
    ...corta,
    golesFavor:     mix(corta.golesFavor, larga.golesFavor),
    golesContra:    mix(corta.golesContra, larga.golesContra),
    pctMas25:       mix(corta.pctMas25, larga.pctMas25),
    pctMas15:       mix(corta.pctMas15, larga.pctMas15),
    pctAmbosAnotan: mix(corta.pctAmbosAnotan, larga.pctAmbosAnotan),
    pctGana:        mix(corta.pctGana, larga.pctGana),
    partidosTotales: corta.partidos + larga.partidos,
    fuente: 'mixto'
  };
}

module.exports = { normEquipo, lineaDe, resumir, actualizarFicha, VENTANA,
                   sumarAlHistorico, leerHistorico, mezclar, DIAS_DETALLE };

// ── Resolver un cupón contra los resultados ─────────────────────────────────
// Devuelve true, false o null. Null cuando falta algún resultado: el cupón se
// deja pendiente y se vuelve a intentar mañana, en vez de darlo por perdido.
function acerto(opcion, r) {
  if (!r || r.golesLocal == null) return null;
  const gl = r.golesLocal, gv = r.golesVisita, tot = gl + gv;
  switch (opcion.mercado) {
    case '1X2':
      return opcion.via === '1' ? gl > gv : opcion.via === '2' ? gv > gl : gl === gv;
    case 'GOL_OU': {
      const linea = parseFloat(String(opcion.linea || '').replace('_', '.'));
      if (!isFinite(linea)) return null;
      return opcion.via === 'OVER' ? tot > linea : tot < linea;
    }
    case 'BTTS':
      return opcion.via === 'SI' ? (gl > 0 && gv > 0) : !(gl > 0 && gv > 0);
    case 'DC':
      return opcion.via === '1X' ? gl >= gv
           : opcion.via === 'X2' ? gv >= gl
           : gl !== gv;
    default: return null;
  }
}

// Un cupón pega solo si pegan todas sus opciones
function resolverCupon(cupon, resultadoDe) {
  let faltan = 0;
  for (const o of cupon.opciones || []) {
    const r = acerto(o, resultadoDe(o));
    if (r === null) { faltan++; continue; }
    if (r === false) return { estado: 'perdido', faltan: 0 };   // una basta para perderlo
  }
  if (faltan) return { estado: 'pendiente', faltan };
  return { estado: 'ganado', faltan: 0 };
}

module.exports.acerto = acerto;
module.exports.resolverCupon = resolverCupon;

// ── Calibración ─────────────────────────────────────────────────────────────
// La pregunta que ningún grupo de Telegram responde: cuando el bot dice que un
// cupón tiene 5% de probabilidad, ¿cuántos de esos pegan de verdad?
//
// Si pegan un 5%, el mercado tiene razón y no hay nada que rascar. Si pegan un
// 12%, el mercado se equivoca sistemáticamente ahí y ese es el terreno donde
// vale la pena buscar. Se acumula por franjas porque un cupón suelto no dice
// nada; hacen falta decenas para que el número signifique algo.
const FRANJAS = [
  { id:'0-5',   min:0,    max:0.05 },
  { id:'5-10',  min:0.05, max:0.10 },
  { id:'10-20', min:0.10, max:0.20 },
  { id:'20-35', min:0.20, max:0.35 },
  { id:'35+',   min:0.35, max:1.01 }
];
const franjaDe = p => (FRANJAS.find(f => p >= f.min && p < f.max) || FRANJAS[0]).id;

function sumarCalibracion(previo, cupones) {
  const c = previo && typeof previo === 'object' ? JSON.parse(JSON.stringify(previo)) : {};
  cupones.forEach(({ prob, gano }) => {
    const k = franjaDe(prob || 0);
    const f = c[k] || (c[k] = { n:0, ganados:0, sumaProb:0 });
    f.n++; f.sumaProb += (prob || 0); if (gano) f.ganados++;
  });
  return c;
}

// Traduce los contadores a algo legible, y calla cuando no hay muestra
function leerCalibracion(c) {
  return FRANJAS.map(f => {
    const x = c && c[f.id]; if (!x || !x.n) return null;
    const esperado = x.sumaProb / x.n, real = x.ganados / x.n;
    return {
      franja: f.id + '%', cupones: x.n,
      esperado: +(esperado*100).toFixed(1), real: +(real*100).toFixed(1),
      // Con menos de 30 el número baila demasiado para sacar conclusiones
      fiable: x.n >= 30,
      sesgo: x.n >= 30 ? (real > esperado*1.25 ? 'el mercado subestima'
                        : real < esperado*0.75 ? 'el mercado sobreestima' : 'ajustado') : 'sin muestra'
    };
  }).filter(Boolean);
}

module.exports.sumarCalibracion = sumarCalibracion;
module.exports.leerCalibracion = leerCalibracion;
module.exports.franjaDe = franjaDe;
