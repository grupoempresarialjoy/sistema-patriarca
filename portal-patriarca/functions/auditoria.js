// ════════════════════════════════════════════════════════════════════════════
// AUDITORÍA — saldo de cliente que no se convierte en inversión
// ────────────────────────────────────────────────────────────────────────────
// Ojo: esto NO es lo mismo que el "modo auditoría" de patriarca_config_global
// (el candado que congela el portal para una auditoría externa). Esto es una
// vigilancia distinta, propia de la Fase 2: dinero que entra como recarga a
// la cuenta de un cliente y nunca se convierte en inversión — la señal que
// describió Ronaldo de "recargo a un cliente, no invierte nada, y luego digo
// que el cliente fue bloqueado" sin que nada lo compruebe.
//
// La fórmula de saldo es la misma que ya usa el dashboard del operador
// (patriarca.html, línea ~3663): recargas − pagos − inversión + retorno,
// pero agrupada por cliente_id + casa (no por el texto del nombre, que puede
// venir mal escrito) y calculada del lado del servidor para TODOS los
// operadores a la vez — algo que hoy no existe en ningún lado del portal.
//
// Sensible: solo el administrador debe poder ver esto (firestore.rules).
// ════════════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');

function auHoyBogota() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function auFechaBogota(offsetDias) {
  const base = new Date(auHoyBogota() + 'T12:00:00');
  base.setDate(base.getDate() + (offsetDias || 0));
  const y = base.getFullYear(), m = String(base.getMonth()+1).padStart(2,'0'), d = String(base.getDate()).padStart(2,'0');
  return `${y}-${m}-${d}`;
}
function auDiasEntre(fechaA, fechaB) {
  // Ambas en 'YYYY-MM-DD'. Aproximado a días de calendario, de sobra para el umbral.
  const a = new Date(fechaA + 'T12:00:00'), b = new Date(fechaB + 'T12:00:00');
  return Math.round((b - a) / 86400000);
}

function auSanitizarId(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 300);
}

async function auMapaOperadores(db) {
  const snap = await db.collection('admin_usuarios').get();
  const mapa = new Map(); // uid -> { nombre, oficinaNombre }
  snap.forEach(d => {
    const u = d.data();
    if (!u.uid) return;
    mapa.set(u.uid, { nombre: u.nombre || u.uid, oficinaNombre: u.oficinaNombre || u.oficina || '' });
  });
  return mapa;
}

