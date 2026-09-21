#!/usr/bin/env bash
# setup-server.sh - Provisionamiento inicial de un VPS Ubuntu/Debian (ej. Donweb)
# para Enterprise SOC. Se corre UNA sola vez, como root o con sudo.
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

echo "==> Instalando Node.js 20 LTS"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node --version

echo "==> Instalando Docker (para PostgreSQL via docker-compose)"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
docker --version

echo "==> Creando usuario de aplicacion sin privilegios (socapp)"
if ! id socapp >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin socapp
  usermod -aG docker socapp
fi

echo "==> Configurando firewall (ufw)"
ufw allow OpenSSH
ufw allow "Nginx Full"
# Postgres (5432), backend (3000) y frontend (3001) NUNCA se exponen
# directo a internet: solo Nginx habla con ellos via localhost.
ufw --force enable
ufw status verbose

echo ""
echo "================================================================"
echo " Provisionamiento base completo."
echo "================================================================"
echo "Proximos pasos manuales:"
echo "  1. Clona el repo en /home/socapp/enterprise-soc (o sube el codigo por rsync/scp)."
echo "  2. Copia y completa los .env de backend/ y fronted/ con credenciales de PRODUCCION"
echo "     (nunca reuses las de desarrollo: nueva DATABASE_URL, JWT_SECRET, AGENT_ENROLLMENT_SECRET)."
echo "  3. Corre 'docker compose up -d' dentro de backend/ para levantar Postgres."
echo "  4. Copia deploy/*.service a /etc/systemd/system/ y ajusta las rutas si hace falta."
echo "  5. Copia deploy/nginx.conf a /etc/nginx/sites-available/enterprise-soc, ajusta el dominio,"
echo "     activalo con 'ln -s' en sites-enabled, y corre 'certbot --nginx' para el TLS."
echo "  6. Corre deploy/deploy.sh para el primer deploy real."
