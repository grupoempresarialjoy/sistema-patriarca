// ════════════════════════════════════════════════════════════════════════════
// TRIXI BOT — VIGILANCIA AUTOMÁTICA
// ----------------------------------------------------------------------------
// El buscador de patriarca.html (pestaña Trixi Bot) solo corre cuando alguien
// le da clic a "Buscar cuotas". Las ventanas donde una casa paga mal contra
// las demás a veces duran poco, y si nadie está mirando justo en ese momento
// se pierden sin que nadie se entere de que existieron.
//
// Esto es el MISMO cálculo (TB_COM, tbBuscarOportunidad, tbEscanear), pero
// corriendo solo cada pocos minutos sobre lo que ya trae el captador, y
// avisando por el chat interno a quien tenga Trixi Bot habilitado apenas
// aparece algo. No reemplaza el buscador manual — lo respalda para que nada
// se pase por alto entre clic y clic.
//
// Ojo: es una copia del motor que vive en patriarca.html. Si el cálculo
// cambia allá (una comisión nueva, un mercado nuevo), hay que traerlo acá
// también — no se pudo compartir un solo archivo porque uno corre en el
// navegador y el otro en Node.
// ════════════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
const { claveDura } = require('./emparejar');

// ── Comisión por casa + método (copiado de TB_COM en patriarca.html) ──
const TB_COM = {
  'BET PLAY|SUPER GIROS UNITY':2, 'BET PLAY|SUPER GIROS MAQUINA':2,
  'BETSSON|BE MOVIL CAJA':2, 'BETSSON|BE MOVIL MASTER':2, 'BETSSON|PTM PROPIO':1.68, 'BETSSON|MEGA RED':1.6,
  'BWIN|BE MOVIL CAJA':2.5, 'BWIN|BE MOVIL MASTER':2.5,
  'LUCKIA|BE MOVIL CAJA':2, 'LUCKIA|BE MOVIL MASTER':2, 'LUCKIA|PTM PROPIO':1.93, 'LUCKIA|MEGA RED':1.68,
  'RUSHBET|BE MOVIL CAJA':3, 'RUSHBET|BE MOVIL MASTER':3, 'RUSHBET|PTM PROPIO':2.1, 'RUSHBET|MEGA RED':2.1,
  'SPORTIUM|BE MOVIL CAJA':3, 'SPORTIUM|BE MOVIL MASTER':3, 'SPORTIUM|PTM PROPIO':1.85, 'SPORTIUM|MEGA RED':1.68,
  'WPLAY|WPLAY UNITY':3, 'WPLAY|EASY CHANGER':3,
  'YA JUEGOS|BE MOVIL CAJA':3, 'YA JUEGOS|BE MOVIL MASTER':3, 'YA JUEGOS|PTM PROPIO':1.68
};

function tbMejorComision(casa) {
  const c = (casa || '').toUpperCase().trim();
  let mejor = { pct: 0, metodo: null };
  Object.keys(TB_COM).forEach(k => {
    const [ca, me] = k.split('|');
    if (ca === c && TB_COM[k] > mejor.pct) mejor = { pct: TB_COM[k], metodo: me };
  });
  return mejor;
}

const TB_MERCADOS = {
  '1X2':    { nombre: '1X2', vias: ['1','X','2'],
              etiquetas: {'1':'Gana local','X':'Empate','2':'Gana visitante'} },
  'GOL_OU': { nombre: 'Goles', vias: ['OVER','UNDER'], conLinea: true,
              etiquetas: {'OVER':'Más de','UNDER':'Menos de'} },
  'BTTS':   { nombre: 'Ambos anotan', vias: ['SI','NO'],
              etiquetas: {'SI':'Ambos anotan','NO':'No ambos'} },
  'DC_1X_2': { nombre: 'Doble oport. 1X vs 2', vias: ['1X','2'],
               etiquetas: {'1X':'Local o empate','2':'Gana visitante'} },
  'DC_X2_1': { nombre: 'Doble oport. X2 vs 1', vias: ['X2','1'],
               etiquetas: {'X2':'Empate o visitante','1':'Gana local'} },
  'DC_12_X': { nombre: 'Doble oport. 12 vs X', vias: ['12','X'],
               etiquetas: {'12':'Local o visitante','X':'Empate'} }
};
const TB_PARES_DC = [['DC_1X_2','1X','2'], ['DC_X2_1','X2','1'], ['DC_12_X','12','X']];

