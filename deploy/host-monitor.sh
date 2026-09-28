#!/usr/bin/env bash
# host-monitor.sh - Auto-monitoreo del propio VPS (Ubuntu) que corre el stack
# de Enterprise SOC. Corre EN EL HOST (no dentro de Docker), y reporta
# CPU/RAM/disco/red y el estado de los contenedores del stack como si fuera
# un servidor mas -- reusa exactamente los mismos endpoints que el agente de
# Windows (POST /api/servers/enroll, POST /api/telemetry), asi que aprovecha
# el mismo motor de alertas, thresholds y dashboard sin codigo nuevo del lado
# del backend.
#
# Motivo: hoy nadie vigila el disco de 30GB / CPU / RAM del propio VPS de
# DonWeb. Si se llena el disco o el host se satura, el NOC se entera cuando
# ya dejo de funcionar, no antes.
#
# Uso (primera vez, registra el host y guarda las credenciales):
#   sudo bash host-monitor.sh --backend https://noc.tudominio.com \
#       --enrollment-secret "<AGENT_ENROLLMENT_SECRET>"
#
# Uso (ciclos siguientes, via systemd timer -- ver host-monitor.service/.timer):
#   sudo bash host-monitor.sh
#
# Requiere: bash, curl, coreutils (df, ps, awk, grep), y docker (opcional --
# si no esta disponible, simplemente no reporta salud de contenedores).
set -euo pipefail

STATE_DIR="/etc/enterprise-soc"
ENV_FILE="$STATE_DIR/host-monitor.env"
STATE_FILE="/var/lib/enterprise-soc/host-monitor.state" # muestra anterior de /proc/net/dev, para calcular throughput
SERVER_NAME="${HOST_MONITOR_SERVER_NAME:-$(hostname)-vps}"
COMPOSE_PROJECT="${HOST_MONITOR_COMPOSE_PROJECT:-enterprise-soc}" # prefijo de los contenedores a vigilar

BACKEND_URL=""
ENROLLMENT_SECRET=""

while [ $# -gt 0 ]; do
  case "$1" in
    --backend) BACKEND_URL="$2"; shift 2 ;;
    --enrollment-secret) ENROLLMENT_SECRET="$2"; shift 2 ;;
    *) echo "Argumento desconocido: $1" >&2; exit 1 ;;
  esac
done

mkdir -p "$STATE_DIR" "$(dirname "$STATE_FILE")"

