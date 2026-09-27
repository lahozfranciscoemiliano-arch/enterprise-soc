#!/usr/bin/env bash
# tune-vps.sh - Ajusta la VPS y el stack del NOC/SOC a los recursos REALES de
# la maquina (nucleos y RAM), para que corra 24/7 aprovechando todo sin
# saturarse. Idempotente: se puede correr las veces que haga falta (lo llama
# vps-update.sh en cada actualizacion; si la VPS cambia de plan, se
# redimensiona sola).
#
#   1. docker-compose.override.yml (no versionado): Postgres dimensionado
#      segun la RAM (shared_buffers, cache, work_mem, workers paralelos por
#      nucleo, /dev/shm), heap de Node del backend y frontend, pool de
#      conexiones de Prisma y threadpool de libuv segun los nucleos.
#   2. Kernel (sysctl): colas de conexiones, puertos efimeros, keepalive,
#      swappiness baja.
#   3. Swap de emergencia si la VPS no tiene: evita que el kernel mate a
#      Postgres (OOM killer) ante un pico de memoria.
#   4. journald con tope de disco (los logs no llenan los 30 GB).
#   5. Nginx: conexiones por worker, compresion gzip de la API/JS.
#   6. Auto-curacion: un timer reinicia cualquier contenedor del stack que
#      Docker marque "unhealthy" (restart: unless-stopped no lo hace).
#
# Uso (como root):  bash deploy/tune-vps.sh
set -uo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OVERRIDE="$APP_DIR/docker-compose.override.yml"

if [ "$(id -u)" -ne 0 ]; then
  echo "Este script debe correrse como root." >&2
  exit 1
fi

cores="$(nproc 2>/dev/null || echo 1)"
ram_mb="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
[ -z "$ram_mb" ] && ram_mb=2048

min() { [ "$1" -lt "$2" ] && echo "$1" || echo "$2"; }
max() { [ "$1" -gt "$2" ] && echo "$1" || echo "$2"; }

echo "  VPS detectada: $cores vCPU, $ram_mb MB de RAM"

# --- 1. Dimensionamiento del stack ------------------------------------------
# Reparto de la RAM: ~25% buffers de Postgres, ~25% heap del backend (tope
# 4 GB), ~12% frontend (tope 1 GB); el resto queda para el cache de disco
# del sistema, que Postgres tambien aprovecha (effective_cache_size).
pg_shared=$(min $((ram_mb / 4)) 8192)
pg_cache=$((ram_mb * 60 / 100))
pg_maint=$(max 64 "$(min $((ram_mb / 16)) 1024)")
pg_work=$(max 4 "$(min $((ram_mb / 400)) 64)")
pg_par_gather=$(max 1 "$(min $((cores / 2)) 4)")
pg_shm=$(max 256 "$(min $((ram_mb / 8)) 2048)")
node_heap=$(max 512 "$(min $((ram_mb / 4)) 4096)")
front_heap=$(max 256 "$(min $((ram_mb / 8)) 1024)")
db_pool=$(max 5 "$(min $((cores * 2 + 3)) 30)")
uv_pool=$(max 4 "$(min $((cores * 2)) 32)")

cat >"$OVERRIDE" <<EOF
# GENERADO por deploy/tune-vps.sh para esta VPS ($cores vCPU, $ram_mb MB RAM).
# No editar a mano ni versionar: se regenera en cada vps-update.sh.
services:
  postgres:
    shm_size: "${pg_shm}m"
    command:
      - postgres
      - -c
      - max_connections=100
      - -c
      - shared_buffers=${pg_shared}MB
      - -c
      - effective_cache_size=${pg_cache}MB
      - -c
      - maintenance_work_mem=${pg_maint}MB
      - -c
      - work_mem=${pg_work}MB
      - -c
      - wal_buffers=16MB
      - -c
      - min_wal_size=512MB
      - -c
      - max_wal_size=2GB
      - -c
      - checkpoint_completion_target=0.9
      - -c
      - random_page_cost=1.1
      - -c
      - effective_io_concurrency=200
      - -c
      - max_worker_processes=$(max 8 "$cores")
      - -c
      - max_parallel_workers=$cores
      - -c
      - max_parallel_workers_per_gather=$pg_par_gather
      - -c
      - max_parallel_maintenance_workers=$pg_par_gather
      - -c
      - jit=off
      - -c
      - autovacuum_vacuum_scale_factor=0.05
      - -c
      - autovacuum_analyze_scale_factor=0.02
      - -c
      - idle_in_transaction_session_timeout=300000
      - -c
      - log_min_duration_statement=2000

  backend:
    environment:
      NODE_OPTIONS: "--max-old-space-size=$node_heap"
      UV_THREADPOOL_SIZE: "$uv_pool"
      DATABASE_POOL_SIZE: "$db_pool"

  frontend:
    environment:
      NODE_OPTIONS: "--max-old-space-size=$front_heap"
