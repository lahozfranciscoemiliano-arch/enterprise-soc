"""
agent.py - Agente de monitoreo Enterprise SOC (Windows)

Recolecta metricas de CPU/RAM/disco/red con psutil y los errores mas
recientes del Visor de Eventos de Windows (System y Application), y los
envia cada POLL_INTERVAL_SECONDS al backend NOC/SOC via POST /api/telemetry.

Instrucciones de compilacion a .exe con PyInstaller al final de este archivo.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

import psutil
import requests
from dotenv import load_dotenv

try:
    import win32evtlog
    import win32evtlogutil
except ImportError:  # pragma: no cover - solo disponible en Windows con pywin32
    win32evtlog = None
    win32evtlogutil = None


def get_base_dir() -> Path:
    """Carpeta del .exe compilado (PyInstaller) o del script en desarrollo.

    sys.executable dentro de un build de PyInstaller apunta al .exe real;
    __file__ apuntaria a una carpeta temporal de extraccion, por eso se
    distingue con sys.frozen.
    """
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


BASE_DIR = get_base_dir()
load_dotenv(BASE_DIR / ".env")

BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:3000").rstrip("/")
SERVER_ID = os.getenv("SERVER_ID", "")
API_KEY = os.getenv("API_KEY", "")
POLL_INTERVAL_SECONDS = int(os.getenv("POLL_INTERVAL_SECONDS", "60"))
REQUEST_TIMEOUT_SECONDS = int(os.getenv("REQUEST_TIMEOUT_SECONDS", "10"))
EVENT_LOG_MAX_ERRORS = int(os.getenv("EVENT_LOG_MAX_ERRORS", "10"))
EVENT_LOGS_TO_READ = ("System", "Application")

logger = logging.getLogger("enterprise-soc-agent")
logger.setLevel(logging.INFO)

_console_handler = logging.StreamHandler()
_file_handler = RotatingFileHandler(
    BASE_DIR / "agent.log", maxBytes=2_000_000, backupCount=3, encoding="utf-8"
)
_formatter = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
_console_handler.setFormatter(_formatter)
_file_handler.setFormatter(_formatter)
logger.addHandler(_console_handler)
logger.addHandler(_file_handler)


@dataclass
class NetSample:
    bytes_sent: int
    bytes_recv: int
    timestamp: float


_last_net_sample: NetSample | None = None


def collect_network_throughput() -> tuple[float, float]:
    """Devuelve (bytes/seg entrada, bytes/seg salida) desde la ultima lectura.

    psutil.net_io_counters() es un contador acumulado desde el arranque del
    sistema, asi que se calcula la diferencia contra la muestra anterior
    para reportar un valor instantaneo util para graficar.
    """
    global _last_net_sample
    counters = psutil.net_io_counters()
    now = time.monotonic()

    if _last_net_sample is None:
        _last_net_sample = NetSample(counters.bytes_sent, counters.bytes_recv, now)
        return 0.0, 0.0

    elapsed = max(now - _last_net_sample.timestamp, 1e-6)
    bytes_in = max(counters.bytes_recv - _last_net_sample.bytes_recv, 0) / elapsed
    bytes_out = max(counters.bytes_sent - _last_net_sample.bytes_sent, 0) / elapsed

    _last_net_sample = NetSample(counters.bytes_sent, counters.bytes_recv, now)
    return round(bytes_in, 2), round(bytes_out, 2)


def collect_system_metrics() -> dict[str, Any]:
    """Metricas base con psutil: CPU, RAM, disco, red y numero de procesos."""
    cpu_usage = psutil.cpu_percent(interval=1)  # bloquea 1s para una medicion real
    memory = psutil.virtual_memory()
    disk_path = "C:\\" if sys.platform == "win32" else "/"
    disk = psutil.disk_usage(disk_path)
    net_in, net_out = collect_network_throughput()

    return {
        "cpuUsage": round(cpu_usage, 2),
        "memoryUsage": round(memory.percent, 2),
        "diskUsage": round(disk.percent, 2),
        "networkIn": net_in,
        "networkOut": net_out,
        "processCount": len(psutil.pids()),
    }


def read_event_log_errors(log_type: str, max_events: int) -> list[dict[str, Any]]:
    """Lee los errores mas recientes de un log del Visor de Eventos de Windows."""
    if win32evtlog is None:
        logger.warning("pywin32 no disponible; se omite lectura del Visor de Eventos")
        return []

    errors: list[dict[str, Any]] = []
    handle = None

    try:
        handle = win32evtlog.OpenEventLog(None, log_type)
        flags = win32evtlog.EVENTLOG_BACKWARDS_READ | win32evtlog.EVENTLOG_SEQUENTIAL_READ

        events = win32evtlog.ReadEventLog(handle, flags, 0)
        while events and len(errors) < max_events:
            for event in events:
                if event.EventType != win32evtlog.EVENTLOG_ERROR_TYPE:
                    continue

                try:
                    message = win32evtlogutil.SafeFormatMessage(event, log_type)
                except Exception:  # pragma: no cover - mensaje sin formato disponible
                    message = "(mensaje no disponible)"

                errors.append(
                    {
                        "log": log_type,
                        "source": event.SourceName,
                        # EventID trae qualifiers en los bits altos; se enmascara
                        # para obtener el ID real que se ve en el Visor de Eventos.
                        "eventId": event.EventID & 0xFFFF,
                        "timeGenerated": event.TimeGenerated.isoformat(),
                        "message": (message or "").strip()[:500],
                    }
                )

                if len(errors) >= max_events:
                    break

            if len(errors) >= max_events:
                break

            events = win32evtlog.ReadEventLog(handle, flags, 0)

    except Exception as exc:
        logger.warning("No se pudo leer el log '%s' del Visor de Eventos: %s", log_type, exc)
    finally:
        if handle is not None:
            win32evtlog.CloseEventLog(handle)

    return errors


def collect_recent_errors() -> list[dict[str, Any]]:
    """Combina los errores mas recientes de System y Application, mas nuevos primero."""
    all_errors: list[dict[str, Any]] = []

    for log_type in EVENT_LOGS_TO_READ:
        all_errors.extend(read_event_log_errors(log_type, EVENT_LOG_MAX_ERRORS))

    all_errors.sort(key=lambda e: e["timeGenerated"], reverse=True)
    return all_errors[:EVENT_LOG_MAX_ERRORS]


def build_payload() -> dict[str, Any]:
    metrics = collect_system_metrics()
    recent_errors = collect_recent_errors()

    return {
        **metrics,
        "recordedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
        "metadata": {
            "hostname": os.getenv("COMPUTERNAME", ""),
            "recentEventLogErrors": recent_errors,
        },
    }


def send_telemetry(payload: dict[str, Any]) -> None:
    url = f"{BACKEND_URL}/api/telemetry"
    headers = {
        "Content-Type": "application/json",
        "X-Server-Id": SERVER_ID,
        "X-Api-Key": API_KEY,
    }

    try:
        response = requests.post(url, json=payload, headers=headers, timeout=REQUEST_TIMEOUT_SECONDS)
        logger.debug("Respuesta cruda del backend (HTTP %s): %s", response.status_code, response.text[:500])
        response.raise_for_status()
        body = response.json()
        logger.info(
            "Telemetria enviada OK (HTTP %s, telemetryId=%s, alertas=%s)",
            response.status_code,
            body.get("telemetryId"),
            body.get("alertsTriggered", 0),
        )
    except requests.exceptions.RequestException as exc:
        status = getattr(exc.response, "status_code", "sin respuesta")
        logger.error("Fallo al enviar telemetria a %s (HTTP %s): %s", url, status, exc)


def validate_config() -> None:
    missing = [name for name, value in (("SERVER_ID", SERVER_ID), ("API_KEY", API_KEY)) if not value]
    if missing:
        logger.error(
            "Faltan variables de entorno obligatorias en .env: %s. "
            "Copia .env.example a .env y completa los valores provistos por el backend.",
            ", ".join(missing),
        )
        sys.exit(1)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Agente de monitoreo Enterprise SOC")
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Modo consola/debug: muestra en texto plano las metricas, los errores del "
        "Visor de Eventos y la respuesta HTTP del backend en cada ciclo.",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Ejecuta un unico ciclo de recoleccion y envio, y termina (util para probar sin esperar 60s).",
    )
    return parser.parse_args()


def run_cycle(debug: bool) -> None:
    payload = build_payload()

    if debug:
        errors = payload["metadata"]["recentEventLogErrors"]
        logger.debug(
            "Metricas leidas -> CPU: %.2f%% | RAM: %.2f%% | Disco: %.2f%% | Procesos: %d | "
            "Red entrada: %.2f B/s | Red salida: %.2f B/s",
            payload["cpuUsage"],
            payload["memoryUsage"],
            payload["diskUsage"],
            payload["processCount"],
            payload["networkIn"],
            payload["networkOut"],
        )
        logger.debug("Errores leidos del Visor de Eventos: %d", len(errors))
        for err in errors:
            logger.debug(
                "  [%s][%s] EventID %s - %s: %s",
                err["timeGenerated"],
                err["log"],
                err["eventId"],
                err["source"],
                err["message"][:150],
            )
        logger.debug("Payload completo a enviar:\n%s", json.dumps(payload, indent=2, ensure_ascii=False))

    send_telemetry(payload)


def main() -> None:
    args = parse_args()

    if args.debug:
        logger.setLevel(logging.DEBUG)
        _console_handler.setLevel(logging.DEBUG)

    validate_config()
    logger.info(
        "Agente Enterprise SOC iniciado. Backend=%s, intervalo=%ss, debug=%s, once=%s",
        BACKEND_URL,
        POLL_INTERVAL_SECONDS,
        args.debug,
        args.once,
    )

    while True:
        cycle_start = time.monotonic()

        try:
            run_cycle(args.debug)
        except Exception:
            logger.exception("Error inesperado en el ciclo de recoleccion")

        if args.once:
            logger.info("Modo --once: ciclo unico completado, el agente termina.")
            break

        elapsed = time.monotonic() - cycle_start
        sleep_time = max(POLL_INTERVAL_SECONDS - elapsed, 1)
        time.sleep(sleep_time)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        logger.info("Agente detenido por el usuario")


# ---------------------------------------------------------------------------
# Como compilar este agente a un .exe (Windows) con PyInstaller
# ---------------------------------------------------------------------------
# 1. En un entorno virtual limpio, instala las dependencias del proyecto y
#    PyInstaller:
#
#       pip install -r requirements.txt
#       pip install pyinstaller
#
# 2. Compila en un unico ejecutable. Mientras depuras dejalo con consola;
#    para produccion agrega --noconsole para que corra sin ventana visible:
#
#       pyinstaller --onefile --name enterprise-soc-agent ^
#           --hidden-import=win32timezone ^
#           --hidden-import=win32api ^
#           agent.py
#
#    (El "^" es continuacion de linea en cmd.exe; en PowerShell usa "`" o
#    pon todo el comando en una sola linea.)
#
#    --hidden-import=win32timezone es necesario porque PyInstaller no
#    detecta automaticamente esa dependencia interna de pywin32, y sin ella
#    el .exe compilado falla al iniciar con un ImportError.
#
# 3. El ejecutable queda en dist\enterprise-soc-agent.exe. Copia junto a el
#    un archivo .env (basado en .env.example) con el SERVER_ID y API_KEY
#    reales emitidos por el backend: el agente busca el .env en la misma
#    carpeta que el .exe, no en la carpeta desde la que se lo ejecute.
#
# 4. Para correrlo en segundo plano de forma permanente en el servidor,
#    registralo en el Programador de Tareas de Windows (Task Scheduler) con
#    disparador "al iniciar sesion" o "al arrancar el sistema", o instalalo
#    como servicio de Windows con una herramienta como NSSM.
#
# 5. Los logs de ejecucion quedan en agent.log junto al .exe, con rotacion
#    automatica (~2 MB por archivo, hasta 3 archivos de respaldo).
# ---------------------------------------------------------------------------
