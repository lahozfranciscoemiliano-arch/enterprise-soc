#!/usr/bin/env bash
# vps-update.sh - Aplica en la VPS de produccion todo lo pendiente. Es
# idempotente: se puede correr las veces que haga falta, cada paso detecta
# si ya esta hecho.
#
#   1. Reconstruye y reinicia backend + frontend con el codigo actual.
#   2. Agrega /downloads/ al Nginx si falta -- sin eso, la descarga del .exe
#      (install-agent.ps1 y la auto-actualizacion de los agentes) da 404
#      porque la ruta cae en el frontend.
#   3. Publica en el backend el .exe del agente de la Release "agent-latest"
#      de GitHub y marca esa version como la ultima: cada agente se
#      actualiza solo en su proximo ciclo, sin tocar los servidores.
#   4. Instala el auto-monitoreo del propio VPS (host-monitor.sh + timer).
#
# Uso (como root, en la consola de la VPS):
#   cd /home/socapp/enterprise-soc && git pull && bash deploy/vps-update.sh
#
# El paso 3 necesita que el repo este PUBLICO en GitHub en ese momento (la
# descarga de la Release es anonima). Si esta privado, ese paso se saltea con
# un aviso y el resto sigue igual; se puede volver a correr despues.
set -uo pipefail

REPO_OWNER="lahozfranciscoemiliano-arch"
REPO_NAME="enterprise-soc"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$APP_DIR/.env"
NGINX_SITE="/etc/nginx/sites-available/enterprise-soc"
BACKEND_CONTAINER="enterprise-soc-backend"
POSTGRES_CONTAINER="enterprise-soc-postgres"
HOST_MONITOR_DIR="/opt/enterprise-soc/deploy"
HOST_MONITOR_ENV="/etc/enterprise-soc/host-monitor.env"

RESULTS=()
FAILED=0
ok()   { RESULTS+=("OK        $1"); echo "  [OK] $1"; }
fail() { RESULTS+=("FALLO     $1"); FAILED=1; echo "  [FALLO] $1" >&2; }
skip() { RESULTS+=("SALTEADO  $1"); echo "  [SALTEADO] $1"; }
step() { echo ""; echo "==> $1"; }

