#!/bin/bash
# ════════════════════════════════════════════════════════════════════════════
# PUBLICAR EL PORTAL
# ----------------------------------------------------------------------------
# Dos pasos:
#   1. construir.js arma la carpeta publico/ con el código sin comentarios
#      y con los nombres internos cambiados
#   2. Firebase sube ÚNICAMENTE esa carpeta
#
# Lo que no esté en la lista de construir.js no llega a internet. Antes se
# publicaba la carpeta entera, y con ella las copias de seguridad y las
# herramientas que escriben en la base de datos.
#
# Las funciones del servidor van aparte, con DEPLOY-FUNCIONES.command.
# ════════════════════════════════════════════════════════════════════════════

cd "/Users/usuario/Claude/Projects/SISTEMA PATRIARCA/portal-patriarca" || exit 1

node construir.js || { echo ""; echo "Falló la construcción. No se sube nada."; read; exit 1; }

firebase deploy --only hosting,firestore:rules

echo ""
echo "Listo. Presiona Enter para cerrar."
read
