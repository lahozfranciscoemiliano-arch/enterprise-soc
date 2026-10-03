#!/usr/bin/env bash
# setup-domain.sh - Publica el NOC en su dominio con HTTPS. Idempotente: se
# puede volver a correr (reinstala el mismo certificado, no pide uno nuevo).
#
#   1. Verifica que el DNS del dominio apunte a esta VPS.
#   2. Nginx: el dominio sirve el panel/API/agente; por la IP siguen
#      funcionando los agentes y el poller (y un navegador se redirige al
#      dominio). Ver deploy/nginx.conf.
#   3. Certificado gratuito de Let's Encrypt (certbot), con renovacion
#      automatica y redireccion de http a https.
#   4. .env: CORS_ORIGIN y NEXT_PUBLIC_API_URL / NEXT_PUBLIC_WS_URL al dominio.
#   5. Recompila el frontend (las URL quedan dentro del bundle) y reinicia.
#   6. Comprueba todo de punta a punta.
#
# Uso (como root, en la consola de la VPS):
#   cd /home/socapp/enterprise-soc && git pull
#   bash deploy/setup-domain.sh --domain bistro.enterprisesoc.lat [--email tu@correo]
#
# --email: Let's Encrypt avisa ahi si un certificado no se pudo renovar (opcional).
set -uo pipefail

DOMAIN="bistro.enterprisesoc.lat"
EMAIL=""
SKIP_DNS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --skip-dns-check) SKIP_DNS=1; shift ;;
    *) echo "Opcion desconocida: $1" >&2; exit 1 ;;
  esac
done

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$APP_DIR/.env"
TEMPLATE="$APP_DIR/deploy/nginx.conf"
NGINX_SITE="/etc/nginx/sites-available/enterprise-soc"
STAMP="$(date +%Y%m%d%H%M%S)"

die() { echo "" >&2; echo "  [FALLO] $1" >&2; exit 1; }
ok() { echo "  [OK] $1"; }
step() { echo ""; echo "==> $1"; }

[ "$(id -u)" -eq 0 ] || die "Este script debe correrse como root."
[ -f "$ENV_FILE" ] || die "No existe $ENV_FILE -- ¿se corrio el deploy inicial?"
[ -f "$TEMPLATE" ] || die "No existe $TEMPLATE -- ¿se hizo git pull?"
echo "$DOMAIN" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' || die "Dominio invalido: $DOMAIN"
cd "$APP_DIR" || exit 1

# ---------------------------------------------------------------------------
step "1/6 DNS: ¿$DOMAIN apunta a esta VPS?"
# ---------------------------------------------------------------------------
public_ip="$(curl -4 -fsS --max-time 10 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
# dig consulta directo a 1.1.1.1: el resolver local puede tener guardado el
# "no existe" de una consulta anterior a crear el registro.
command -v dig >/dev/null 2>&1 || apt-get install -y -qq dnsutils >/dev/null 2>&1 || true
if command -v dig >/dev/null 2>&1; then
  dns_ip="$(dig +short A "$DOMAIN" @1.1.1.1 | grep -E '^[0-9.]+$' | head -n1)"
else
  dns_ip="$(getent ahostsv4 "$DOMAIN" | awk '{print $1; exit}')"
fi
echo "  IP publica de esta VPS: ${public_ip:-desconocida}"
echo "  $DOMAIN resuelve a:    ${dns_ip:-(sin registro todavia)}"
if [ "$SKIP_DNS" = 1 ]; then
  echo "  (verificacion de DNS salteada con --skip-dns-check)"
elif [ -z "$dns_ip" ]; then
  die "El dominio todavia no resuelve. Crea en Spaceship el registro A: host 'bistro' -> $public_ip, espera 5-10 min y volve a correr."
elif [ -n "$public_ip" ] && [ "$dns_ip" != "$public_ip" ]; then
  die "El registro A apunta a $dns_ip y esta VPS es $public_ip. Corregilo en Spaceship y volve a correr."
else
  ok "DNS correcto"
fi

# ---------------------------------------------------------------------------
step "2/6 Nginx: sitio del dominio + acceso por IP para los agentes"
# ---------------------------------------------------------------------------
command -v certbot >/dev/null 2>&1 && dpkg -s python3-certbot-nginx >/dev/null 2>&1 \
  || { apt-get update -qq && apt-get install -y -qq certbot python3-certbot-nginx >/dev/null; } \
  || die "No se pudo instalar certbot"

site_backup=""
if [ -f "$NGINX_SITE" ]; then
  site_backup="$NGINX_SITE.bak.$STAMP"
  cp "$NGINX_SITE" "$site_backup"
