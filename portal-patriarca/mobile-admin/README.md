# Patriarca Admin — cascarón de la app móvil

Primer paso del proyecto: un proyecto Capacitor real (no una maqueta), con las carpetas nativas de iOS y Android ya generadas, y una pantalla de login funcional contra el mismo Firebase del portal.

## Qué ya funciona
- Login con correo/contraseña contra el proyecto `portal-patriarca-aj16` (mismas credenciales que usas en el portal de escritorio).
- Verificación de rol: solo entra si el usuario existe en `admin_accesos` con `rol: 'admin'` — exactamente la misma regla que usa admin.html.
- Ojito para mostrar/ocultar la contraseña.
- Pestañas de Alertas, Mensajes, Pendientes, Bot Trixi y Bot de Combinadas visibles pero marcadas "Próximamente" — son las siguientes piezas a construir, en ese orden de prioridad para el administrador.

## Qué falta (a propósito, todavía no se toca)
- Notificaciones push (Firebase Cloud Messaging) — es el siguiente paso de backend que quedó pendiente.
- Contenido real de Mensajes, Pendientes, Bot Trixi y Bot de Combinadas (por ahora Trixi y Combinadas serían vistas de solo lectura, no paneles de control completos).
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
