#!/usr/bin/env bash
# deploy.sh - Deploy (o actualizacion) de Enterprise SOC basado en git.
# Cada commit/tag ES una version; no hay un mecanismo de "subir codigo" separado
# a proposito (ver rollback.sh para volver atras).
#
# Uso:
#   ./deploy.sh              # deploya la rama actual (git pull)
#   ./deploy.sh <ref>        # deploya un commit/tag/branch especifico
#
# Se asume esta estructura: <repo>/backend, <repo>/fronted, systemd ya
# configurado con los .service de esta carpeta.
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

echo "==> Backend: instalando dependencias y aplicando migraciones"
cd "$REPO_DIR/backend"
npm ci --omit=dev
npx prisma generate
npx prisma migrate deploy

echo "==> Frontend: instalando dependencias y compilando"
cd "$REPO_DIR/fronted"
npm ci
npm run build

echo "==> Reiniciando servicios"
sudo systemctl restart enterprise-soc-backend
sudo systemctl restart enterprise-soc-frontend

sleep 2
echo "==> Estado de los servicios:"
sudo systemctl is-active enterprise-soc-backend enterprise-soc-frontend

echo ""
echo "Deploy completo. Version activa: $COMMIT"
echo "Si algo sale mal: ./rollback.sh <commit-anterior>"