function tbLinea(v) { return v ? String(v).replace('_', '.') : ''; }

function tbMercadosDeEvento(ev) {
  const lista = [];
  Object.entries(ev.cuotas || {}).forEach(([clave, porCasa]) => {
    if (clave.split('|')[0] === 'DC') return;      // se expande abajo
    lista.push({ clave, porCasa });
  });
  const dc = (ev.cuotas || {})['DC'], x12 = (ev.cuotas || {})['1X2'];
  if (dc && x12) {
    TB_PARES_DC.forEach(([clave, viaDC, via12]) => {
      const porCasa = {};
      new Set([...Object.keys(dc), ...Object.keys(x12)]).forEach(casa => {
        const a = dc[casa] && dc[casa][viaDC], b = x12[casa] && x12[casa][via12];
        if (a || b) porCasa[casa] = { [viaDC]: a, [via12]: b };
      });
      if (Object.keys(porCasa).length) lista.push({ clave, porCasa });
    });
  }
  return lista;
}

// Dado un evento y un mercado, encuentra la mejor combinación entre casas.
// Igual a tbBuscarOportunidad() en patriarca.html.
function tbBuscarOportunidad(cuotasMercado, vias, capital, casasPermitidas) {
  const casas = Object.keys(cuotasMercado).filter(c => !casasPermitidas || casasPermitidas.includes(c));
  if (casas.length === 0) return null;

  const mejores = {};
  for (const via of vias) {
    let best = null;
    for (const casa of casas) {
      const cuota = parseFloat(cuotasMercado[casa] && cuotasMercado[casa][via]);
      if (!cuota || cuota <= 1) continue;
      const com = tbMejorComision(casa).pct;
      const efectiva = cuota / (1 - com / 100);
      if (!best || efectiva > best.efectiva + 1e-9) best = { casa, cuota, com, efectiva };
    }
    if (!best) return null;
    mejores[via] = best;
  }

  let sumaImplicita = 0;
  vias.forEach(v => { sumaImplicita += 1 / mejores[v].cuota; });

  let acumulado = 0;
  const patas = vias.map((via, i) => {
    const { casa, cuota } = mejores[via];
    const exacto = capital * (1 / cuota) / sumaImplicita;
    const stake  = (i === vias.length - 1) ? (capital - acumulado) : Math.round(exacto);
    acumulado   += stake;
    const com    = tbMejorComision(casa);
    return {
      via, casa, cuota, stake,
      metodo: com.metodo, comPct: com.pct,
      comValor: Math.round(stake * com.pct / 100),
      retorno: Math.round(stake * cuota)
    };
  });

  const totalStake = patas.reduce((s, p) => s + p.stake, 0);
  const totalCom   = patas.reduce((s, p) => s + p.comValor, 0);
  const retornoMin = Math.min(...patas.map(p => p.retorno));
  const utilidadPura = retornoMin - totalStake;
  const utilidadNeta = utilidadPura + totalCom;

  const comPromedio = totalStake > 0 ? (totalCom / totalStake) : 0;
  const techo = comPromedio < 1 ? 1 / (1 - comPromedio) : Infinity;
  let zona;
  if (sumaImplicita < 1) zona = 'arbitraje';
  else if (sumaImplicita <= techo) zona = 'segura';
  else zona = 'inviable';

  return {
    patas, sumaImplicita, totalStake, totalCom, retornoMin,
    utilidadPura, utilidadNeta,
    utilidadPct: totalStake > 0 ? (utilidadNeta / totalStake * 100) : 0,
    esArbitrajePuro: sumaImplicita < 1,
    mismaCasa: new Set(patas.map(p => p.casa)).size === 1,
    zona, techoSuma: techo, comPromedio
  };
}

