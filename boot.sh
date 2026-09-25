#!/usr/bin/env bash
# boot.sh - Bootstrap temporal para deploy via consola web sin clipboard.
#
# Requiere que el repo este PUBLICO mientras se descarga este archivo (clona
# por HTTPS anonimo, sin token). Volver a poner el repo en Private apenas
# termine -- no hace falta mantenerlo publico despues de este paso.
#
# Este archivo se borra del repo despues del deploy (es un bootstrap
# de un solo uso, no parte permanente del proyecto).
set -euo pipefail

REPO_OWNER="lahozfranciscoemiliano-arch"
REPO_NAME="enterprise-soc"
VPS_IP="203.161.39.123"
APP_DIR="/home/socapp/enterprise-soc"

if [ "$(id -u)" -ne 0 ]; then
  echo "Este script debe correrse como root." >&2
  exit 1
fi

echo "================================================================"
echo " Enterprise SOC - Deploy en $VPS_IP"
echo "================================================================"

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
ufw --force enable

if [ ! -f /swapfile ]; then
  echo "==> Creando swap de 2GB (RAM de la VPS es justa para el build)"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Clonando el repositorio (anonimo -- el repo debe estar publico ahora)"
if [ -d "$APP_DIR/.git" ]; then
  echo "  Ya existe un clon en $APP_DIR, actualizando..."
  sudo -u socapp git -C "$APP_DIR" fetch origin main
  sudo -u socapp git -C "$APP_DIR" reset --hard origin/main
else
  sudo -u socapp git clone "https://github.com/${REPO_OWNER}/${REPO_NAME}.git" "$APP_DIR"
fi

ENV_FILE="$APP_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  echo "==> Ya existe $ENV_FILE, no lo piso"
else
  echo "==> Generando secretos de produccion y escribiendo $ENV_FILE"
  POSTGRES_PASSWORD="$(openssl rand -hex 24)"
  JWT_SECRET="$(openssl rand -hex 32)"
  AGENT_ENROLLMENT_SECRET="$(openssl rand -hex 32)"

  cat > "$ENV_FILE" <<EOF
POSTGRES_USER=nocsoc_prod
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=nocsoc

JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=8h
CORS_ORIGIN=http://${VPS_IP}
AGENT_ENROLLMENT_SECRET=${AGENT_ENROLLMENT_SECRET}

NOTIFY_MIN_SEVERITY=HIGH
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM=noc@tudominio.com
ALERT_EMAIL_TO=

NEXT_PUBLIC_API_URL=http://${VPS_IP}
NEXT_PUBLIC_WS_URL=ws://${VPS_IP}/ws
EOF
  chown socapp:socapp "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "$AGENT_ENROLLMENT_SECRET" > /root/.enterprise-soc-enrollment-secret
fi

echo "==> Construyendo y levantando el stack (puede tardar varios minutos)"
cd "$APP_DIR"
docker compose build
docker compose up -d

echo "==> Esperando a que el backend este listo..."
for i in $(seq 1 30); do
  if docker exec enterprise-soc-backend node -e "process.exit(0)" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
sleep 5

echo "==> Estado de los contenedores:"
docker compose ps

SEED_OUTPUT_FILE="/root/.enterprise-soc-admin-credentials.txt"
if [ -f "$SEED_OUTPUT_FILE" ]; then
  echo "==> Ya existe $SEED_OUTPUT_FILE, no se vuelve a crear el admin"
else
  echo "==> Creando el usuario ADMIN inicial"
  docker exec enterprise-soc-backend node prisma/seed.js | tee "$SEED_OUTPUT_FILE"
  chmod 600 "$SEED_OUTPUT_FILE"
fi

echo "==> Configurando Nginx"
cat > /etc/nginx/sites-available/enterprise-soc <<'NGINXEOF'
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /ws {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;
    }
}
NGINXEOF

rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/enterprise-soc /etc/nginx/sites-enabled/enterprise-soc
nginx -t
systemctl reload nginx

echo ""
echo "================================================================"
echo " DEPLOY COMPLETO"
echo "================================================================"
echo ""
echo "Dashboard:  http://${VPS_IP}"
echo ""
echo "*** ACORDATE DE VOLVER A PONER EL REPO EN PRIVATE EN GITHUB AHORA ***"
echo ""
echo "--- Credenciales del ADMIN inicial (guardalas ahora) ---"
cat "$SEED_OUTPUT_FILE"
echo ""
echo "--- Secreto de auto-enrolamiento de agentes ---"
cat /root/.enterprise-soc-enrollment-secret
echo ""