# Lee una variable del .env de produccion (sin comillas).
env_value() { grep -E "^$1=" "$ENV_FILE" | head -n1 | cut -d= -f2- | tr -d '"'; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Este script debe correrse como root." >&2
  exit 1
fi
if [ ! -f "$ENV_FILE" ]; then
  echo "No existe $ENV_FILE -- ¿se corrio el deploy inicial?" >&2
  exit 1
fi
cd "$APP_DIR" || exit 1

echo "Enterprise SOC - actualizacion de la VPS"
echo "Codigo en la version: $(git rev-parse --short HEAD 2>/dev/null || echo desconocida)"

# ---------------------------------------------------------------------------
step "1/4 Reconstruyendo y reiniciando backend + frontend (puede tardar varios minutos)"
# ---------------------------------------------------------------------------
if docker compose build && docker compose up -d; then
  healthy=0
  for _ in $(seq 1 45); do
    if curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1; then
      healthy=1
      break
    fi
    sleep 2
  done
  if [ "$healthy" = 1 ]; then
    ok "Stack actualizado y backend respondiendo"
  else
    fail "El backend no respondio /health en 90s (ver: docker compose logs --tail 50 backend)"
  fi
else
  fail "docker compose build/up fallo (ver el error arriba)"
fi

# ---------------------------------------------------------------------------
step "2/4 Nginx: ruta /downloads/ hacia el backend"
# ---------------------------------------------------------------------------
if [ ! -f "$NGINX_SITE" ]; then
  fail "No existe $NGINX_SITE"
elif grep -q "location /downloads/" "$NGINX_SITE"; then
  ok "Nginx ya tenia /downloads/ configurado"
else
  backup="$NGINX_SITE.bak.$(date +%Y%m%d%H%M%S)"
  cp "$NGINX_SITE" "$backup"
  # Inserta el bloque justo antes de "location /api/ {" (una vez por cada
  # server{} que lo tenga, asi tambien cubre el bloque 443 si en el futuro
  # certbot agrega TLS). Comillas simples: $host etc. son variables de Nginx.
  # shellcheck disable=SC2016
  sed -i '/location \/api\/ {/i\    location /downloads/ {\n        proxy_pass http://127.0.0.1:3000;\n        proxy_http_version 1.1;\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;\n    }\n' "$NGINX_SITE"
  if nginx -t >/dev/null 2>&1 && systemctl reload nginx; then
    ok "Nginx: agregado /downloads/ (backup de la config anterior en $backup)"
  else
    cp "$backup" "$NGINX_SITE"
    systemctl reload nginx
    fail "Nginx rechazo la config nueva; se restauro la anterior sin cambios"
  fi
fi

# ---------------------------------------------------------------------------
step "3/4 Agente Windows: publicar la ultima version compilada"
# ---------------------------------------------------------------------------
agent_version="$(grep -oP 'AGENT_VERSION = "\K[0-9]+(\.[0-9]+)*(?=")' agent/agent.py || true)"
release_json="$(curl -fsS "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/releases/tags/agent-latest" 2>/dev/null || true)"

if [ -z "$agent_version" ]; then
  fail "No se pudo leer AGENT_VERSION de agent/agent.py"
elif [ -z "$release_json" ]; then
  skip "No se pudo leer la Release de GitHub -- ¿el repo esta privado? Hacelo publico y volve a correr este script"
elif ! grep -qF "\"Agente Windows v$agent_version\"" <<<"$release_json"; then
  fail "La Release agent-latest no es la v$agent_version -- correr 'Compilar agente Windows' en GitHub Actions"
else
  tmp_exe="$(mktemp --suffix=.exe)"
  if curl -fsSL -o "$tmp_exe" "https://github.com/$REPO_OWNER/$REPO_NAME/releases/download/agent-latest/enterprise-soc-agent.exe" \
    && [ "$(stat -c %s "$tmp_exe")" -gt 1000000 ] \
    && docker cp "$tmp_exe" "$BACKEND_CONTAINER:/app/downloads/enterprise-soc-agent.exe" >/dev/null; then

    # Verificacion de punta a punta: la misma URL (via Nginx) que usan los
    # agentes y install-agent.ps1.
    code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/downloads/enterprise-soc-agent.exe)"
    if [ "$code" = "200" ]; then
      pg_user="$(env_value POSTGRES_USER)"
      pg_db="$(env_value POSTGRES_DB)"
      if docker exec "$POSTGRES_CONTAINER" psql -U "$pg_user" -d "${pg_db:-nocsoc}" -v ON_ERROR_STOP=1 -q -c \
        "INSERT INTO settings (\"key\", \"value\", \"updatedAt\") VALUES ('AGENT_LATEST_VERSION', '$agent_version', NOW())
         ON CONFLICT (\"key\") DO UPDATE SET \"value\" = EXCLUDED.\"value\", \"updatedAt\" = NOW();" >/dev/null; then
        ok "Agente v$agent_version publicado; los agentes se actualizan solos en su proximo ciclo (~1-2 min)"
      else
        fail "El .exe quedo publicado pero no se pudo marcar AGENT_LATEST_VERSION=$agent_version (hacelo en Admin -> Configuracion -> Sesion y agentes)"
      fi
    else
      fail "El .exe se copio pero /downloads/enterprise-soc-agent.exe via Nginx devuelve HTTP $code"
    fi
  else
    fail "No se pudo descargar o copiar el .exe del agente"
  fi
  rm -f "$tmp_exe"
fi

# El instalador (install-agent.ps1) tambien se publica en /downloads/ para
# poder instalar servidores nuevos con un solo comando de PowerShell. No
# depende de que el repo este publico: sale del codigo ya descargado.
if docker cp agent/install-agent.ps1 "$BACKEND_CONTAINER:/app/downloads/install-agent.ps1" >/dev/null \
  && [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/downloads/install-agent.ps1)" = "200" ]; then
  ok "Instalador publicado en /downloads/install-agent.ps1"
else
  fail "No se pudo publicar install-agent.ps1 en /downloads/"
fi

# ---------------------------------------------------------------------------
step "4/4 Auto-monitoreo del propio VPS (host-monitor)"
# ---------------------------------------------------------------------------
mkdir -p "$HOST_MONITOR_DIR"
cp deploy/host-monitor.sh "$HOST_MONITOR_DIR/host-monitor.sh"

enrolled=1
if [ ! -f "$HOST_MONITOR_ENV" ]; then
  echo "  Registrando este VPS como un servidor mas del NOC..."
  if ! bash "$HOST_MONITOR_DIR/host-monitor.sh" --backend http://127.0.0.1:3000 \
    --enrollment-secret "$(env_value AGENT_ENROLLMENT_SECRET)"; then
    enrolled=0
    fail "No se pudo registrar el VPS (¿se cambio el secreto de enrolamiento desde el panel?)"
  fi
fi

if [ "$enrolled" = 1 ]; then
  cp deploy/host-monitor.service deploy/host-monitor.timer /etc/systemd/system/
  if systemctl daemon-reload && systemctl enable --now host-monitor.timer >/dev/null 2>&1 \
    && systemctl is-active --quiet host-monitor.timer; then
    ok "host-monitor activo: el VPS reporta CPU/RAM/disco/contenedores cada 60s"
  else
    fail "No se pudo activar host-monitor.timer (ver: systemctl status host-monitor.timer)"
  fi
fi

# ---------------------------------------------------------------------------
echo ""
echo "======================== RESUMEN ========================"
printf '  %s\n' "${RESULTS[@]}"
echo ""
docker compose ps
echo ""
echo "Queda a mano (fuera de la VPS):"
echo "  1. Volver el repo a PRIVADO en GitHub (Settings -> General -> Danger Zone)."
echo "  2. Cargar la API key de Gemini: Admin -> Configuracion -> Asistente (Gemini)."
echo "  3. En el navegador, recargar forzado (Ctrl+Shift+R) para ver la version nueva."

exit "$FAILED"