EOF
echo "  [OK] Stack dimensionado: Postgres shared_buffers=${pg_shared}MB cache=${pg_cache}MB work_mem=${pg_work}MB, backend heap=${node_heap}MB pool=${db_pool}"

# --- 2. Kernel ----------------------------------------------------------------
cat >/etc/sysctl.d/90-enterprise-soc.conf <<'EOF'
# Enterprise SOC (deploy/tune-vps.sh)
vm.swappiness = 10
vm.vfs_cache_pressure = 50
net.core.somaxconn = 4096
net.core.netdev_max_backlog = 4096
net.ipv4.tcp_max_syn_backlog = 4096
net.ipv4.ip_local_port_range = 10240 65535
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_keepalive_time = 300
net.ipv4.tcp_keepalive_intvl = 30
net.ipv4.tcp_keepalive_probes = 5
fs.file-max = 1048576
fs.inotify.max_user_watches = 524288
EOF
if sysctl -q --system >/dev/null 2>&1; then
  echo "  [OK] Parametros del kernel aplicados"
else
  echo "  [AVISO] Algun parametro del kernel no se pudo aplicar (VPS con kernel compartido); el resto sigue igual"
fi

# --- 3. Swap de emergencia ----------------------------------------------------
if [ "$(awk '/SwapTotal/ {print $2}' /proc/meminfo)" -gt 0 ]; then
  echo "  [OK] La VPS ya tiene swap"
else
  swap_mb=$(min "$ram_mb" 4096)
  free_mb="$(df -Pm / | awk 'NR==2 {print $4}')"
  if [ "$free_mb" -gt $((swap_mb * 3)) ] && fallocate -l "${swap_mb}M" /swapfile 2>/dev/null \
    && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile; then
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
    echo "  [OK] Swap de emergencia de ${swap_mb} MB creado"
  else
    rm -f /swapfile 2>/dev/null
    echo "  [AVISO] No se creo swap (poco disco libre o la VPS no lo permite)"
  fi
fi

# --- 4. journald --------------------------------------------------------------
mkdir -p /etc/systemd/journald.conf.d
cat >/etc/systemd/journald.conf.d/enterprise-soc.conf <<'EOF'
[Journal]
SystemMaxUse=500M
MaxRetentionSec=30day
EOF
systemctl restart systemd-journald >/dev/null 2>&1 && echo "  [OK] Logs del sistema con tope de 500 MB"

# --- 5. Nginx -----------------------------------------------------------------
if command -v nginx >/dev/null 2>&1 && [ -f /etc/nginx/nginx.conf ]; then
  main_bak="$(mktemp)"
  cp /etc/nginx/nginx.conf "$main_bak"
  sed -i -E 's/^(\s*)worker_connections\s+[0-9]+;/\1worker_connections 4096;/' /etc/nginx/nginx.conf
  grep -q 'worker_rlimit_nofile' /etc/nginx/nginx.conf \
    || sed -i -E '0,/^\s*worker_processes/s//worker_rlimit_nofile 65535;\n&/' /etc/nginx/nginx.conf

  gzip_extra=""
  grep -Eq '^\s*gzip\s+on;' /etc/nginx/nginx.conf || gzip_extra="gzip on;"
  cat >/etc/nginx/conf.d/enterprise-soc-perf.conf <<EOF
# Enterprise SOC (deploy/tune-vps.sh): compresion de la API y del frontend.
$gzip_extra
gzip_comp_level 5;
gzip_min_length 1024;
gzip_proxied any;
gzip_vary on;
gzip_types application/json application/javascript text/css text/plain image/svg+xml;
server_tokens off;
EOF
  if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx && echo "  [OK] Nginx: 4096 conexiones por worker + gzip"
  else
    # Alguna directiva ya estaba definida en la config del sistema: se
    # vuelve atras sin tocar nada.
    cp "$main_bak" /etc/nginx/nginx.conf
    rm -f /etc/nginx/conf.d/enterprise-soc-perf.conf
    nginx -t >/dev/null 2>&1 && systemctl reload nginx
    echo "  [AVISO] Nginx rechazo el ajuste; se dejo la config original"
  fi
  rm -f "$main_bak"
fi

# --- 6. Auto-curacion de contenedores ----------------------------------------
cp "$APP_DIR/deploy/soc-autoheal.sh" /usr/local/bin/soc-autoheal.sh
chmod 755 /usr/local/bin/soc-autoheal.sh
cat >/etc/systemd/system/soc-autoheal.service <<'EOF'
[Unit]
Description=Enterprise SOC - reinicia contenedores unhealthy
After=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/soc-autoheal.sh
EOF
cat >/etc/systemd/system/soc-autoheal.timer <<'EOF'
[Unit]
Description=Enterprise SOC - auto-curacion cada 2 minutos

[Timer]
OnBootSec=3min
OnUnitActiveSec=2min

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload && systemctl enable --now soc-autoheal.timer >/dev/null 2>&1 \
  && echo "  [OK] Auto-curacion activa (reinicia contenedores unhealthy)"

exit 0
