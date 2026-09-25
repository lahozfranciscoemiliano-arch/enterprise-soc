#!/usr/bin/env python3
"""
fortinet_poller.py - Ingesta de eventos FortiGate por API hacia el SOC/NOC.

Corre en un equipo que tenga acceso de red a la interfaz de management del
FortiGate (normalmente NO es accesible desde internet, por eso este script
tiene que vivir en la misma LAN/VPN que el equipo -- una de las máquinas
Windows de esa sucursal, o cualquier PC/mini-PC Linux en esa red sirven).

Cada ciclo, consulta los logs recientes del FortiGate via su API REST v2
(GET /api/v2/log/disk/<tipo>), los clasifica con la MISMA lógica que usa
el backend para el receptor de syslog (ver backend/src/services/fortinet.js
-> classifyFortiFields, portada acá 1:1 a propósito para que un evento se
vea igual sin importar si llegó por syslog o por este poller), y los manda
a POST /api/forti/events del SOC.

NOTA HONESTA: el mapeo de subtype/level cubre lo mas comun de FortiOS
documentado publicamente, pero no se probo contra un FortiGate real de
Grupo Bistro. Revisa los primeros eventos que lleguen al dashboard
(pestaña Fortinet) contra lo que realmente esta pasando en el equipo, y
ajusta EVENT_ENDPOINTS o classify_fields() si hace falta.

------------------------------------------------------------------------
CONFIGURACION EN EL FORTIGATE (una sola vez, como admin):
  1. System -> Administrators -> Create New -> REST API Admin.
  2. Asignale un nombre (ej. "soc-poller") y un Admin Profile de SOLO
     LECTURA si tu FortiOS lo permite (el poller nunca necesita escribir
     nada) -- si no hay uno de solo lectura, cred un profile custom con
     acceso de lectura a "Log & Report" nomas.
  3. Restringí "Trusted Hosts" a la IP de la maquina donde corre este
     script, si es una IP fija.
  4. Al confirmar, FortiOS te muestra el API TOKEN una sola vez -- copialo
     ahora (es el valor de FORTIGATE_API_TOKEN abajo).

CONFIGURACION EN EL SOC (una sola vez, por cada FortiGate):
  Admin -> Fortinet -> "+ Nuevo dispositivo" -> te da un Device ID y una
  API Key (tambien se muestra una sola vez). Van en FORTI_DEVICE_ID y
  FORTI_API_KEY abajo.

USO:
  pip install -r requirements.txt
  cp .env.example .env   # completa los valores
  python3 fortinet_poller.py

  Para dejarlo corriendo solo, ver fortinet-poller.service (Linux/systemd)
  o las instrucciones de Tarea Programada de Windows en el README de esta
  carpeta.
------------------------------------------------------------------------
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv
from urllib3.exceptions import InsecureRequestWarning

load_dotenv()
requests.packages.urllib3.disable_warnings(InsecureRequestWarning)  # type: ignore[attr-defined]

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("fortinet_poller")

# --- Configuracion ----------------------------------------------------------

FORTIGATE_HOST = os.environ["FORTIGATE_HOST"]  # ej. 192.168.10.1 (sin https://)
FORTIGATE_API_TOKEN = os.environ["FORTIGATE_API_TOKEN"]
FORTIGATE_VDOM = os.environ.get("FORTIGATE_VDOM", "root")
FORTIGATE_VERIFY_TLS = os.environ.get("FORTIGATE_VERIFY_TLS", "false").lower() == "true"

SOC_BACKEND_URL = os.environ["SOC_BACKEND_URL"].rstrip("/")  # ej. http://203.161.39.123
FORTI_DEVICE_ID = os.environ["FORTI_DEVICE_ID"]
FORTI_API_KEY = os.environ["FORTI_API_KEY"]

POLL_INTERVAL_SECONDS = int(os.environ.get("POLL_INTERVAL_SECONDS", "60"))
ROWS_PER_POLL = int(os.environ.get("ROWS_PER_POLL", "200"))
FORWARD_TRAFFIC_DENY = os.environ.get("FORWARD_TRAFFIC_DENY", "false").lower() == "true"
STATE_FILE = Path(os.environ.get("STATE_FILE", "fortinet_poller_state.json"))

# location/logtype de la API de logs de FortiOS (GET /api/v2/log/<location>/<logtype>).
# "disk" requiere que el modelo tenga almacenamiento local habilitado para logs;
# si tu FortiGate solo guarda en memoria, cambia "disk" por "memory" acá.
LOG_LOCATION = os.environ.get("FORTIGATE_LOG_LOCATION", "disk")

# Los nombres exactos de subtipo varian entre versiones de FortiOS (7.x separo
# "event" en mas subtipos que 6.x). Se listan los mas comunes; uno que no
# exista en tu equipo simplemente devuelve error y se lo saltea (no rompe el
# resto del ciclo) -- mira el log al arrancar para ver cuales matchean.
EVENT_ENDPOINTS = [p.strip() for p in os.environ.get(
    "FORTIGATE_LOG_ENDPOINTS",
    "event/vpn,event/system,event/admin,event/ha,ips,virus,anomaly",
).split(",") if p.strip()]

if FORWARD_TRAFFIC_DENY:
    EVENT_ENDPOINTS.append("traffic/forward")

# --- Clasificacion (portado 1:1 de backend/src/services/fortinet.js) --------

LEVEL_TO_SEVERITY = {
    "emergency": "CRITICAL",
    "alert": "CRITICAL",
    "critical": "CRITICAL",
    "error": "HIGH",
    "warning": "MEDIUM",
    "notice": "LOW",
    "information": "LOW",
    "debug": "LOW",
}

VALID_SEVERITIES = {"LOW", "MEDIUM", "HIGH", "CRITICAL"}


def classify_fields(fields: dict[str, Any]) -> dict[str, Any]:
    type_ = str(fields.get("type", "")).lower()
    subtype = str(fields.get("subtype", "")).lower()
    level = str(fields.get("level", "")).lower()
    action = str(fields.get("action", "")).lower()
    msg = str(fields.get("msg", ""))

    event_type = "OTHER"
    severity = LEVEL_TO_SEVERITY.get(level, "LOW")

    if subtype == "vpn":
        event_type = "VPN_LOGOUT" if ("logout" in action or "logout" in msg.lower()) else "VPN_LOGIN"
    elif subtype == "ips":
        event_type = "IPS_ATTACK"
        severity = str(fields.get("severity", severity or "HIGH")).upper()
    elif subtype in ("virus", "antivirus"):
        event_type = "VIRUS_DETECTED"
        severity = "HIGH"
    elif subtype == "ha":
        event_type = "HA_FAILOVER"
        severity = "HIGH"
    elif type_ == "event" and subtype == "system" and "interface" in msg.lower():
        event_type = "INTERFACE_DOWN"
    elif subtype == "admin" or (type_ == "event" and subtype == "system" and "login" in msg.lower()):
        event_type = "ADMIN_LOGIN"
    elif type_ == "event" and subtype == "config":
        event_type = "CONFIG_CHANGE"
        severity = "MEDIUM" if severity == "LOW" else severity
    elif type_ == "traffic" and action == "deny":
        event_type = "FIREWALL_DENY"
        severity = "LOW"
    elif type_ == "traffic":
        event_type = "TRAFFIC_ANOMALY"

    if severity not in VALID_SEVERITIES:
        severity = "LOW"

    description = fields.get("msg") or fields.get("logdesc") or f"Evento FortiGate ({type_ or 'desconocido'}/{subtype or 'sin subtipo'})"

    return {
        "type": event_type,
        "severity": severity,
        "description": str(description)[:1000],
        "sourceIp": fields.get("srcip") or fields.get("remip") or None,
        "destIp": fields.get("dstip") or None,
        "raw": fields,
    }


# --- Estado (watermark de timestamp por endpoint, para no duplicar) ---------


def load_state() -> dict[str, int]:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            log.warning("No se pudo leer %s, arranco de cero", STATE_FILE)
    return {}


def save_state(state: dict[str, int]) -> None:
    STATE_FILE.write_text(json.dumps(state))


def row_timestamp(row: dict[str, Any]) -> int | None:
    if "timestamp" in row:
        try:
            return int(row["timestamp"])
        except (TypeError, ValueError):
            pass
    date_, time_ = row.get("date"), row.get("time")
    if date_ and time_:
        try:
            return int(time.mktime(time.strptime(f"{date_} {time_}", "%Y-%m-%d %H:%M:%S")))
        except ValueError:
            pass
    return None


# --- FortiGate API ------------------------------------------------------------

session = requests.Session()
session.headers.update({"Authorization": f"Bearer {FORTIGATE_API_TOKEN}"})
session.verify = FORTIGATE_VERIFY_TLS


def fetch_log_rows(endpoint: str) -> list[dict[str, Any]]:
    url = f"https://{FORTIGATE_HOST}/api/v2/log/{LOG_LOCATION}/{endpoint}"
    try:
        resp = session.get(url, params={"rows": ROWS_PER_POLL, "vdom": FORTIGATE_VDOM}, timeout=15)
    except requests.RequestException as exc:
        log.warning("No se pudo consultar %s: %s", endpoint, exc)
        return []

    if resp.status_code != 200:
        log.warning("FortiGate devolvio %s para %s: %s", resp.status_code, endpoint, resp.text[:200])
        return []

    try:
        body = resp.json()
    except ValueError:
        log.warning("Respuesta no-JSON de %s", endpoint)
        return []

    return body.get("results") or []


# --- SOC ----------------------------------------------------------------------


def send_event(normalized: dict[str, Any]) -> bool:
    try:
        resp = requests.post(
            f"{SOC_BACKEND_URL}/api/forti/events",
            headers={"X-Device-Id": FORTI_DEVICE_ID, "X-Api-Key": FORTI_API_KEY, "Content-Type": "application/json"},
            json=normalized,
            timeout=10,
        )
    except requests.RequestException as exc:
        log.warning("No se pudo enviar evento al SOC: %s", exc)
        return False

    if resp.status_code >= 300:
        log.warning("SOC rechazo el evento (HTTP %s): %s", resp.status_code, resp.text[:200])
        return False
    return True


# --- Loop principal -------------------------------------------------------------


def poll_once(state: dict[str, int]) -> None:
    for endpoint in EVENT_ENDPOINTS:
        rows = fetch_log_rows(endpoint)
        if not rows:
            continue

        last_ts = state.get(endpoint)
        first_run = last_ts is None
        max_ts_seen = last_ts or 0

        new_rows = []
        for row in rows:
            ts = row_timestamp(row)
            if ts is None:
                continue
            max_ts_seen = max(max_ts_seen, ts)
            if not first_run and ts > last_ts:
                new_rows.append(row)

        if first_run:
            # Primera vez que vemos este endpoint: solo establece el
            # punto de partida, no reenvia todo el historico guardado en
            # el equipo (podrian ser miles de eventos viejos).
            log.info("Primer poll de %s: %d filas, arranco el watermark sin reenviar historico", endpoint, len(rows))
        else:
            for row in sorted(new_rows, key=row_timestamp):  # type: ignore[arg-type]
                normalized = classify_fields(row)
                if send_event(normalized):
                    log.info("Evento enviado: %s (%s) - %s", normalized["type"], normalized["severity"], normalized["description"][:80])

        state[endpoint] = max_ts_seen

    save_state(state)


def main() -> None:
    log.info("fortinet_poller arrancando: FortiGate=%s vdom=%s -> SOC=%s", FORTIGATE_HOST, FORTIGATE_VDOM, SOC_BACKEND_URL)
    log.info("Endpoints a consultar: %s", ", ".join(EVENT_ENDPOINTS))
    state = load_state()

    while True:
        try:
            poll_once(state)
        except Exception:
            log.exception("Error inesperado en el ciclo de poll, sigo en el proximo")
        time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