# --- Alta (solo la primera vez) --------------------------------------------
if [ ! -f "$ENV_FILE" ]; then
  if [ -z "$BACKEND_URL" ] || [ -z "$ENROLLMENT_SECRET" ]; then
    echo "Primera corrida: hacen falta --backend y --enrollment-secret para auto-registrar este host." >&2
    exit 1
  fi

  echo "==> Registrando '$SERVER_NAME' en el backend (auto-enrolamiento)"
  ip_addr="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [ -z "$ip_addr" ] && ip_addr="127.0.0.1"

  response="$(curl -sS -X POST "$BACKEND_URL/api/servers/enroll" \
    -H "X-Enrollment-Secret: $ENROLLMENT_SECRET" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"$SERVER_NAME\",\"hostname\":\"$SERVER_NAME\",\"ipAddress\":\"$ip_addr\",\"tags\":[\"infra-vps\"]}")"

  server_id="$(echo "$response" | grep -o '"serverId":"[^"]*"' | cut -d'"' -f4)"
  api_key="$(echo "$response" | grep -o '"apiKey":"[^"]*"' | cut -d'"' -f4)"

  if [ -z "$server_id" ] || [ -z "$api_key" ]; then
    echo "Fallo el enrolamiento. Respuesta del backend: $response" >&2
    exit 1
  fi

  cat > "$ENV_FILE" <<EOF
BACKEND_URL=$BACKEND_URL
SERVER_ID=$server_id
API_KEY=$api_key
EOF
  chmod 600 "$ENV_FILE"
  echo "==> Registrado OK (SERVER_ID=$server_id). Credenciales guardadas en $ENV_FILE"
fi

# shellcheck disable=SC1090
source "$ENV_FILE"

# --- Metricas del host -------------------------------------------------------

# CPU: PROMEDIO desde la corrida anterior (~60 s, el mismo intervalo que la
# telemetria), no una muestra de 1 s: una muestra corta caia justo en el pico
# de arranque del propio script/docker y marcaba 90-100%. Como "top":
#   ocupado = user + nice + system + irq + softirq
#   aparte  = iowait (esperando disco, NO es CPU ocupada) y steal (CPU que el
#             proveedor de la VPS le quito a esta maquina: si es alto, el host
#             esta sobrevendido y conviene reclamar o cambiar de plan).
# /proc/stat: cpu user nice system idle iowait irq softirq steal
read_cpu_sample() {
  awk '/^cpu /{print $2+$3+$4+$7+$8, $5, $6, $9, $2+$3+$4+$5+$6+$7+$8+$9}' /proc/stat
}
cpu_now="$(read_cpu_sample)"
cpu_prev=""
if [ -f "$STATE_FILE" ]; then
  # "|| true": con set -euo pipefail, un grep sin resultados (archivo de
  # estado de la version anterior, sin PREV_CPU) cortaba el script entero.
  cpu_prev="$(grep -E '^PREV_CPU=' "$STATE_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)"
fi
if [ -z "$cpu_prev" ]; then
  # Primera corrida: 5 s de muestra en vez de 1.
  cpu_prev="$cpu_now"
  sleep 5
  cpu_now="$(read_cpu_sample)"
fi
read -r cpu_usage cpu_iowait cpu_steal <<<"$(awk -v s1="$cpu_prev" -v s2="$cpu_now" '
  BEGIN {
    split(s1, a, " "); split(s2, b, " ");
    total = b[5] - a[5];
    if (total <= 0) { print "0 0 0"; exit }
    printf "%.2f %.2f %.2f", (b[1]-a[1])/total*100, (b[3]-a[3])/total*100, (b[4]-a[4])/total*100;
  }')"
cpu_cores="$(nproc 2>/dev/null || echo 1)"
load_1="$(awk '{print $1}' /proc/loadavg)"

# RAM: MemAvailable ya tiene en cuenta cache/buffers reclamables (mas fiel
# que MemFree solo).
mem_usage="$(awk '
  /MemTotal:/ { total=$2 }
  /MemAvailable:/ { avail=$2 }
  END { if (total > 0) printf "%.2f", (total-avail)/total*100; else print 0 }
' /proc/meminfo)"

# Disco: filesystem raiz (donde vive todo: Docker, Postgres, el propio repo).
disk_usage="$(df -P / | awk 'NR==2 { gsub("%","",$5); print $5 }')"

process_count="$(ps -e --no-headers | wc -l)"

# Red: delta de bytes totales (todas las interfaces salvo loopback) desde la
# corrida anterior, usando STATE_FILE para persistir la muestra entre ciclos
# del timer (cada ciclo es un proceso nuevo, no hay estado en memoria).
now_epoch="$(date +%s)"
read_net_bytes() {
  awk -F'[: ]+' '$1 != "" && $1 != "lo" && NR>2 { rx+=$3; tx+=$11 } END { print rx+0, tx+0 }' /proc/net/dev
}
net_now="$(read_net_bytes)"
net_rx_now="$(echo "$net_now" | awk '{print $1}')"
net_tx_now="$(echo "$net_now" | awk '{print $2}')"

net_in="0"
net_out="0"
if [ -f "$STATE_FILE" ]; then
  # shellcheck disable=SC1090
  source "$STATE_FILE"
  elapsed=$((now_epoch - ${PREV_EPOCH:-now_epoch}))
  if [ "$elapsed" -gt 0 ]; then
    net_in="$(awk -v a="${PREV_RX:-0}" -v b="$net_rx_now" -v e="$elapsed" 'BEGIN { d=b-a; if (d<0) d=0; printf "%.2f", d/e }')"
    net_out="$(awk -v a="${PREV_TX:-0}" -v b="$net_tx_now" -v e="$elapsed" 'BEGIN { d=b-a; if (d<0) d=0; printf "%.2f", d/e }')"
  fi
fi
cat > "$STATE_FILE" <<EOF
PREV_EPOCH=$now_epoch
PREV_RX=$net_rx_now
PREV_TX=$net_tx_now
PREV_CPU="$cpu_now"
EOF

# Salud de los contenedores del propio stack (postgres/backend/frontend):
# cualquiera que no este "running", o cuyo healthcheck lo marque "unhealthy",
# entra en unhealthyContainers -- alertEngine.js ya sabe convertir eso en un
# SecurityEvent CUSTOM de severidad HIGH (ver evaluateTelemetry).
unhealthy_json="[]"
if command -v docker >/dev/null 2>&1; then
  unhealthy_list=""
  while IFS='|' read -r name status; do
    [ -z "$name" ] && continue
    case "$status" in
      Up*unhealthy*) unhealthy_list="$unhealthy_list\"$name\"," ;;
      Up*) ;; # corriendo y sin healthcheck fallido: OK
      *) unhealthy_list="$unhealthy_list\"$name\"," ;; # Exited/Restarting/etc.
    esac
  done < <(docker ps -a --filter "name=$COMPOSE_PROJECT" --format '{{.Names}}|{{.Status}}' 2>/dev/null || true)
  unhealthy_json="[${unhealthy_list%,}]"
fi

hostname_val="$(hostname)"

payload=$(cat <<EOF
{
  "cpuUsage": $cpu_usage,
  "memoryUsage": $mem_usage,
  "diskUsage": $disk_usage,
  "networkIn": $net_in,
  "networkOut": $net_out,
  "processCount": $process_count,
  "metadata": { "hostname": "$hostname_val", "unhealthyContainers": $unhealthy_json, "source": "host-monitor.sh",
    "perf": { "cpuSource": "proc-stat-avg", "cpuIowait": $cpu_iowait, "cpuSteal": $cpu_steal, "cores": $cpu_cores, "load1": $load_1 } }
}
EOF
)

response="$(curl -sS -w '\n%{http_code}' -X POST "$BACKEND_URL/api/telemetry" \
  -H "Content-Type: application/json" \
  -H "X-Server-Id: $SERVER_ID" \
  -H "X-Api-Key: $API_KEY" \
  -d "$payload")"

http_code="$(echo "$response" | tail -n1)"
body="$(echo "$response" | sed '$d')"

if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
  echo "OK (HTTP $http_code): CPU ${cpu_usage}% (iowait ${cpu_iowait}%, steal ${cpu_steal}%) RAM ${mem_usage}% Disco ${disk_usage}% - $body"
else
  echo "ERROR (HTTP $http_code): $body" >&2
  exit 1
fi
