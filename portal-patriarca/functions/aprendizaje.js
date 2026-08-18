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