fi
sed "s/__DOMAIN__/$DOMAIN/g" "$TEMPLATE" > "$NGINX_SITE"
ln -sf "$NGINX_SITE" /etc/nginx/sites-enabled/enterprise-soc
# El sitio "default" de Debian/Ubuntu tambien es default_server: chocaria con el nuestro.
rm -f /etc/nginx/sites-enabled/default
if nginx -t >/dev/null 2>&1 && systemctl reload nginx; then
  ok "Nginx configurado${site_backup:+ (config anterior en $site_backup)}"
else
  [ -n "$site_backup" ] && cp "$site_backup" "$NGINX_SITE" && systemctl reload nginx
  nginx -t
  die "Nginx rechazo la config nueva; se restauro la anterior"
fi

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow "Nginx Full" >/dev/null && ok "Firewall: 80 y 443 abiertos"
fi

# ---------------------------------------------------------------------------
step "3/6 Certificado HTTPS (Let's Encrypt)"
# ---------------------------------------------------------------------------
if [ -n "$EMAIL" ]; then email_args=(-m "$EMAIL"); else email_args=(--register-unsafely-without-email); fi
if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect --keep-until-expiring "${email_args[@]}"; then
  ok "HTTPS activo en https://$DOMAIN (se renueva solo)"
else
  die "certbot no pudo emitir el certificado. Revisa que el puerto 80 de la VPS sea accesible desde internet y que el DNS ya apunte aca. El NOC sigue funcionando como antes por http."
fi
systemctl is-active --quiet certbot.timer 2>/dev/null && ok "Renovacion automatica: certbot.timer activo"

# ---------------------------------------------------------------------------
step "4/6 .env: direcciones del panel"
# ---------------------------------------------------------------------------
cp "$ENV_FILE" "$ENV_FILE.bak.$STAMP"
chmod 600 "$ENV_FILE.bak.$STAMP"
set_env() {
  if grep -qE "^$1=" "$ENV_FILE"; then
    sed -i -E "s|^$1=.*|$1=$2|" "$ENV_FILE"
  else
    echo "$1=$2" >> "$ENV_FILE"
  fi
}
set_env CORS_ORIGIN "https://$DOMAIN"
set_env NEXT_PUBLIC_API_URL "https://$DOMAIN"
set_env NEXT_PUBLIC_WS_URL "wss://$DOMAIN/ws"
ok ".env actualizado (copia anterior en $ENV_FILE.bak.$STAMP)"

# ---------------------------------------------------------------------------
step "5/6 Recompilando el frontend y reiniciando (puede tardar varios minutos)"
# ---------------------------------------------------------------------------
if ! { docker compose build frontend && docker compose up -d; }; then die "docker compose fallo (ver el error arriba)"; fi
for _ in $(seq 1 45); do
  curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1 && break
  sleep 2
done
docker image prune -f >/dev/null 2>&1
ok "Stack reiniciado"

# ---------------------------------------------------------------------------
step "6/6 Comprobacion"
# ---------------------------------------------------------------------------
fails=0
check() {
  if [ "$2" = "$3" ]; then ok "$1"; else echo "  [FALLO] $1 (esperado $3, obtenido $2)" >&2; fails=1; fi
}
res=(--resolve "$DOMAIN:443:127.0.0.1" --max-time 20)
check "Panel por https://$DOMAIN" "$(curl -s -o /dev/null -w '%{http_code}' "${res[@]}" "https://$DOMAIN/")" "200"
check "API por HTTPS" "$(curl -s "${res[@]}" "https://$DOMAIN/api/agent/hello" | grep -o enterprise-soc | head -n1)" "enterprise-soc"
check "Descarga del agente por HTTPS" "$(curl -s -o /dev/null -w '%{http_code}' "${res[@]}" "https://$DOMAIN/downloads/install-agent.ps1")" "200"
check "Agentes por la IP (http) siguen funcionando" "$(curl -s --max-time 10 http://127.0.0.1/api/agent/hello | grep -o enterprise-soc | head -n1)" "enterprise-soc"
check "Navegador por la IP -> redirige al dominio" "$(curl -s -o /dev/null -w '%{redirect_url}' --max-time 10 http://127.0.0.1/)" "https://$DOMAIN/"

echo ""
echo "======================================================================"
if [ "$fails" = 0 ]; then
  echo " Listo: el NOC esta en https://$DOMAIN"
else
  echo " Terminado con fallos (ver arriba). Logs: docker compose logs --tail 50 backend frontend"
fi
echo "======================================================================"
echo "Siguientes pasos:"
echo "  1. Entrar a https://$DOMAIN (iniciar sesion de nuevo: la sesion es por dominio)."
echo "  2. Admin -> Servidores -> 'Direccion del NOC en los agentes': https://$DOMAIN + PIN."
echo "     Los agentes se pasan solos en ~2 min; el panel muestra los que no llegan."
echo "  3. Poller de Fortinet: SOC_BACKEND_URL=https://$DOMAIN en su .env y reiniciarlo."
echo "  4. App del celular: actualizarla (pasa sola al dominio) o Menu -> Cambiar servidor."
exit "$fails"
