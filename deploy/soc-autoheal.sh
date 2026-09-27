#!/usr/bin/env bash
# soc-autoheal.sh - Reinicia los contenedores del stack que Docker marca
# "unhealthy" (su healthcheck falla varias veces seguidas). Docker por si
# solo solo reinicia un contenedor si el proceso MUERE; uno colgado (event
# loop trabado, Postgres sin responder) quedaria asi indefinidamente.
# Lo corre soc-autoheal.timer cada 2 minutos (ver deploy/tune-vps.sh).
set -uo pipefail

for name in $(docker ps --filter "name=enterprise-soc-" --filter "health=unhealthy" --format '{{.Names}}'); do
  logger -t soc-autoheal "Contenedor $name unhealthy: reiniciando"
  docker restart --time 20 "$name" >/dev/null
done

# Disco casi lleno: se liberan imagenes y cache de build viejos (cada
# actualizacion deja ~1 GB de capas sin usar).
used="$(df -P / | awk 'NR==2 {gsub("%", "", $5); print $5}')"
if [ "${used:-0}" -ge 85 ]; then
  logger -t soc-autoheal "Disco al ${used}%: limpiando imagenes y cache de Docker sin uso"
  docker image prune -f >/dev/null 2>&1
  docker builder prune -f >/dev/null 2>&1
fi
exit 0