// Igual a tbEscanear() en patriarca.html.
function tbEscanear(eventos, opciones) {
  const { capital, casasPermitidas, utilidadMinPct, mercadosPermitidos, ligasPermitidas } = opciones;
  const salida = [];

  eventos.forEach(ev => {
    if (ligasPermitidas && !ligasPermitidas.includes(ev.liga || '—')) return;
    tbMercadosDeEvento(ev).forEach(({ clave: claveMercado, porCasa: cuotasPorCasa }) => {
      const [mid, linea] = claveMercado.split('|');
      if (mercadosPermitidos && !mercadosPermitidos.includes(mid)) return;
      const def = TB_MERCADOS[mid];
      if (!def) return;

      const op = tbBuscarOportunidad(cuotasPorCasa, def.vias, capital, casasPermitidas);
      if (!op) return;
      if (op.utilidadPct < (utilidadMinPct || 0)) return;

      salida.push({
        evento: ev, mercadoId: mid, claveMercado,
        mercadoNombre: def.nombre, linea: linea ? tbLinea(linea) : null,
        etiquetas: def.etiquetas, ...op
      });
    });
  });

  return salida.sort((a, b) => b.utilidadNeta - a.utilidadNeta);
}

// ── Fecha en Colombia ────────────────────────────────────────────────────────
function tbHoyBogota() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function tbFechaBogota(offsetDias) {
  const base = new Date(tbHoyBogota() + 'T12:00:00');
  base.setDate(base.getDate() + (offsetDias || 0));
  const y = base.getFullYear(), m = String(base.getMonth()+1).padStart(2,'0'), d = String(base.getDate()).padStart(2,'0');
  return `${y}-${m}-${d}`;
}

