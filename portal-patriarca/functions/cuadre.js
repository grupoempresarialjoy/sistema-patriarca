// ════════════════════════════════════════════════════════════════════════════
// CUADRE DIARIO POR OFICINA
// Cada oficina interna (Golden, Unity, ...) tiene su propio cajero. Si se le
// van quedando operaciones sin resolver de un día para otro, hay que
// presionarlo: el primer día de atraso es una advertencia pedagógica; si al
// otro día sigue igual, se bloquea — tanto el envío de operaciones nuevas
// desde el portal del operador como parte del propio portal del cajero.
//
// Esta revisión corre UNA vez al día. Eso ya de por sí regala ~24h de gracia
// a cualquier pendiente antes de que cuente como "atraso": si aparece a las
// 7:01am, no se vuelve a mirar hasta mañana a las 7am. Por eso no hace falta
// filtrar por fecha de creación — basta con contar lo que sigue pendiente en
// el momento de la revisión.
// ════════════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');

// Varias de las colecciones de pendientes no guardan la oficina directamente,
// solo el uid de quien generó la operación (mismo patrón ya usado — y antes
// era el bug — en cajero.html: hay que cruzar contra admin_usuarios para
// saber de qué oficina es cada uid).
async function uidsPorOficina(db) {
  const snap = await db.collection('admin_usuarios').get();
  const mapa = new Map(); // oficinaNombre -> Set(uid)
  snap.forEach(d => {
    const u = d.data();
    const oficina = u.oficinaNombre || u.oficina || '';
    if (!oficina || !u.uid) return;
    if (!mapa.has(oficina)) mapa.set(oficina, new Set());
    mapa.get(oficina).add(u.uid);
  });
  return mapa;
}

function oficinaDeUid(mapa, uid) {
  if (!uid) return null;
  for (const [oficina, uids] of mapa) if (uids.has(uid)) return oficina;
  return null;
}

