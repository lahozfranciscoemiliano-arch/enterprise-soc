#!/usr/bin/env bash
# setup-server.sh - Provisionamiento inicial de un VPS Ubuntu/Debian (ej. Donweb)
# para Enterprise SOC. Se corre UNA sola vez, como root o con sudo.
#
# Con el stack central dockerizado (docker-compose.yml en la raiz del repo),
# el VPS solo necesita Docker + Nginx + Certbot — no hace falta instalar
# Node.js en el host, todo corre adentro de los contenedores.
#
# Uso: sudo bash setup-server.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Este script debe correrse como root (sudo bash setup-server.sh)" >&2
  exit 1
fi

echo "==> Actualizando el sistema"
apt-get update -y
apt-get upgrade -y

echo "==> Instalando dependencias basicas"
apt-get install -y curl git ufw nginx certbot python3-certbot-nginx ca-certificates gnupg

echo "==> Instalando Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
docker --version
docker compose version

echo "==> Creando usuario de aplicacion sin privilegios (socapp)"
if ! id socapp >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin socapp
  usermod -aG docker socapp
fi

echo "==> Configurando firewall (ufw)"
ufw allow OpenSSH
ufw allow "Nginx Full"
# Postgres, backend (3000) y frontend (3001) NUNCA se exponen directo a
# internet: docker-compose.yml ya los liga solo a 127.0.0.1, y esto es una
# segunda capa de defensa a nivel de firewall.
ufw --force enable
ufw status verbose

echo ""
echo "================================================================"
echo " Provisionamiento base completo."
echo "================================================================"
echo "Proximos pasos manuales (ver deploy/DEPLOY.md para el detalle):"
echo "  1. Clona el repo en /home/socapp/enterprise-soc (o sube el codigo por rsync/scp)."
echo "  2. Copia .env.example a .env en la raiz del repo y completa con credenciales"
echo "     de PRODUCCION (nunca reuses las de desarrollo)."
echo "  3. Corre 'docker compose up -d --build' para levantar Postgres + backend + frontend."
echo "  4. Corre el seed para crear el primer usuario ADMIN."
echo "  5. Con el DNS del dominio apuntando a la VPS: bash deploy/setup-domain.sh --domain tu.dominio"
echo "     (Nginx + certificado HTTPS + .env, ver deploy/DEPLOY.md seccion 43)."
