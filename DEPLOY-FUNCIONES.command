#!/bin/bash
# ════════════════════════════════════════════════════════════════════════════
# DESPLIEGUE DE LAS FUNCIONES DEL SERVIDOR
# ----------------------------------------------------------------------------
# DEPLOY.command sube el portal (hosting y reglas). Este sube el motor: el
# captador que lee las casas, el vigilante de resultados, los cierres y el
# archivado de mensajes.
#
# Son dos scripts aparte a propósito: subir el portal tarda segundos y se hace
# a cada rato; subir las funciones tarda varios minutos y solo hace falta
# cuando se toca algo dentro de la carpeta functions/.
# ════════════════════════════════════════════════════════════════════════════

cd "/Users/usuario/Claude/Projects/SISTEMA PATRIARCA/portal-patriarca"

echo "Subiendo las funciones. Esto tarda unos minutos, no cierres la ventana."
echo ""

firebase deploy --only functions

echo ""
echo "════════════════════════════════════════════════════════════"
echo "Listo. Presiona Enter para cerrar."
read