async function contarPendientesPorOficina(db) {
  const mapa = await uidsPorOficina(db);
  const conteo = new Map(); // oficinaNombre -> número de pendientes
  const sumar = (oficina, n) => { if (oficina) conteo.set(oficina, (conteo.get(oficina) || 0) + n); };

  // 1) Movimientos que el operador mandó y el cajero no ha aceptado/rechazado.
  //    Los internos (I-OP) nacen ya "Realizada" — nunca entran aquí.
  //    Ojo con los eliminados: cuando se aprueba una solicitud de eliminación
  //    el movimiento queda con eliminado:true pero estado_cajero nunca se
  //    toca — sigue diciendo "Pendiente" para siempre aunque ya no exista
  //    para nadie. Si no se descarta aquí, bloquea la oficina por un
  //    pendiente fantasma (mismo bug que ya se había resuelto en el panel
  //    del Dashboard del admin — aquí faltaba el mismo filtro).
  const movsSnap = await db.collection('patriarca_movimientos')
    .where('estado_cajero', '==', 'Pendiente').get();
  movsSnap.forEach(d => {
    const m = d.data();
    if (m.eliminado) return;
    sumar(oficinaDeUid(mapa, m.opId), 1);
  });

  // 2) Correcciones de inversión sin resolver
  const corrSnap = await db.collection('patriarca_ix_correcciones')
    .where('estado', '==', 'pendiente').get();
  corrSnap.forEach(d => sumar(oficinaDeUid(mapa, d.data().solicitante_uid), 1));

  // 3) Intercambios entre operadores sin confirmar por el cajero
  const ixSnap = await db.collection('patriarca_intercambios')
    .where('estado', 'in', ['pendiente_cajera', 'pendiente_op2']).get();
  ixSnap.forEach(d => {
    const ix = d.data();
    const oficina = oficinaDeUid(mapa, ix.op1_uid) || oficinaDeUid(mapa, ix.op2_uid);
    sumar(oficina, 1);
  });

  // 4) Pagos y retiros del corresponsal — estos sí traen la oficina directa
  const pagosSnap = await db.collection('corresponsal_pagos_op')
    .where('estado', '==', 'pendiente').get();
  pagosSnap.forEach(d => sumar(d.data().oficina, 1));

  const retirosSnap = await db.collection('corresponsal_retiros')
    .where('estado', '==', 'pendiente').get();
  retirosSnap.forEach(d => sumar(d.data().oficina, 1));

  // Todas las oficinas conocidas entran al resultado aunque estén en cero —
  // así una oficina que se puso al día se resetea en vez de quedar huérfana
  // con el último estado que tenía guardado.
  const oficinasSnap = await db.collection('admin_oficinas').get();
  oficinasSnap.forEach(d => {
    const nombre = d.data().nombre;
    if (nombre && !conteo.has(nombre)) conteo.set(nombre, 0);
  });

  return conteo;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function mesKey(f) { return f.getFullYear() + '-' + pad2(f.getMonth() + 1); }
function diaKey(f) { return mesKey(f) + '-' + pad2(f.getDate()); }

async function vigilarCuadre(db) {
  const conteo = await contarPendientesPorOficina(db);
  const ahora = new Date();
  const hoy = diaKey(ahora);
  const mes = mesKey(ahora);
  const resumen = [];

  for (const [oficina, pendientes] of conteo) {
    const ref = db.collection('patriarca_cuadre_estado').doc(oficina);
    const snap = await ref.get();
    const previo = snap.exists ? snap.data() : { diasAtraso: 0 };

    // Un solo incremento por día de calendario: si esta oficina ya se revisó
    // hoy (por el cron o porque alguien la disparó a mano para probar), no se
    // vuelve a subir el contador — si no, cada corrida manual sumaría un "día"
    // aunque sea el mismo día real. Los documentos de antes de este chequeo no
    // traen `ultimaRevisionDia`, así que en vez de confiar en su diasAtraso
    // acumulado (pudo inflarse antes de este arreglo) se arranca de nuevo en 1.
    const yaRevisadoHoy = previo.ultimaRevisionDia === hoy;

    let estado, diasAtraso;
    if (yaRevisadoHoy) {
      estado = previo.estado || 'ok';
      diasAtraso = previo.diasAtraso || 0;
    } else if (pendientes > 0) {
      const base = previo.ultimaRevisionDia ? (previo.diasAtraso || 0) : 0;
      diasAtraso = base + 1;
      estado = diasAtraso >= 2 ? 'bloqueado' : 'advertencia';
    } else {
      diasAtraso = 0;
      estado = 'ok';
    }

    const datos = {
      oficina, estado, pendientes, diasAtraso,
      ultimaRevisionDia: hoy,
      ultimaRevision: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (estado === 'ok') datos.ultimoCuadre = admin.firestore.FieldValue.serverTimestamp();
    await ref.set(datos, { merge: true });

    // Historial mensual, para cuando empecemos a usar esto para multas: un
    // conteo de días incumplidos por oficina y mes, con el detalle de fechas.
    // El chequeo de "ya está hoy en la lista" evita doble conteo si alguien
    // dispara la función a mano el mismo día que ya corrió sola.
    if (estado !== 'ok') {
      const histId = `${oficina}_${mes}`;
      const histRef = db.collection('patriarca_cuadre_historial').doc(histId);
      const histSnap = await histRef.get();
      const fechasPrevias = histSnap.exists ? (histSnap.data().fechas || []) : [];
      if (!fechasPrevias.includes(hoy)) {
        await histRef.set({
          oficina, mes,
          diasIncumplidos: admin.firestore.FieldValue.increment(1),
          fechas: admin.firestore.FieldValue.arrayUnion(hoy),
        }, { merge: true });
      }
    }

    resumen.push({ oficina, pendientes, estado, diasAtraso });
  }

  return { revisadas: resumen.length, resumen };
}

module.exports = { vigilarCuadre, contarPendientesPorOficina };