// ── Corrida completa ─────────────────────────────────────────────────────
async function vigilarAuditoria(db) {
  const cfgSnap = await db.collection('auditoria_estado').doc('config').get();
  const cfg = cfgSnap.exists ? cfgSnap.data() : {};
  const diasAlerta   = cfg.diasAlerta   != null ? cfg.diasAlerta   : 3;
  const saldoMinimo  = cfg.saldoMinimo  != null ? cfg.saldoMinimo  : 50000;
  const ventanaDias  = cfg.ventanaDias  != null ? cfg.ventanaDias  : 90;
  // Un cliente con mucha plata quieta no puede esperar los mismos 3 días que
  // uno con poca — mientras más grande el monto, más rápido hay que verlo.
  // (Se subió de $300.000/1 día: en la práctica mucha gente recarga y apuesta
  // al día siguiente, así que con esos números casi todo salía "urgente" sin
  // serlo de verdad — ver conversación del 2026-09-15.)
  const saldoUrgente      = cfg.saldoUrgente      != null ? cfg.saldoUrgente      : 1000000;
  const diasAlertaUrgente = cfg.diasAlertaUrgente != null ? cfg.diasAlertaUrgente : 2;

  const hoy   = auHoyBogota();
  const desde = auFechaBogota(-ventanaDias);

  const [operadores, clientesSnap, movsSnap, invsSnap] = await Promise.all([
    auMapaOperadores(db),
    db.collection('patriarca_clientes').get(),
    // Sin el filtro de 'tipo' acá: combinar un rango (fecha) con un 'in'
    // (tipo) exige un índice compuesto en Firestore. Es más simple filtrar
    // el tipo en el código de abajo que pedirle al administrador que cree
    // un índice a mano en la consola de Firebase.
    db.collection('patriarca_movimientos').where('fecha', '>=', desde).get(),
    db.collection('patriarca_inversiones').where('fecha', '>=', desde).get(),
  ]);

  const clientesPorId = new Map();
  clientesSnap.forEach(d => clientesPorId.set(d.id, d.data()));

  // El cliente "Externo" es el cajón donde va todo lo que no se asocia a una
  // persona real — no tiene sentido auditarlo como si fuera un cliente
  // puntual. No siempre viene con el id del sistema (_externo_): a veces se
  // escribió a mano como texto "Externo" sin usar el cliente real, así que
  // hay que descartarlo también por nombre (misma normalización que ya usa
  // saveCliente() en patriarca.html para detectar duplicados de "Externo").
  function esExterno(clienteId, clienteNombre) {
    if (clienteId === '_externo_') return true;
    const norm = (clienteNombre || '').toLowerCase().replace(/[()]/g, '').replace(/cliente/g, '').trim();
    return norm === 'externo';
  }

  // Agrupar por cliente_id (o, si no viene, por nombre) + casa.
  const grupos = new Map();
  const llave = (clienteId, clienteNombre, casa) => {
    const base = clienteId || ('n:' + (clienteNombre || '').toUpperCase().trim());
    return `${base}||${(casa || '').toUpperCase().trim()}`;
  };
  const asegurar = (k, opId, clienteId, clienteNombre, casa) => {
    if (!grupos.has(k)) {
      grupos.set(k, {
        opId, clienteId: clienteId || null, clienteNombre: clienteNombre || '(sin nombre)', casa,
        saldo: 0, metodos: new Set(), primeraRecarga: null, ultimaRecarga: null,
        ultimaInversion: null, numRecargas: 0, numPagos: 0, numInversiones: 0,
      });
    }
    return grupos.get(k);
  };

  movsSnap.forEach(d => {
    const m = d.data();
    if (m.tipo !== 'RECARGAS' && m.tipo !== 'PAGOS') return;
    if (!m.cliente_id && !m.cliente) return;
    if (esExterno(m.cliente_id, m.cliente)) return;
    if (!m.casa) return;
    const k = llave(m.cliente_id, m.cliente, m.casa);
    const g = asegurar(k, m.opId, m.cliente_id, m.cliente, m.casa);
    const monto = parseFloat(m.monto) || 0;
    if (m.tipo === 'RECARGAS') {
      g.saldo += monto;
      g.numRecargas++;
      if (m.metodo) g.metodos.add(m.metodo);
      if (!g.primeraRecarga || m.fecha < g.primeraRecarga) g.primeraRecarga = m.fecha;
      if (!g.ultimaRecarga || m.fecha > g.ultimaRecarga) g.ultimaRecarga = m.fecha;
    } else if (m.tipo === 'PAGOS') {
      g.saldo -= monto;
      g.numPagos++;
    }
  });

  invsSnap.forEach(d => {
    const inv = d.data();
    if (!inv.cliente_id && !inv.cliente) return;
    if (esExterno(inv.cliente_id, inv.cliente)) return;
    if (!inv.casa) return;
    const k = llave(inv.cliente_id, inv.cliente, inv.casa);
    // Solo contar inversión si el grupo ya existe (viene de una recarga) —
    // una inversión sin recarga previa registrada es otro tipo de problema
    // (fondos sin origen), no el que se está buscando acá.
    if (!grupos.has(k)) return;
    const g = grupos.get(k);
    const monto = parseFloat(inv.monto) || 0;
    const ret   = parseFloat(inv.retorno_cliente) || 0;
    g.saldo -= monto;
    if (ret > 0) g.saldo += ret;
    g.numInversiones++;
    if (!g.ultimaInversion || inv.fecha > g.ultimaInversion) g.ultimaInversion = inv.fecha;
  });

  let activas = 0, resueltas = 0, nuevas = 0;
  const nuevasDetalle = [];
  let lote = db.batch();
  let opsEnLote = 0;
  // Un WriteBatch no se puede reusar después de comprometerlo (commit) — hay
  // que empezar uno nuevo cada vez, si no la siguiente escritura revienta.
  const commitSiHaceFalta = async () => {
    if (opsEnLote >= 400) { await lote.commit(); lote = db.batch(); opsEnLote = 0; }
  };

  for (const [k, g] of grupos) {
    if (g.saldo < 1) continue; // saldo negativo o cero: no hay nada "guardado" que auditar

    const cliente = g.clienteId ? clientesPorId.get(g.clienteId) : null;
    const bloqueado = !!(cliente && cliente.bloqueado);

    const referencia = g.ultimaInversion || g.primeraRecarga;
    const diasSinInvertir = referencia ? auDiasEntre(referencia, hoy) : 0;

    const id = auSanitizarId(k);
    const ref = db.collection('patriarca_auditoria_alertas').doc(id);
    const op = operadores.get(g.opId) || {};

    // Un solo get() para todo: ya sea para decidir si suprimirla (enGestion,
    // igual que un cliente bloqueado) o para saber si ya estaba activa.
    const prevSnap = await ref.get();
    const prevData = prevSnap.exists ? prevSnap.data() : null;
    // Alguien ya la pasó a mano a "Cartera en riesgo" — no hay que volver a
    // subirla a Alertas activas solo porque el saldo sigue igual; ya se le
    // está haciendo seguimiento en otro lado.
    const enGestion = !!(prevData && prevData.enGestion);

    const esUrgente = g.saldo >= saldoUrgente && diasSinInvertir >= diasAlertaUrgente;
    const esNormal  = g.saldo >= saldoMinimo  && diasSinInvertir >= diasAlerta;
    const cumpleCondicion = (esUrgente || esNormal) && !bloqueado && !enGestion;

    if (cumpleCondicion) {
      const esNueva = !prevData || prevData.activa !== true;
      lote.set(ref, {
        opId: g.opId, operadorNombre: op.nombre || g.opId, oficinaNombre: op.oficinaNombre || '',
        clienteId: g.clienteId, clienteNombre: g.clienteNombre, casa: g.casa,
        metodos: [...g.metodos], saldo: Math.round(g.saldo),
        numRecargas: g.numRecargas, numPagos: g.numPagos, numInversiones: g.numInversiones,
        primeraRecarga: g.primeraRecarga, ultimaRecarga: g.ultimaRecarga,
        ultimaInversion: g.ultimaInversion || null, diasSinInvertir,
        clienteBloqueado: bloqueado, urgente: esUrgente,
        activa: true, esNueva,
        actualizadaEn: admin.firestore.FieldValue.serverTimestamp(),
        ...(esNueva ? { creadaEn: admin.firestore.FieldValue.serverTimestamp() } : {}),
      }, { merge: true });
      opsEnLote++;
      activas++;
      if (esNueva) {
        nuevas++;
        nuevasDetalle.push({
          operadorNombre: op.nombre || g.opId, oficinaNombre: op.oficinaNombre || '',
          clienteNombre: g.clienteNombre, casa: g.casa, saldo: Math.round(g.saldo),
          diasSinInvertir, metodos: [...g.metodos], urgente: esUrgente,
        });
      }
      await commitSiHaceFalta();
    } else if (prevData && prevData.activa === true) {
      // Si existía activa y ya dejó de cumplir (invirtió, bajó el saldo, se
      // marcó bloqueado formalmente, o se pasó a Cartera en riesgo), se
      // resuelve — no se borra, para no perder el rastro de que existió.
      lote.update(ref, { activa: false, resueltaEn: admin.firestore.FieldValue.serverTimestamp() });
      opsEnLote++;
      resueltas++;
      await commitSiHaceFalta();
    }
  }
  // Huérfanas: alertas que quedaron activas de una corrida anterior pero ya
  // ni siquiera entran al agrupamiento de esta corrida (por ejemplo, "Externo"
  // antes de este arreglo) — sin esto se quedarían en "activa" para siempre,
  // porque el bucle de arriba solo revisa las claves que sí existen hoy.
  const idsVigentes = new Set([...grupos.keys()].map(auSanitizarId));
  const huerfanasSnap = await db.collection('patriarca_auditoria_alertas').where('activa', '==', true).get();
  huerfanasSnap.forEach(d => {
    if (idsVigentes.has(d.id)) return;
    lote.update(d.ref, { activa: false, resueltaEn: admin.firestore.FieldValue.serverTimestamp() });
    opsEnLote++;
    resueltas++;
  });
  if (opsEnLote > 0) await lote.commit();

  const publicadas = await auNotificarNuevas(db, nuevasDetalle);

  return { corridoEn: new Date().toISOString(), gruposRevisados: grupos.size, activas, resueltas, nuevas, publicadas };
}

