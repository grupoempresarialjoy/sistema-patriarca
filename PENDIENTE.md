# Dónde quedamos — 20 de agosto de 2026

> Ronaldo: mañana dile a Claude **"lee PENDIENTE.md"** y retoma con todo el contexto.

---

## ⛔ Lo primero: subir las funciones

El código está escrito, probado y **sin subir**. Falló el despliegue por un problema
de Google, no nuestro.

**Comando 1** — bajar el CLI a Node 22 (hoy está en Node 26, que Firebase no soporta):

```
nvm install 22 && nvm use 22 && npm install -g firebase-tools
```

**Comando 2** — subir:

```
cd "/Users/usuario/Claude/Projects/SISTEMA PATRIARCA/portal-patriarca" && firebase deploy --only functions
```

**Comando 3** — una sola vez después, para generar el diccionario de nombres de equipos:

Abrir en el navegador
`https://us-central1-portal-patriarca-aj16.cloudfunctions.net/cargarHistoricoAhora?anios=3`

### Qué pasó con el despliegue

Falló cuatro veces con: *"Resource readiness deadline exceeded — the user-provided
container failed to start and listen on PORT 8080"*, y **cero registros de la aplicación**.

Ya descartamos, con pruebas:

- **No es el código** — `index.js` carga en 1,1 s con Node 22 y exporta las 12 funciones.
- **No es el volumen** — falla también desplegando una sola función.
- **No es un servicio atascado** — falla igual `archivarChatAhora`, que es nueva.
- **No son las versiones** — se fijaron a firebase-admin 12.7.0, firebase-functions 6.6.0, cheerio 1.2.0.

Ya se le subió la memoria de 512 MB a **1 GiB** (en Cloud Run la memoria también
da CPU, y el error era de arranque lento). Eso entra con el próximo despliegue.

Si vuelve a fallar tras bajar a Node 22 → escribir a soporte de Google con ese
mensaje exacto y el proyecto `portal-patriarca-aj16`.

---

## ✅ Lo que YA está arriba y funcionando

- **Chat del ecosistema** (`chat.js`, un solo archivo para los tres portales)
  - Hilo privado de cada operador y cajero con el administrador
  - Chulitos: ✓ enviado · ✓✓ recibido · ✓✓ azul leído
  - Anuncios con público elegible (todos / operadores / cajeros)
  - Ventana flotante al entrar; los **fijados** no se pueden cerrar sin «Entendido»
  - Botón 🚩 Reportar en cupones y movimientos de caja, con la combinada **en imagen**
- **Reglas de Firestore cerradas** para el chat — un operador no puede leer el hilo de otro
- **Logo vectorial** en los ocho sitios donde aparecía borroso
- **Seis botones de compartir cupón que estaban muertos** (`cpImagenH`, `cpCopiarH`,
  `cpWhatsappH`, `cpTelegramH`, `cpCopiarIdx` no existían) — arreglados

---

## ⏳ Lo que espera al despliegue

- **Europa en el captador.** Pasaba de mirar 10 países latinoamericanos a 28.
  De 245 a ~600 partidos. Los europeos caen de 8 a.m. a 5 p.m. hora Colombia.
- **Escrituras solo si algo cambió.** Antes reescribía los ~530 partidos cada 3
  minutos: unas 240.000 escrituras diarias contra un plan gratuito de 20.000.
- **Ventana de noche.** Día cada 3 min (8:00–22:59), noche cada 5 (23:00–07:59).
  15 % menos corridas, cero resultados en riesgo.
- **Nombres de equipos.** Norwich ↔ Norwich City, con dos guardias para que
  Bristol City no se confunda con Bristol Rovers ni Dundee con Dundee United.
- **Ligas principales.** Entran Serie B y Ligue 2; sale la Northern Premier League,
  que es séptima división inglesa y se estaba colando.
- **Archivado del chat**, domingos 5:20, mueve a un archivo lo de más de 30 días.
  Lo fijado nunca se mueve.

---

## 📊 Lo que aprendimos hoy analizando las combinadas

Esto es lo más valioso de la sesión. Sobre **63 cupones resueltos y 148 opciones
con resultado**:

| | |
|---|---|
| Acierto real | 39,9 % |
| Lo que decía la casa | 47,2 % |
| Rendimiento | −14,6 % |

**Dentro de lo que explica el azar** (1,78 errores típicos). Con 148 opciones no
se puede concluir que el bot esté roto.

**Pero un cajón sí se sale:** 1X2 por encima de 2.00 → 43 opciones, la casa decía
40 %, pegamos 16,3 %. Rendimiento −53,7 %, a 3,17 errores típicos. Eso es real.

Todo lo que está **por debajo de 2.00 se comporta normal.** Goles va bien en las
dos franjas.

### La causa raíz

**Cero equipos tenían ficha utilizable.** De 1.109 equipos: 422 con ningún partido,
686 con uno, 1 con dos. El propio sistema lo decía: `equiposMaduros: 0`.

O sea que `cpProbGoles` devolvía nulo en casi todo y el control de «Análisis propio»
era decorativo. El bot encontraba «ventaja» comparando contra un modelo que no sabía nada.

Se corrió la carga histórica: **de 0 pasamos a 494 equipos utilizables**, mediana
de 76 partidos. Pero la cobertura del catálogo era solo del 9 % porque la fuente
gratuita cubre Europa y nosotros solo mirábamos Latinoamérica. De ahí el cambio de Europa.

### Las 43 patas del desastre, por competencia

Copa Libertadores 15 · Colombia Liga BetPlay 12 · Copa Sudamericana 8 · MLS 8.
Todas de primer nivel, y todas sin histórico disponible.

---

## 💬 Temas abiertos que Ronaldo dejó para después

1. **Canal cajero ↔ operador.** Hoy no existe: todo hilo es persona ↔ administrador.
   Se le plantearon tres opciones y quedó sin decidir:
   - Dejarlo como está (todo pasa por el administrador)
   - Hilo dentro de la misma oficina, con copia visible para el administrador
   - Solo sobre el movimiento: al rechazar una transacción hay que escribir el motivo

2. **Reportar cuotas de Trixi en imagen.** Las combinadas ya salen en imagen; las
   cuotas positivas no tienen ni botón de reportar ni dibujante. Falta definir cómo
   se ve la tarjeta de una cuota.

3. **Techo duro de cuota por pata.** Lo que más urge según los datos. Hoy la opción
   «a mi medida» deja poner cualquier rango y por ahí se colaron los 1X2 sobre 2.00.

4. **Límite diario de búsquedas por operador**, configurable desde el administrador,
   como el que ya tiene Trixi Bot.

5. **Operadores registrando combinadas manuales** para comparar humano contra bot.
   Ronaldo lo dejó explícitamente para más adelante.

---

## 🔧 Cosas del entorno que conviene recordar

- `DEPLOY.command` sube **solo hosting y reglas**. Las funciones van aparte,
  con `DEPLOY-FUNCIONES.command` o el comando de arriba.
- La cuenta de Google Cloud está en **prueba gratuita** (quedaban 54 días y
  ~1.012.572 USD de crédito). Puede tener cuotas limitadas.
- `captarAhora` **no tiene CORS**, así que no se puede disparar desde el navegador.
  `cargarHistoricoAhora`, `recalcularAhora` y `archivarChatAhora` sí lo tienen.