function tbPeso(n) { return (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('es-CO'); }

function tbResumenTexto(op) {
  const ev = op.evento;
  const casas = [...new Set(op.patas.map(p => p.casa))].join(' + ');
  const etiqueta = op.zona === 'segura' ? 'gana por comisión' : 'surebet · gana por las dos vías';
  return `${ev.local} vs ${ev.visitante} — ${op.mercadoNombre}${op.linea ? ' ' + op.linea : ''} — ` +
    `${op.utilidadPct.toFixed(2)}% (${casas}) · ${etiqueta}\n${ev.liga || ''}${ev.pais ? ' (' + ev.pais + ')' : ''} · ${ev.fecha} ${ev.hora || ''}`;
}

// ── Tarjeta de la oportunidad, como imagen ──────────────────────────────────
// Calcada del dibujante de cpDibujar() en patriarca.html (mismo estilo que la
// tarjeta de Combinada), pero armada como SVG en vez de <canvas> — Node no
// tiene lienzo del navegador. El chat interno pinta cualquier imagen con
// <img src="...">, así que un data URL de SVG se ve exactamente igual que uno
// de PNG, sin necesitar ninguna librería nueva para "dibujar".
//
// El isotipo de AJ1.6 es el mismo SVG en base64 que usa CP_MARCA allá — se
// copió tal cual para que la tarjeta se vea de la misma marca.
const TB_AJ_LOGO = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTI5LjgiIGhlaWdodD0iMTM2LjYiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgdmlld0JveD0iMCAwIDEyOS44MCAxMzYuNjAiIHJvbGU9ImltZyIgYXJpYS1sYWJlbD0iQUoxLjYgQWNhZGVtaWEiPjxkZWZzPjxjbGlwUGF0aCBpZD0iYzciPjxwYXRoIGQ9Ik0gMzAyIDM1NCBMIDMzOSAzNTQgTCAzMzkgMzc5LjU0Njg3NSBMIDMwMiAzNzkuNTQ2ODc1IFogTSAzMDIgMzU0ICIvPjwvY2xpcFBhdGg+PC9kZWZzPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKC0yNDMuNzAsLTMyMy45MCkiPjxwYXRoIGZpbGw9IiMzNUNDMkYiIGQ9Ik0gMzcyLjMyODEyNSAzNTguNzg1MTU2IEwgMzQ1LjkyOTY4OCAzNTguNzg1MTU2IEMgMzQ1LjkyOTY4OCAzNTguNzg1MTU2IDM0NS41MzUxNTYgMzg2LjM5ODQzOCAzNDUuMDMxMjUgMzk1LjY4NzUgQyAzNDQuMzE2NDA2IDQwOC44MjQyMTkgMzM0LjIzMDQ2OSA0MjcuNDg0Mzc1IDMwNy41MzEyNSA0MzEuOTg0Mzc1IEMgMjk1Ljg0NzY1NiA0MzMuOTUzMTI1IDI3MS44MzU5MzggNDMwLjEwOTM3NSAyNjAuMTMyODEyIDQzMS45ODQzNzUgQyAyNTEuMTIxMDk0IDQzMy40MjU3ODEgMjQ1Ljc1MzkwNiA0NDAuNjgzNTk0IDI0My45NTMxMjUgNDU4LjY4MzU5NCBDIDI0My45NTMxMjUgNDU4LjY4MzU5NCAyOTMuNzY5NTMxIDQ1OS4zMTI1IDMxMy4yMzA0NjkgNDU4LjA4MjAzMSBDIDMzNC41MTE3MTkgNDU2LjczODI4MSAzNjUuMzc1IDQ1MS44ODI4MTIgMzcyLjMyODEyNSAzOTYuNTg1OTM4IEMgMzczLjUwNzgxMiAzODcuMjEwOTM4IDM3Mi4zMjgxMjUgMzU4Ljc4NTE1NiAzNzIuMzI4MTI1IDM1OC43ODUxNTYiLz48ZyBjbGlwLXBhdGg9InVybCgjYzcpIj48cGF0aCBmaWxsPSIjMjRCRjYyIiBkPSJNIDMxNS45NTcwMzEgNDYwLjUyMzQzOCBDIDMxNS45Mjk2ODggNDU5Ljc2NTYyNSAzMTUuODgyODEyIDQ1OS4wMTE3MTkgMzE1Ljg4MjgxMiA0NTguMjUzOTA2IEMgMzE1Ljg3ODkwNiA0NTAuNDU3MDMxIDMxNS44ODI4MTIgNDQyLjY2NDA2MiAzMTUuODc4OTA2IDQzNC44NjcxODggQyAzMTUuODc1IDQyOC4yOTI5NjkgMzE1Ljg1NTQ2OSA0MjEuNzE4NzUgMzE1Ljg1MTU2MiA0MTUuMTQwNjI1IEMgMzE1Ljg0NzY1NiA0MDguNTY2NDA2IDMxNS44NTE1NjIgNDAxLjk4ODI4MSAzMTUuODUxNTYyIDM5NS40MTQwNjIgQyAzMTUuODUxNTYyIDM5MC4zMTY0MDYgMzE1Ljg0Mzc1IDM4NS4yMjI2NTYgMzE1LjgzOTg0NCAzODAuMTI1IEMgMzE1LjgzOTg0NCAzNzkuOTQ5MjE5IDMxNS44MjAzMTIgMzc5Ljc3MzQzOCAzMTUuODA0Njg4IDM3OS41NTg1OTQgQyAzMTEuMzM5ODQ0IDM3OS41NjI1IDMwNi45MTAxNTYgMzc5LjU2MjUgMzAyLjMyNDIxOSAzNzkuNTY2NDA2IEMgMzA4LjM1MTU2MiAzNzEuMTE3MTg4IDMxNC4zMDQ2ODggMzYyLjc2NTYyNSAzMjAuMzE2NDA2IDM1NC4zMzU5MzggQyAzMjYuMzI0MjE5IDM2Mi43MzQzNzUgMzMyLjI4NTE1NiAzNzEuMDcwMzEyIDMzOC4zMjAzMTIgMzc5LjUwMzkwNiBDIDMzMy43ODkwNjIgMzc5LjUwNzgxMiAzMjkuMzUxNTYyIDM3OS41MTE3MTkgMzI0LjgzNTkzOCAzNzkuNTE1NjI1IEMgMzI0LjgzNTkzOCAzODAuMjA3MDMxIDMyNC44MzU5MzggMzgwLjgyMDMxMiAzMjQuODM1OTM4IDM4MS40MzM1OTQgQyAzMjQuODQzNzUgMzg1LjYzMjgxMiAzMjQuODUxNTYyIDM4OS44MjgxMjUgMzI0Ljg1NTQ2OSAzOTQuMDI3MzQ0IEMgMzI0Ljg1NTQ2OSAzOTguMjIyNjU2IDMyNC44NTE1NjIgNDAyLjQyMTg3NSAzMjQuODU1NDY5IDQwNi42MTcxODggQyAzMjQuODU5Mzc1IDQxMC44MTY0MDYgMzI0Ljg3MTA5NCA0MTUuMDExNzE5IDMyNC44NzEwOTQgNDE5LjIxMDkzOCBDIDMyNC44NzUgNDIzLjQwNjI1IDMyNC44NzEwOTQgNDI3LjYwNTQ2OSAzMjQuODc1IDQzMS44MDA3ODEgQyAzMjQuODc1IDQzNiAzMjQuODg2NzE5IDQ0MC4xOTUzMTIgMzI0Ljg5MDYyNSA0NDQuMzk0NTMxIEMgMzI0Ljg5NDUzMSA0NDguNTg5ODQ0IDMyNC44ODY3MTkgNDUyLjc4OTA2MiAzMjQuODk0NTMxIDQ1Ni45ODQzNzUgQyAzMjQuODk0NTMxIDQ1OC4xNjAxNTYgMzI0LjkzMzU5NCA0NTkuMzM5ODQ0IDMyNC45NTMxMjUgNDYwLjUxNTYyNSBaIE0gMzE1Ljk1NzAzMSA0NjAuNTIzNDM4Ii8+PC9nPjxwYXRoIGZpbGw9IiMyNEJGNjIiIGQ9Ik0gMzU0LjM0Mzc1IDMyNC45NDkyMTkgQyAzNTQuMzQzNzUgMzI0Ljk0OTIxOSAzMTUuNTgyMDMxIDMyMy45Mjk2ODggMjk1LjAzMTI1IDMyNC45NDkyMTkgQyAyNzQuNzk2ODc1IDMyNS45NTMxMjUgMjQ3LjM1OTM3NSAzMzYuNjQ4NDM4IDI0My42OTUzMTIgMzg3LjY0NDUzMSBMIDI0My42OTUzMTIgNDE5LjgwODU5NCBMIDMxMC40ODQzNzUgNDE5LjgwODU5NCBDIDMxMC40ODQzNzUgNDE5LjgwODU5NCAzMzAuMTI4OTA2IDQxOS40NDUzMTIgMzMxLjE3NTc4MSAzOTQuMjQ2MDk0IEwgMzMwLjY3OTY4OCAzNzguMzQ3NjU2IEwgMzA5LjE3MTg3NSAzNzguMDQ2ODc1IEwgMzA5LjE3MTg3NSAzOTguNDQ1MzEyIEwgMjY2Ljc0MjE4OCAzOTguNDQ1MzEyIEMgMjY2Ljc0MjE4OCAzOTguNDQ1MzEyIDI2MC40NjA5MzggMzc5LjA0Mjk2OSAyNzQuNzgxMjUgMzYxLjY2Nzk2OSBDIDI3OC41MjM0MzggMzU3LjEzMjgxMiAyODYuMDAzOTA2IDM0OC40MDYyNSAzMDAuMjgxMjUgMzQ1LjM0NzY1NiBMIDM0NS4xNjQwNjIgMzQ1LjM0NzY1NiBDIDM0NS4xNjQwNjIgMzQ1LjM0NzY1NiAzNTMuNTU4NTk0IDM0Ni4yNDYwOTQgMzU0LjM0Mzc1IDMyNC45NDkyMTkiLz48L2c+PC9zdmc+';

function tbEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Sin <canvas> no hay measureText real — se parte por cantidad de caracteres,
// una aproximación de sobra para un aviso, no para un documento de cobro.
function tbPartirTexto(txt, maxChars) {
  const palabras = String(txt).split(' ');
  const lineas = []; let actual = '';
  palabras.forEach(p => {
    const prueba = actual ? actual + ' ' + p : p;
    if (prueba.length > maxChars && actual) { lineas.push(actual); actual = p; }
    else actual = prueba;
  });
  if (actual) lineas.push(actual);
  return lineas;
}

function tbTarjetaSVG(op) {
  const ev = op.evento;
  const A = 620, MG = 34;
  const FUENTE = "-apple-system, 'Segoe UI', Roboto, sans-serif";
  const titulo = tbPartirTexto(`${ev.local}  vs  ${ev.visitante}`, 46);

  // Coordenadas explícitas, de arriba a abajo — cada bloque calculado a partir
  // del anterior para que nunca se pisen aunque el título ocupe 1 o 2 líneas.
  const yLabel      = 38;                                  // "TRIXI BOT · ..."
  const yPct        = 44;                                  // % grande, misma fila que el label (izq/der)
  const yTitulo     = 96;                                  // primera línea del partido
  const yTituloFin  = yTitulo + (titulo.length - 1) * 22;  // última línea del partido
  const yMeta       = yTituloFin + 26;                      // liga/país/fecha
  const ySeparador  = yTituloFin + 42;
  const ALTO_FILA   = 44;
  const inicioPatas = ySeparador + 30;                      // 1.ª línea de la 1.ª pata
  const ALTO_PIE    = 72;

  const filasPatas = op.patas.map((p, i) => {
    const yy = inicioPatas + i * ALTO_FILA;
    return `
      <text x="${MG}" y="${yy}" fill="#9aa3b8" font-size="13" font-weight="500" font-family="${FUENTE}">${tbEsc(op.etiquetas[p.via] || p.via)} · ${tbEsc(p.casa)}</text>
      <text x="${A-MG}" y="${yy}" fill="#35CC2F" font-size="17" font-weight="700" font-family="${FUENTE}" text-anchor="end">${p.cuota.toFixed(2)}</text>
      <text x="${MG}" y="${yy+18}" fill="#6b7488" font-size="11" font-family="${FUENTE}">${tbEsc(p.metodo ? p.metodo + ' +' + p.comPct + '%' : 'sin comisión')}</text>
      <text x="${A-MG}" y="${yy+18}" fill="#6b7488" font-size="11" font-family="${FUENTE}" text-anchor="end">apostar ${tbEsc(tbPeso(p.stake))}</text>`;
  }).join('');

  // Fondo del texto de la última pata + aire antes del pie
  const finPatas = inicioPatas + (op.patas.length - 1) * ALTO_FILA + 18;
  const ALTO_TOTAL = finPatas + 30 + ALTO_PIE;

  const cabecera = op.zona === 'segura' ? 'TRIXI BOT · GANA POR COMISIÓN' : 'TRIXI BOT · SUREBET';
  const meta = `${ev.liga || '—'}${ev.pais ? ' (' + ev.pais + ')' : ''} · ${ev.fecha || ''} ${ev.hora || ''}`;
  const cobras = op.retornoMin + op.totalCom;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${A}" height="${ALTO_TOTAL}" viewBox="0 0 ${A} ${ALTO_TOTAL}" font-family="${FUENTE}">
    <rect width="${A}" height="${ALTO_TOTAL}" fill="#12151c"/>
    <rect width="${A}" height="4" fill="#35CC2F"/>
    <text x="${MG}" y="${yLabel}" fill="#8890a8" font-size="11" font-weight="600" letter-spacing="0.5">${tbEsc(cabecera)}</text>
    <text x="${A-MG}" y="${yPct}" fill="#35CC2F" font-size="30" font-weight="700" text-anchor="end">${op.utilidadPct.toFixed(2)}%</text>
    ${titulo.map((l, k) => `<text x="${MG}" y="${yTitulo + k*22}" fill="#e8eaf0" font-size="16" font-weight="600">${tbEsc(l)}</text>`).join('')}
    <text x="${MG}" y="${yMeta}" fill="#6b7488" font-size="12">${tbEsc(meta)}</text>
    <line x1="${MG}" y1="${ySeparador}" x2="${A-MG}" y2="${ySeparador}" stroke="rgba(255,255,255,.08)" stroke-width="1"/>
    ${filasPatas}
    <rect x="0" y="${ALTO_TOTAL-ALTO_PIE}" width="${A}" height="${ALTO_PIE}" fill="rgba(53,204,47,.08)"/>
    <text x="${MG}" y="${ALTO_TOTAL-42}" fill="#8890a8" font-size="12" font-weight="500">Inviertes ${tbEsc(tbPeso(op.totalStake))}</text>
    <text x="${MG}" y="${ALTO_TOTAL-18}" fill="#35CC2F" font-size="22" font-weight="700">Cobras ${tbEsc(tbPeso(cobras))}</text>
    <image x="${A-MG-38}" y="${ALTO_TOTAL-58}" width="38" height="40" href="${TB_AJ_LOGO}"/>
  </svg>`;
}

function tbImagenDataUrl(op) {
  try {
    const svg = tbTarjetaSVG(op);
    return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
  } catch (e) { console.warn('trixibot tarjeta:', e.message); return null; }
}

// Publica en el canal ÚNICO de Trixi Bot (patriarca_chat_trixi) — no uno por
// operador. Antes se escribía el mismo aviso dentro del hilo privado de cada
// persona con trixibot.activo, y en la bandeja del administrador se veía la
// misma oportunidad repetida una vez por operador. Un solo documento por
// oportunidad, que lee todo el que tenga el canal habilitado (client-side,
// contra patriarca_config/{uid}.trixibot.activo) es lo mismo que un anuncio
// del ecosistema, pero de un canal aparte para no mezclarlo con avisos
// generales. Tope de 5 por corrida: si aparecen muchas de golpe, no se
// inunda el canal.
async function notificarOportunidades(db, ops) {
  const aEnviar = ops.slice(0, 5);
  let publicadas = 0;
  for (const op of aEnviar) {
    try {
      const resumen = tbResumenTexto(op);
      const imagen = tbImagenDataUrl(op);
      const ref = db.collection('patriarca_chat_trixi').doc();
      // ref + claveMercado permiten que el cliente vuelva a pedir el evento
      // y recalcule con cuotas frescas al montar la tarjeta en la calculadora.
      let contexto = { tipo: 'trixiOportunidad', resumen, ref: op.evento.id || '', claveMercado: op.claveMercado };
      if (imagen) {
        const img = await ref.collection('imagenes').add({ datos: imagen, ts: admin.firestore.FieldValue.serverTimestamp() });
        contexto.imagenRef = img.id;
      }
      await ref.set({
        texto: '🎰 Trixi Bot encontró una oportunidad nueva',
        autorNombre: '🎰 Trixi Bot', contexto,
        ts: admin.firestore.FieldValue.serverTimestamp()
      });
      publicadas++;
    } catch (e) { console.warn('trixibot canal ->', e.message); }
  }
  return publicadas;
}

// ── Corrida completa: lee eventos, escanea, avisa lo nuevo ──────────────────
// La config vive en trixibot_estado/vigilancia_config para poder ajustarla
// sin redesplegar — si no existe, arranca con valores razonables por defecto.
async function vigilarTrixiBot(db) {
  const cfgSnap = await db.collection('trixibot_estado').doc('vigilancia_config').get();
  const cfg = cfgSnap.exists ? cfgSnap.data() : {};
  const capital            = cfg.capital || 2500000;
  const utilidadMinPct     = cfg.utilidadMinPct != null ? cfg.utilidadMinPct : 1.5;
  const casasPermitidas    = cfg.casas || ['BET PLAY', 'RUSHBET', 'WPLAY', 'YA JUEGOS'];
  const mercadosPermitidos = cfg.mercados || ['1X2', 'GOL_OU', 'BTTS', 'DC_1X_2', 'DC_X2_1', 'DC_12_X'];
  const soloPrincipales    = cfg.soloPrincipales !== false;   // por defecto sí
  const horasReaviso       = cfg.horasReaviso || 1;
  // Umbral de aviso: distinto del umbral de escaneo. Todo lo de arriba de
  // utilidadMinPct se detecta y queda disponible para quien busque manual,
  // pero solo se avisa por chat lo que de verdad compensa el riesgo/esfuerzo
  // de mover la plata (deslizamiento de cuota, comisión de retiro, etc.).
  const notificarMinPct    = cfg.notificarMinPct != null ? cfg.notificarMinPct : 2.5;

  const desde = tbHoyBogota(), hasta = tbFechaBogota(1);
  const snap = await db.collection('trixibot_eventos')
    .where('fecha', '>=', desde).where('fecha', '<=', hasta).get();
  let eventos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (soloPrincipales) eventos = eventos.filter(e => e.principal);

  const ops = tbEscanear(eventos, {
    capital, casasPermitidas, utilidadMinPct, mercadosPermitidos, ligasPermitidas: null
  });

  // No avisar la misma oportunidad una y otra vez mientras siga abierta —
  // un aviso cada 5 minutos del mismo partido sería spam, no ayuda.
  const nuevas = [];
  for (const op of ops) {
    if (op.utilidadPct < notificarMinPct) continue;   // se ve manual, no se avisa
    // El mismo partido real a veces queda guardado en trixibot_eventos bajo
    // dos ids distintos (una casa lo llama "CD Marathón", otra "CD Marathon
    // San Pedro Sula") porque el emparejador es conservador y no los fusiona
    // si no está seguro. Usar el id crudo del documento como llave de aviso
    // hacía que ese mismo partido pareciera "nuevo" dos veces y se avisara
    // de nuevo a los pocos minutos. La llave dura (nombre normalizado + hora
    // redondeada) es la misma para las dos variantes, así que el aviso sí
    // reconoce que ya se avisó, aunque venga de un documento distinto.
    const dura = claveDura({ local: op.evento.local, visita: op.evento.visitante, inicio: op.evento.inicioUTC });
    const idBase = dura || op.evento.id || (op.evento.local + '_' + op.evento.visitante);
    const avisoId = (idBase + '__' + op.claveMercado)
      .toString().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 400);
    const ref = db.collection('trixibot_avisos').doc(avisoId);
    const previo = await ref.get();
    if (previo.exists) {
      const ts = previo.data().ts;
      const antiguedadMs = (ts && ts.toDate) ? Date.now() - ts.toDate().getTime() : Infinity;
      if (antiguedadMs < horasReaviso * 3600 * 1000) continue;
    }
    await ref.set({
      evento: { local: op.evento.local, visitante: op.evento.visitante,
                liga: op.evento.liga, pais: op.evento.pais, fecha: op.evento.fecha, hora: op.evento.hora },
      claveMercado: op.claveMercado, utilidadPct: op.utilidadPct, zona: op.zona,
      ts: admin.firestore.FieldValue.serverTimestamp()
    });
    nuevas.push(op);
  }

  let publicadas = 0;
  if (nuevas.length) publicadas = await notificarOportunidades(db, nuevas);

  const resumen = {
    corridoEn: new Date().toISOString(), eventosEscaneados: eventos.length,
    oportunidades: ops.length, sobreUmbralAviso: ops.filter(o => o.utilidadPct >= notificarMinPct).length,
    nuevas: nuevas.length, publicadasEnCanal: publicadas,
    mejorPct: ops.length ? +ops[0].utilidadPct.toFixed(2) : null
  };
  await db.collection('trixibot_estado').doc('vigilancia').set(resumen);
  return resumen;
}

module.exports = { vigilarTrixiBot, tbEscanear, tbBuscarOportunidad, tbMercadosDeEvento, tbTarjetaSVG, tbImagenDataUrl };
