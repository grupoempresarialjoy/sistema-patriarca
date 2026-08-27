/* ============================================================================
   CONSTRUIR EL PORTAL PARA PUBLICAR
   ----------------------------------------------------------------------------
   Separa lo que se edita de lo que se sube.

   Hasta ahora Firebase publicaba la carpeta entera. Eso significaba que
   cualquiera podía descargar, sin siquiera iniciar sesión:

     · Los portales completos, con 840 comentarios en español explicando
       por qué cada cosa funciona así
     · Las copias .bak-tz, que son el sistema entero con otro nombre
     · Las herramientas fix-*.html, que escriben en la base de datos

   Ahora se publica SOLO lo que este archivo escribe en publico/. Lo que no
   esté en la lista de abajo, sencillamente no llega a internet. Es una lista
   blanca: si mañana aparece otro archivo suelto en la carpeta, no se sube.

   Qué le hace al código
   ---------------------
   · Le quita todos los comentarios
   · Le cambia el nombre a las variables internas (a, e, t...)
   · Le quita saltos de línea y espacios

   Lo que NO toca son los nombres de las funciones que el HTML llama por
   onclick — hay 102 y renombrarlas rompería todos los botones.

   Esto no vuelve el código imposible de copiar; lo vuelve caro de entender.
   Lo que de verdad protege el negocio son los datos, las cuentas y que el
   sistema siga mejorando cada semana.

   Uso:  node construir.js
============================================================================ */

const fs   = require('fs');
const path = require('path');

// Lista blanca. Solo esto llega a internet.
const PUBLICAR = [
  'index.html',
  'patriarca.html',
  'admin.html',
  'cajero.html',
  'trixi.html',
  'chat.js'
];

const RAIZ    = __dirname;
const DESTINO = path.join(RAIZ, 'publico');

// terser es lo único que hace falta instalar, y se instala solo la primera vez.
// Antes el script se limitaba a avisar y morir; eso obligaba a acordarse de un
// comando cada vez que se cambiaba de computador o se limpiaba la carpeta.
async function cargarTerser() {
  try { return require('terser'); } catch (_) {}

  console.log('Falta terser (solo se instala la primera vez). Instalando...\n');
  const { execSync } = require('child_process');
  try {
    execSync('npm install terser --silent --no-audit --no-fund', {
      cwd: RAIZ, stdio: 'inherit'
    });
  } catch (e) {
    console.error('\nNo se pudo instalar terser automáticamente.');
    console.error('Hazlo a mano, una sola vez:\n');
    console.error('   cd "' + RAIZ + '" && npm install terser\n');
    process.exit(1);
  }

  try { return require('terser'); }
  catch (e) {
    console.error('\nterser quedó instalado pero Node no lo encuentra: ' + e.message);
    process.exit(1);
  }
}

async function encoger(terser, js, donde) {
  const r = await terser.minify(js, {
    // toplevel en false: los nombres de arriba se respetan porque el HTML
    // los invoca por nombre desde los onclick.
    mangle:   { toplevel: false },
    compress: { defaults: true, passes: 2 },
    format:   { comments: false }
  });
  if (r.error) throw new Error(donde + ': ' + r.error);
  return r.code;
}

async function procesarHtml(terser, texto, nombre) {
  const RE = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g;
  const partes = [];
  let ultimo = 0, m, bloques = 0;
  while ((m = RE.exec(texto))) {
    partes.push(texto.slice(ultimo, m.index));
    const [todo, attrs, js] = m;
    partes.push('<script' + attrs + '>' + await encoger(terser, js, nombre) + '</script>');
    ultimo = m.index + todo.length;
    bloques++;
  }
  partes.push(texto.slice(ultimo));
  // Comentarios de HTML fuera de los scripts
  const salida = partes.join('').replace(/<!--(?!\[if)[\s\S]*?-->/g, '');
  return { salida, bloques };
}

(async () => {
  const terser = await cargarTerser();

  fs.rmSync(DESTINO, { recursive: true, force: true });
  fs.mkdirSync(DESTINO, { recursive: true });

  let antes = 0, despues = 0;
  console.log('\nConstruyendo publico/\n');

  for (const nombre of PUBLICAR) {
    const origen = path.join(RAIZ, nombre);
    if (!fs.existsSync(origen)) { console.log('  · ' + nombre.padEnd(20) + 'no existe, se salta'); continue; }

    const texto = fs.readFileSync(origen, 'utf8');
    let salida, detalle;

    if (nombre.endsWith('.js')) {
      salida  = await encoger(terser, texto, nombre);
      detalle = '';
    } else {
      const r = await procesarHtml(terser, texto, nombre);
      salida  = r.salida;
      detalle = ' · ' + r.bloques + ' bloques de script';
    }

    fs.writeFileSync(path.join(DESTINO, nombre), salida);
    antes += texto.length; despues += salida.length;

    const kb = n => (n / 1024).toFixed(0) + ' KB';
    console.log('  · ' + nombre.padEnd(20)
      + kb(texto.length).padStart(8) + ' → ' + kb(salida.length).padStart(8)
      + detalle);
  }

  const quedan = (s) => (s.match(/\/\/[^\n]{15,}/g) || []).length;
  const comentariosFuente = PUBLICAR
    .filter(n => fs.existsSync(path.join(RAIZ, n)))
    .reduce((s, n) => s + quedan(fs.readFileSync(path.join(RAIZ, n), 'utf8')), 0);
  const comentariosPublicos = PUBLICAR
    .filter(n => fs.existsSync(path.join(DESTINO, n)))
    .reduce((s, n) => s + quedan(fs.readFileSync(path.join(DESTINO, n), 'utf8')), 0);

  console.log('\n  total     ' + (antes/1024).toFixed(0) + ' KB → ' + (despues/1024).toFixed(0) + ' KB'
    + '   (' + ((1 - despues/antes) * 100).toFixed(0) + '% menos)');
  console.log('  comentarios   ' + comentariosFuente + ' → ' + comentariosPublicos);
  console.log('\nListo. Se publica publico/ y nada más.\n');
})();
