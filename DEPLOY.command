#!/bin/bash
cd "/Users/usuario/Claude/Projects/SISTEMA PATRIARCA/portal-patriarca"
firebase deploy --only hosting,firestore:rules
echo ""
echo "✅ Deploy completado. Presiona Enter para cerrar."
read