function auPeso(n) { return '$' + Math.round(n).toLocaleString('es-CO'); }

// Aviso al chat SOLO del administrador (canal aparte, nunca el que ven los
// operadores) — misma idea que notificarOportunidades() en trixibot.js, pero
// sin tope de 5: si hay muchas de golpe, el administrador necesita verlas
// todas, no es un aviso opcional como una cuota que se puede perder.
async function auNotificarNuevas(db, alertas) {
  let publicadas = 0;
  for (const a of alertas) {
    try {
      const resumen = `${a.urgente ? '🔴 URGENTE — ' : '⚠️ '}${a.clienteNombre} (${a.operadorNombre}${a.oficinaNombre ? ' · ' + a.oficinaNombre : ''}) ` +
        `tiene ${auPeso(a.saldo)} recargados en ${a.casa} sin invertir hace ${a.diasSinInvertir} día(s)` +
        (a.metodos.length ? ` · método(s): ${a.metodos.join(', ')}` : '');
      await db.collection('patriarca_chat_auditoria').add({
        texto: a.urgente ? '🔴 Auditoría: saldo urgente sin invertir' : '🔎 Auditoría: saldo de cliente sin invertir',
        autorNombre: '🔎 Auditoría', contexto: { tipo: 'auditoriaAlerta', resumen },
        ts: admin.firestore.FieldValue.serverTimestamp(),
      });
      publicadas++;
    } catch (e) { console.warn('auditoria chat ->', e.message); }
  }
  return publicadas;
}

module.exports = { vigilarAuditoria };
