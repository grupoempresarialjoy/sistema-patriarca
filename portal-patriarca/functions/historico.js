// ════════════════════════════════════════════════════════════════════════════
// CARGA DEL HISTÓRICO
// football-data.co.uk publica gratis los resultados de 22 divisiones europeas
// desde 1993, con remates, faltas, córners y tarjetas por partido. Y de
// Argentina, Brasil y México, aunque esos solo con goles.
//
// Todo entra a los contadores comprimidos de cada equipo, no al detalle: veinte
// mil partidos ocupan lo mismo que doscientos. Colombia no está en la fuente;
// esa la sigue juntando el vigilante día a día.
// ════════════════════════════════════════════════════════════════════════════

const BASE = 'https://www.football-data.co.uk';

// Divisiones con estadísticas completas. La clave es el código del archivo.
const EUROPEAS = ['E0','E1','SP1','SP2','I1','I2','D1','D2','F1','F2',
                  'N1','B1','P1','T1','G1','SC0'];

// Estas solo traen goles, en un archivo por país con todas las temporadas
const EXTRA = ['ARG','BRA','MEX','USA','JPN'];

function partirCSV(txt) {
  const L = String(txt || '').trim().split('\n');
  if (L.length < 2) return [];
  const cab = L[0].split(',').map(s => s.trim().replace(/^﻿/, ''));
  return L.slice(1).map(l => {
    const c = l.split(',');
    const o = {};
    cab.forEach((k, i) => { o[k] = (c[i] || '').trim(); });
    return o;
  });
}

const num = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };

// Las dos fuentes traen la fecha distinto y ninguna en formato ISO
function fechaDe(f) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(String(f || '').trim());
  if (!m) return null;
  const a = m[3].length === 2 ? 2000 + (+m[3]) : +m[3];
  return `${a}-${String(+m[2]).padStart(2,'0')}-${String(+m[1]).padStart(2,'0')}`;
}

// Un partido, visto desde cada uno de los dos equipos
function lineasDe(r) {
  const hg = num(r.FTHG !== undefined ? r.FTHG : r.HG);
  const ag = num(r.FTAG !== undefined ? r.FTAG : r.AG);
  const local = (r.HomeTeam || r.Home || '').trim();
  const visita = (r.AwayTeam || r.Away || '').trim();
  if (hg == null || ag == null || !local || !visita) return null;
  const fecha = fechaDe(r.Date);
  const id = 'h_' + fecha + '_' + local + '_' + visita;
  return [
    { equipo: local,  linea: { id, fecha, rival: visita, casa: true,  gf: hg, gc: ag,
        amarillas: num(r.HY), corners: num(r.HC) } },
    { equipo: visita, linea: { id, fecha, rival: local,  casa: false, gf: ag, gc: hg,
        amarillas: num(r.AY), corners: num(r.AC) } }
  ];
}

// Temporadas en el formato de las carpetas: 2324, 2425...
function temporadas(cuantas) {
  const hoy = new Date();
  // La temporada europea arranca en agosto
  let a = hoy.getUTCFullYear() - (hoy.getUTCMonth() >= 6 ? 0 : 1);
  const out = [];
  for (let i = 0; i < cuantas; i++, a--) {
    const x = String(a).slice(2), y = String(a + 1).slice(2);
    out.push(x + y);
  }
  return out;
}

async function descargar(traer, anios) {
  const partidos = [];
  const informe = {};

  for (const t of temporadas(anios)) {
    for (const div of EUROPEAS) {
      try {
        const txt = await traer(`${BASE}/mmz4281/${t}/${div}.csv`);
        const filas = partirCSV(txt);
        let n = 0;
        filas.forEach(r => { const p = lineasDe(r); if (p) { partidos.push(...p); n++; } });
        if (n) informe[div + ' ' + t] = n;
      } catch (_) { /* una división que falte no detiene el resto */ }
    }
  }

  // Los archivos extra traen todas las temporadas juntas; se recortan por fecha
  const corte = new Date(Date.now() - anios * 400 * 864e5).toISOString().slice(0, 10);
  for (const pais of EXTRA) {
    try {
      const filas = partirCSV(await traer(`${BASE}/new/${pais}.csv`));
      let n = 0;
      filas.forEach(r => {
        const f = fechaDe(r.Date);
        if (!f || f < corte) return;
        const p = lineasDe(r); if (p) { partidos.push(...p); n++; }
      });
      if (n) informe[pais] = n;
    } catch (_) {}
  }
  return { partidos, informe };
}

module.exports = { descargar, partirCSV, lineasDe, fechaDe, temporadas, EUROPEAS, EXTRA };
