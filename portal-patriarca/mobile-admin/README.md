# Patriarca Admin — cascarón de la app móvil

Primer paso del proyecto: un proyecto Capacitor real (no una maqueta), con las carpetas nativas de iOS y Android ya generadas, y una pantalla de login funcional contra el mismo Firebase del portal.

## Qué ya funciona
- Login con correo/contraseña contra el proyecto `portal-patriarca-aj16` (mismas credenciales que usas en el portal de escritorio).
- Verificación de rol: solo entra si el usuario existe en `admin_accesos` con `rol: 'admin'` — exactamente la misma regla que usa admin.html.
- Ojito para mostrar/ocultar la contraseña.
- Tabs de verdad (Inicio, Alertas, Chat, Pendientes, Trixi, Combinadas) — ya cambian de pantalla al tocarlas.
- **Chat de solo lectura**: la pestaña 💬 Chat muestra las conversaciones reales de operadores/cajeros con administración (mismo `patriarca_chat_hilos` que usa el portal). Para responder, todavía hay que usar el portal de escritorio — a propósito, para no duplicar el compositor completo en esta primera versión.
- **Notificaciones push (iOS)**: el código ya está — pide permiso, guarda el token en `admin_fcm_tokens/{uid}`, y `functions/notificaciones.js` manda un push cuando llega un mensaje de un operador/cajero o una oportunidad de Trixi Bot. **Falta la configuración nativa** (ver checklist abajo) antes de que funcione de verdad en un iPhone.
- Pendientes y Bot de Combinadas siguen marcadas "Próximamente".

## Checklist para activar las notificaciones push en iOS (pasos que solo se hacen desde Xcode / consolas — no se pueden automatizar desde acá)
1. **Firebase console** → Project settings → agregar una app iOS con bundle ID `com.patriarca.admin` (si no existe ya). Descargar el `GoogleService-Info.plist` que te da y arrastrarlo dentro de `ios/App/App/` en Xcode (que quede agregado al target "App").
2. **Apple Developer** (cuenta de pago) → Certificates, Identifiers & Profiles → Keys → crear una **APNs Auth Key** (.p8), anotar el Key ID y el Team ID.
3. **Firebase console** → Project settings → Cloud Messaging → pestaña Apple app configuration → subir esa key (.p8) con su Key ID y Team ID.
4. **Xcode** → seleccionar el target "App" → Signing & Capabilities → botón "+ Capability" → agregar **Push Notifications** y **Background Modes** (dentro de Background Modes, marcar "Remote notifications").
5. `npm install && npx cap sync ios` (esto ya lo corrí yo, pero repítelo si cambias algo) y luego abrir `ios/App/App.xcworkspace`, dejar que Xcode resuelva los paquetes de Swift (necesita internet la primera vez), compilar en tu iPhone.
6. Entrar a la app, tocar "Activar notificaciones" cuando salga, aceptar el permiso del sistema — ahí debería quedar el token guardado y las pestañas de Notificaciones deberían pasar de "Inactivas" a "Activas".

## Qué falta (a propósito, todavía no se toca)
- Notificaciones push en Android (el código de functions/notificaciones.js ya sirve para los dos, solo falta el lado nativo de Android — google-services.json, etc.).
- Contenido real de Pendientes y Bot de Combinadas (Trixi Bot pasó a la lista de "ya funciona" — el Chat también).
- Responder desde el Chat de la app (hoy es solo lectura).
- Ícono de app pulido (por ahora usa el logo verde de AJ1.6 solo en la pantalla de login, no como ícono instalable).

## Para probarla en tu celular
Esto se abre y se compila desde tu propia computadora (Xcode para iPhone, Android Studio para Android) — yo no tengo acceso a esas herramientas desde aquí, así que estos son los pasos que te tocan a ti:

**iPhone:**
1. Necesitas una Mac con Xcode instalado.
2. Abre `mobile-admin/ios/App/App.xcworkspace` con Xcode (el `.xcworkspace`, no el `.xcodeproj`).
3. Conecta tu iPhone por cable, selecciónalo como destino, dale ▶ Run.
4. La primera vez Xcode te pedirá tu Apple ID para firmar la app — es gratis para probar en tu propio celular.

**Android:**
1. Instala Android Studio.
2. Abre la carpeta `mobile-admin/android`.
3. Conecta tu celular con "Depuración USB" activada, o usa un emulador, dale ▶ Run.

Si prefieres, más adelante podemos automatizar la generación del `.apk`/`.ipa` sin que tengas que abrir Xcode o Android Studio manualmente, pero para el primer build de prueba lo más simple es así.

## Siguiente paso propuesto
Backend de notificaciones: Cloud Functions con triggers de Firestore (pendientes, mensajes nuevos, auditoría) + registro de tokens FCM, para que las pestañas "Próximamente" empiecen a recibir datos reales.
