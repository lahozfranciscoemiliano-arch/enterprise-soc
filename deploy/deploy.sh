#!/usr/bin/env bash
# deploy.sh - Deploy (o actualizacion) de Enterprise SOC basado en git + Docker.
# Cada commit/tag ES una version; no hay un mecanismo de "subir codigo" separado
# a proposito (ver rollback.sh para volver atras).
#
# Uso:
#   ./deploy.sh              # deploya la rama actual (git pull)
#   ./deploy.sh <ref>        # deploya un commit/tag/branch especifico
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

REF="${1:-}"

echo "==> Repositorio: $REPO_DIR"

if [ -n "$REF" ]; then
  echo "==> Deployando ref especifico: $REF"
  git fetch --all --tags
  git checkout "$REF"
else
  echo "==> Actualizando rama actual"
  git pull
fi

COMMIT="$(git rev-parse --short HEAD)"
echo "==> Version desplegada: $COMMIT"

echo "==> Reconstruyendo imagenes y reiniciando servicios"
docker compose build
docker compose up -d

sleep 3
echo "==> Estado de los contenedores:"
docker compose ps

echo ""
echo "Deploy completo. Version activa: $COMMIT"
echo "Las migraciones de Prisma se aplican solas al arrancar el contenedor del backend."
echo "Si algo sale mal: ./deploy/rollback.sh <commit-anterior>"
