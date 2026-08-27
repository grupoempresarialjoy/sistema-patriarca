// ════════════════════════════════════════════════════════════════════════════
// LIGAS PRINCIPALES
// Copia de la regla que usa el portal para marcar ⭐. Acá sirve para otra cosa:
// decidir a qué partidos vale la pena pedirle los mercados extra, que es lo
// único caro del captador. De 160 partidos guardados solo 23 son de ligas que
// se juegan; pedirle los mercados a los otros 137 es gastar por gastar.
//
// Ojo: si se cambia la lista en el portal, hay que cambiarla acá también.
// ════════════════════════════════════════════════════════════════════════════

const EXCLUIR = new RegExp([
  'reserva', 'reserves', 'sub-?\\d', '\\bu\\d{2}\\b', 'juvenil', 'youth', 'academy',
  'femenin', 'femenil', 'women', '\\(f\\)', 'feminin', 'revelacao',
  'amateur', 'next pro', 'primavera', 'segunda', '2\\.?[ªa]? divisi', '\\bii\\b',
  'primera [bc]\\b', 'ascenso', 'ligue 3', 'la liga 2', 'superettan',
  'eerste divisie', 'serie [cd]\\b', '\\b[23]\\. ?liga', 'league [23]\\b',
  'regionalliga', 'national [23]', 'challenger', 'torneo federal',
  'virtual|cyber|esoccer|esports'
].join('|'), 'i');

const TOP = {
  'inglaterra':'^premier league$|^premier league\\b|championship|fa cup|efl cup|carabao',
  'espana':'la ?liga|copa del rey|supercopa',
  'italia':'serie a\\b|serie b\\b|coppa italia|supercoppa',
  'alemania':'bundesliga|dfb|copa de alemania',
  'francia':'ligue [12]\\b|copa de francia|coupe de france',
  'paises bajos':'eredivisie|knvb', 'holanda':'eredivisie|knvb',
  'portugal':'primeira liga|liga portugal|ta[cç]a de portugal',
  'belgica':'pro league|jupiler', 'turquia':'s[uü]per lig|copa de turqu',
  'rusia':'premier liga|premier league', 'escocia':'premiership',
  'austria':'bundesliga', 'suiza':'super league', 'grecia':'super league',
  'dinamarca':'superliga', 'suecia':'allsvenskan', 'noruega':'eliteserien',
  'polonia':'ekstraklasa', 'chequia':'fortuna liga|chance liga',
  'ucrania':'premier liga|premier league', 'croacia':'hnl', 'serbia':'super ?liga',
  'rumania':'superliga|liga i\\b',
  // "Liga BetPlay" es primera y "Torneo BetPlay" es segunda: buscar solo
  // 'betplay' dejaba pasar el ascenso.
  'colombia':'liga betplay|primera a\\b|copa colombia',
  'argentina':'liga profesional|primera divisi|copa de la liga|copa argentina',
  'brasil':'serie a|brasileir|copa do brasil', 'brazil':'serie a|brasileir|copa do brasil',
  'chile':'primera divisi|campeonato nacional|primera chile|copa chile',
  'peru':'liga 1\\b|primera divisi', 'ecuador':'liga ?pro|serie a',
  'uruguay':'primera divisi|campeonato uruguayo',
  'paraguay':'divisi[oó]n profesional|primera divisi',
  'bolivia':'divisi[oó]n profesional|primera divisi',
  'venezuela':'liga futve|primera divisi',
  'mexico':'liga mx|copa mx', 'estados unidos':'\\bmls\\b|major league soccer',
  'costa rica':'primera divisi|promerica', 'panama':'liga paname|\\blpf\\b',
  'honduras':'liga nacional', 'guatemala':'liga nacional',
  'japon':'j1', 'corea del sur':'k league 1', 'china':'super league',
  'arabia saudita':'pro league|saudi', 'arabia saudi':'pro league|saudi',
  'australia':'a-? ?league', 'india':'indian super', 'tailandia':'thai league 1',
  'egipto':'premier league', 'marruecos':'botola', 'sudafrica':'\\bpsl\\b|premiership'
};
const TOP_RE = {};
Object.entries(TOP).forEach(([p, r]) => { TOP_RE[p] = new RegExp(r, 'i'); });

const INTER = new RegExp([
  'champions league','europa league','conference league','libertadores',
  'sudamericana','recopa','concacaf','mundial','eliminatorias',
  'copa am[eé]rica','eurocopa','nations league'
].join('|'), 'i');

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

function esPrincipal(liga, pais) {
  const l = String(liga || '');
  if (!l || l === '—') return false;
  if (EXCLUIR.test(l)) return false;
  const p = norm(pais);
  if (p) {
    const re = TOP_RE[p];
    if (re) return re.test(l);
    // País reconocido sin liga de primer nivel → fuera. Si no es un país,
    // suele ser la agrupación de un torneo internacional.
    if (TOP_RE.hasOwnProperty(p)) return false;
    return INTER.test(l) || INTER.test(p);
  }
  return INTER.test(l);      // sin país solo pasan los torneos grandes
}

module.exports = { esPrincipal, EXCLUIR, INTER };
