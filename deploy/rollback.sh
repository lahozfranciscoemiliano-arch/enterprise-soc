#!/usr/bin/env bash
# rollback.sh - Vuelve el codigo a un commit/tag anterior y redeploya.
#
# IMPORTANTE: esto SOLO revierte el codigo de la aplicacion. Las migraciones
# de base de datos aplicadas por la version que estabas abandonando NO se
# deshacen automaticamente (revertir una migracion en produccion es
# potencialmente destructivo, asi que no se automatiza). Si la version con
# problemas agrego una migracion incompatible, hay que resolverla a mano
# (una migracion de reversion nueva) antes o despues de este rollback.
#
# Uso: ./rollback.sh <commit-o-tag>
set -euo pipefail

if [ -z "${1:-}" ]; then
  echo "Uso: ./rollback.sh <commit-o-tag>" >&2
  echo "" >&2
  echo "Commits recientes:" >&2
  git -C "$(dirname "${BASH_SOURCE[0]}")/.." log --oneline -10 >&2
  exit 1
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> Revirtiendo codigo a: $1"
echo "==> (las migraciones de DB no se revierten automaticamente, ver comentario arriba)"
read -p "Confirmar rollback a '$1'? [y/N] " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Cancelado."
  exit 0
fi

"$REPO_DIR/deploy/deploy.sh" "$1"
