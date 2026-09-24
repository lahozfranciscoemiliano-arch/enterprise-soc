"""
agent.py - Agente de monitoreo Enterprise SOC (Windows)
Autor: Francisco E. Lahoz F.

Recolecta metricas de CPU/RAM/disco/red con psutil, los errores mas
recientes del Visor de Eventos de Windows (System y Application), y el
estado del backup nativo de Windows (Windows Server Backup / Backup and
Restore heredado en Windows 10 y 11), y los envia al backend NOC/SOC via
POST /api/telemetry y POST /api/backup-status.

Tambien mantiene un canal de control persistente hacia el backend para
recibir pedidos de acceso remoto (tunel inverso RDP/VNC) y se auto-actualiza
cuando el backend publica una version nueva del agente.

IMPORTANTE: la revision de backups (wbadmin / WMI de Windows Server Backup)
requiere que el proceso corra como Administrador. Sin privilegios elevados,
el agente sigue reportando CPU/RAM/disco/eventos con normalidad, pero el
estado de backup se reporta como UNKNOWN con el detalle del error.

Instrucciones de compilacion a .exe con PyInstaller al final de este archivo.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import logging
import os
import re
import socket as socket_module
import subprocess
import sys
import threading
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
    import websocket  # websocket-client: canal de control para el tunel de acceso remoto
except ImportError:  # pragma: no cover - se degrada sin la funcion de acceso remoto
    websocket = None

try:
    import win32evtlog
    import win32evtlogutil
except ImportError:  # pragma: no cover - solo disponible en Windows con pywin32
    win32evtlog = None
    win32evtlogutil = None

try:
    import win32com.client
    import win32service
    import win32serviceutil
except ImportError:  # pragma: no cover - solo disponible en Windows con pywin32
    win32com = None
    win32service = None
    win32serviceutil = None


# Se compara contra AGENT_LATEST_VERSION (configurable en Admin -> Configuracion
# del backend) para el auto-update -- ver check_and_apply_update(). Subir este
# numero (y el valor guardado en el backend) cada vez que se publique un
# nuevo build del .exe.
AGENT_VERSION = "1.1.0"


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
BACKUP_CHECK_INTERVAL_SECONDS = int(os.getenv("BACKUP_CHECK_INTERVAL_SECONDS", "1800"))

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
# -inf fuerza que la primera vuelta del loop siempre revise el backup,
# sin importar el intervalo configurado.
_last_backup_check: float = float("-inf")


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


def check_vss_service() -> bool:
    """True si el servicio de Volume Shadow Copy (VSS) esta corriendo.

    Casi cualquier mecanismo de backup nativo de Windows (Server Backup,
    Backup and Restore, VSS-aware de terceros) depende de este servicio.
    """
    if win32serviceutil is None or win32service is None:
        return False

    try:
        status = win32serviceutil.QueryServiceStatus("VSS")
        return status[1] == win32service.SERVICE_RUNNING
    except Exception:
        return False


def _wmi_datetime_to_iso(value: Any) -> str | None:
    """Convierte un CIM_DATETIME de WMI (yyyymmddhhmmss.mmmmmm+UUU) a ISO-8601 UTC.

    Se ignora el offset de zona horaria del final (simplificacion aceptable
    para esta metrica; lo relevante es tener una fecha aproximada de la
    ultima copia, no precision de husos horarios).
    """
    if not value or not isinstance(value, str) or len(value) < 14:
        return None
    try:
        dt = datetime.strptime(value[:14], "%Y%m%d%H%M%S")
        return dt.strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    except ValueError:
        return None


def check_wmi_windows_backup() -> dict[str, Any] | None:
    """Consulta Windows Server Backup via WMI (root\\Microsoft\\Windows\\WindowsBackup).

    Solo existe si la caracteristica "Windows Server Backup" esta instalada
    (tipicamente Windows Server). En Windows 10/11 esta namespace no existe
    y esta funcion devuelve None para que se intente el siguiente metodo.
    """
    if win32com is None:
        return None

    try:
        wmi = win32com.client.GetObject(r"winmgmts:\\.\root\Microsoft\Windows\WindowsBackup")
        summaries = list(wmi.InstancesOf("MSFT_WBSummary"))
    except Exception:
        return None

    if not summaries:
        return None

    summary = summaries[0]

    def safe_get(prop: str) -> Any:
        try:
            return getattr(summary, prop)
        except Exception:
            return None

    last_result_hr = safe_get("LastBackupResultHR")
    last_backup_time = safe_get("LastBackupTime")
    last_successful_time = safe_get("LastSuccessfulBackupTime")

    if last_result_hr is None and last_backup_time is None and last_successful_time is None:
        return None

    result = "SUCCESS" if last_result_hr in (0, None) else "FAILED"

    return {
        "result": result,
        "method": "WINDOWS_SERVER_BACKUP",
        "lastBackupAt": _wmi_datetime_to_iso(last_backup_time) or _wmi_datetime_to_iso(last_successful_time),
        "detail": f"LastBackupResultHR={last_result_hr}",
    }


def _decode_console_bytes(data: bytes) -> str:
    """Decodifica la salida de una herramienta de consola de Windows probando,
    en orden, UTF-8 estricto, el codepage OEM del sistema (el que usan
    herramientas de consola clasicas como wbadmin.exe) y Windows-1252.

    La codificacion real varia segun la configuracion regional y si el modo
    "Beta: usar UTF-8 en todo el mundo" de Windows esta activo, por lo que
    fijar un unico codec de antemano (p. ej. 'mbcs') produce texto corrupto
    en algunos sistemas.
    """
    candidates = ["utf-8"]
    try:
        candidates.append(f"cp{ctypes.windll.kernel32.GetOEMCP()}")
    except Exception:
        pass
    candidates.append("cp1252")

    for encoding in candidates:
        try:
            return data.decode(encoding)
        except (UnicodeDecodeError, LookupError):
            continue

    return data.decode("latin-1", errors="replace")


def check_wbadmin() -> dict[str, Any]:
    """Fallback via 'wbadmin get versions', disponible en Server y en 10/11
    con Backup and Restore (Windows 7) configurado.

    El texto de salida de wbadmin depende del idioma de Windows, asi que NO
    se intenta parsear el detalle linea por linea: solo se usa el codigo de
    salida y un heuristico simple para clasificar el resultado, y se
    conserva el texto crudo (ya en el idioma del sistema) en 'detail' para
    que un humano lo pueda leer.
    """
    try:
        proc = subprocess.run(
            ["wbadmin", "get", "versions"],
            capture_output=True,
            timeout=60,
        )
    except FileNotFoundError:
        return {
            "result": "NOT_CONFIGURED",
            "method": "WBADMIN",
            "detail": "wbadmin no esta disponible en este sistema.",
        }
    except subprocess.TimeoutExpired:
        return {
            "result": "UNKNOWN",
            "method": "WBADMIN",
            "detail": "wbadmin get versions supero el tiempo de espera (60s).",
        }

    output = (_decode_console_bytes(proc.stdout or b"") + _decode_console_bytes(proc.stderr or b"")).strip()

    if proc.returncode != 0:
        # Codigo distinto de 0: sin privilegios de administrador, servicio
        # de backup no configurado, o algun otro error. El texto crudo de
        # wbadmin (en el idioma del sistema) explica el motivo exacto.
        return {
            "result": "UNKNOWN",
            "method": "WBADMIN",
            "detail": output[-600:] or f"wbadmin devolvio el codigo {proc.returncode}",
        }

    # Heuristico agnostico al idioma: busca patrones de fecha+hora en la
    # salida para detectar si hay al menos una version de backup listada.
    date_matches = re.findall(r"\d{1,2}[/-]\d{1,2}[/-]\d{2,4}[^\n]{0,25}\d{1,2}:\d{2}", output)

    if not date_matches and len(output) < 300:
        return {
            "result": "NOT_CONFIGURED",
            "method": "WBADMIN",
            "detail": output[-600:] or "No se encontraron versiones de backup.",
        }

    return {
        "result": "SUCCESS",
        "method": "WBADMIN",
        "detail": output[-600:],
    }


def get_backup_status() -> dict[str, Any]:
    """Determina el estado del backup nativo probando varios metodos en orden.

    1. WMI de Windows Server Backup (el mas detallado; solo Server con la
       caracteristica instalada).
    2. wbadmin get versions (funciona tambien en Windows 10/11).
    3. Si ninguno responde, UNKNOWN.

    Siempre se agrega el estado del servicio VSS como señal complementaria.
    """
    vss_ok = check_vss_service()

    status: dict[str, Any] | None = None
    try:
        status = check_wmi_windows_backup()
    except Exception as exc:
        # Nivel WARNING (no DEBUG): esta es la unica ruta de deteccion de
        # backups que no se probo contra un Windows Server real durante el
        # desarrollo, asi que cualquier falla aca debe quedar visible en el
        # log normal del servicio desde el primer despliegue, sin necesitar
        # --debug.
        logger.warning("Fallo la consulta WMI de Windows Server Backup: %s", exc)

    if status is None:
        try:
            status = check_wbadmin()
        except Exception as exc:
            logger.warning("Fallo la consulta wbadmin: %s", exc)
            status = {
                "result": "UNKNOWN",
                "method": "WBADMIN",
                "detail": f"Error inesperado consultando wbadmin: {exc}",
            }

    status["vssServiceOk"] = vss_ok
    return status


def build_backup_payload() -> dict[str, Any]:
    status = get_backup_status()

    payload: dict[str, Any] = {
        "result": status["result"],
        "method": status["method"],
        "vssServiceOk": bool(status.get("vssServiceOk", False)),
        "recordedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
    }

    if status.get("lastBackupAt"):
        payload["lastBackupAt"] = status["lastBackupAt"]
    if status.get("detail"):
        payload["detail"] = status["detail"][:1000]
    if status.get("targetPath"):
        payload["targetPath"] = status["targetPath"]
    if status.get("sizeBytes") is not None:
        payload["sizeBytes"] = status["sizeBytes"]

    return payload


def send_backup_status(payload: dict[str, Any]) -> None:
    url = f"{BACKEND_URL}/api/backup-status"
    headers = {
        "Content-Type": "application/json",
        "X-Server-Id": SERVER_ID,
        "X-Api-Key": API_KEY,
    }

    try:
        response = requests.post(url, json=payload, headers=headers, timeout=REQUEST_TIMEOUT_SECONDS)
        logger.debug("Respuesta cruda backup-status (HTTP %s): %s", response.status_code, response.text[:500])
        response.raise_for_status()
        body = response.json()
        logger.info(
            "Estado de backup enviado OK (HTTP %s, resultado=%s, metodo=%s, alerta=%s)",
            response.status_code,
            payload["result"],
            payload["method"],
            body.get("alertTriggered"),
        )
    except requests.exceptions.RequestException as exc:
        status = getattr(exc.response, "status_code", "sin respuesta")
        logger.error("Fallo al enviar estado de backup a %s (HTTP %s): %s", url, status, exc)


def build_payload() -> dict[str, Any]:
    metrics = collect_system_metrics()
    recent_errors = collect_recent_errors()

    return {
        **metrics,
        "recordedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
        "agentVersion": AGENT_VERSION,
        "metadata": {
            "hostname": os.getenv("COMPUTERNAME", ""),
            "recentEventLogErrors": recent_errors,
        },
    }


def send_telemetry(payload: dict[str, Any]) -> str | None:
    """Devuelve la ultima version de agente publicada en el backend (si la
    respuesta la trae), para que el loop principal decida si auto-actualizar.
    """
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
        return body.get("latestAgentVersion")
    except requests.exceptions.RequestException as exc:
        status = getattr(exc.response, "status_code", "sin respuesta")
        logger.error("Fallo al enviar telemetria a %s (HTTP %s): %s", url, status, exc)
        return None


def validate_config() -> None:
    missing = [name for name, value in (("SERVER_ID", SERVER_ID), ("API_KEY", API_KEY)) if not value]
    if missing:
        logger.error(
            "Faltan variables de entorno obligatorias en .env: %s. "
            "Copia .env.example a .env y completa los valores provistos por el backend.",
            ", ".join(missing),
        )
        sys.exit(1)


def _version_tuple(v: str) -> tuple[int, ...]:
    try:
        return tuple(int(p) for p in v.strip().split("."))
    except ValueError:
        return (0,)


def check_and_apply_update(latest_version: str | None) -> None:
    """Si el backend reporta una version de agente mas nueva (AGENT_LATEST_VERSION
    en Admin -> Configuracion) que la propia, descarga el .exe publicado y se
    reemplaza a si mismo -- para no tener que reinstalar a mano en cada
    servidor cada vez que se publica una mejora.

    Solo aplica cuando corre compilado (sys.frozen); en modo script no tiene
    sentido. Cualquier fallo en el proceso se loguea y se sigue con el ciclo
    normal: un update fallido nunca debe tirar abajo el monitoreo.
    """
    if not latest_version or _version_tuple(latest_version) <= _version_tuple(AGENT_VERSION):
        return

    if not getattr(sys, "frozen", False):
        logger.warning(
            "Hay una version de agente mas nueva disponible (%s, la actual es %s), pero el "
            "auto-update solo aplica al .exe compilado, no en modo script.",
            latest_version,
            AGENT_VERSION,
        )
        return

    logger.info("Actualizando el agente de %s a %s ...", AGENT_VERSION, latest_version)

    try:
        current_exe = Path(sys.executable).resolve()
        download_url = f"{BACKEND_URL}/downloads/enterprise-soc-agent.exe"

        response = requests.get(download_url, timeout=120, stream=True)
        response.raise_for_status()

        new_exe = current_exe.with_name(current_exe.stem + ".new.exe")
        with open(new_exe, "wb") as f:
            for chunk in response.iter_content(chunk_size=1024 * 256):
                f.write(chunk)

        # Un .exe de PyInstaller de este agente nunca pesa unos pocos KB; si
        # pesa eso es que se descargo una pagina de error, no el binario.
        if new_exe.stat().st_size < 1_000_000:
            raise RuntimeError(f"El archivo descargado parece inválido ({new_exe.stat().st_size} bytes)")

        old_exe = current_exe.with_name(current_exe.stem + ".old.exe")
        if old_exe.exists():
            old_exe.unlink()
        current_exe.rename(old_exe)
        new_exe.rename(current_exe)

        logger.info("Actualización descargada y aplicada. Reiniciando para tomar la versión %s...", latest_version)
        # Exit code distinto de 0 a proposito: la Tarea Programada (ver
        # install-agent.ps1, -RestartCount/-RestartInterval) relanza el
        # proceso automaticamente ante una salida no exitosa, y con eso
        # arranca de nuevo ya con el .exe nuevo en su lugar.
        sys.exit(75)
    except SystemExit:
        raise
    except Exception as exc:
        logger.error("Falló la auto-actualización del agente: %s", exc)


def _cleanup_previous_update() -> None:
    """Borra el .exe viejo (name.old.exe) que haya quedado de una
    actualizacion anterior, ahora que ya arranco bien el nuevo."""
    if not getattr(sys, "frozen", False):
        return
    current_exe = Path(sys.executable).resolve()
    old_exe = current_exe.with_name(current_exe.stem + ".old.exe")
    if old_exe.exists():
        try:
            old_exe.unlink()
            logger.debug("Limpieza: se borró el ejecutable anterior (%s)", old_exe)
        except OSError:
            pass  # puede seguir bloqueado un instante justo despues de reiniciar; no es grave


def _ws_base_url() -> str:
    if BACKEND_URL.startswith("https://"):
        return "wss://" + BACKEND_URL[len("https://") :]
    if BACKEND_URL.startswith("http://"):
        return "ws://" + BACKEND_URL[len("http://") :]
    return BACKEND_URL


def _close_quietly(*closers) -> None:
    for closer in closers:
        try:
            closer()
        except Exception:
            pass


def _pump_socket_to_ws(sock: socket_module.socket, ws: Any, stop_event: threading.Event) -> None:
    try:
        while not stop_event.is_set():
            data = sock.recv(65536)
            if not data:
                break
            ws.send(data, opcode=websocket.ABNF.OPCODE_BINARY)
    except Exception as exc:
        logger.debug("Pata TCP->WS del tunel terminada: %s", exc)
    finally:
        # Cerrar las dos puntas aca, no solo marcar el evento: si no, el otro
        # thread puede quedar bloqueado para siempre en un recv() que nunca
        # se va a desbloquear solo porque este thread termino.
        stop_event.set()
        _close_quietly(sock.close, ws.close)


def _pump_ws_to_socket(ws: Any, sock: socket_module.socket, stop_event: threading.Event) -> None:
    try:
        while not stop_event.is_set():
            opcode, data = ws.recv_data()
            if opcode == websocket.ABNF.OPCODE_CLOSE:
                break
            if opcode in (websocket.ABNF.OPCODE_BINARY, websocket.ABNF.OPCODE_TEXT) and data:
                sock.sendall(data)
    except Exception as exc:
        logger.debug("Pata WS->TCP del tunel terminada: %s", exc)
    finally:
        stop_event.set()
        _close_quietly(sock.close, ws.close)


def handle_remote_tunnel(session_id: str, target_port: int) -> None:
    """Abre la "pata" de datos del tunel de acceso remoto: conecta un socket
    TCP local (donde escucha RDP/VNC en esta misma maquina) y lo pega, byte a
    byte, a un WebSocket hacia el backend. El backend no interpreta nada de
    este trafico, solo lo reenvia a la otra punta -- el relay que corre el
    operador en su propia maquina (ver tools/remote-relay.js).
    """
    if websocket is None:
        logger.error("No se puede abrir un túnel de acceso remoto: falta el paquete websocket-client")
        return

    logger.info("Solicitud de acceso remoto recibida (sesión=%s, puerto=%s)", session_id, target_port)

    tunnel_url = f"{_ws_base_url()}/ws/tunnel/{session_id}?role=agent"
    headers = [f"X-Server-Id: {SERVER_ID}", f"X-Api-Key: {API_KEY}"]

    sock = None
    ws = None
    try:
        # El timeout de 10s es solo para el connect inicial. Si no se
        # resetea a None despues, python deja ese mismo timeout puesto para
        # los recv() de ahi en mas, y el tunel se corta solo apenas pasan 10
        # segundos sin trafico (que es exactamente lo que pasa entre que se
        # abre el tunel y el operador conecta su cliente RDP/VNC).
        sock = socket_module.create_connection(("127.0.0.1", target_port), timeout=10)
        sock.settimeout(None)
        ws = websocket.create_connection(tunnel_url, header=headers, timeout=10)
        ws.settimeout(None)

        stop_event = threading.Event()
        t1 = threading.Thread(target=_pump_socket_to_ws, args=(sock, ws, stop_event), daemon=True)
        t2 = threading.Thread(target=_pump_ws_to_socket, args=(ws, sock, stop_event), daemon=True)
        t1.start()
        t2.start()
        t1.join()
        t2.join()

        logger.info("Túnel de acceso remoto finalizado (sesión=%s)", session_id)
    except Exception as exc:
        logger.error("Error en el túnel de acceso remoto (sesión=%s): %s", session_id, exc)
    finally:
        for closer in (sock.close if sock else None, ws.close if ws else None):
            if closer:
                try:
                    closer()
                except Exception:
                    pass


def start_control_connection() -> None:
    """Mantiene una conexion de control persistente y saliente hacia el
    backend, para recibir pedidos de acceso remoto (START_TUNNEL) sin que el
    servidor tenga que abrir ningun puerto entrante -- la conexion siempre
    sale del agente, nunca entra. Corre en un thread propio con reconexion
    automatica con backoff; su caida no afecta el ciclo normal de telemetria.
    """
    if websocket is None:
        logger.warning(
            "El paquete websocket-client no está instalado: la función de acceso remoto queda deshabilitada "
            "(el monitoreo normal sigue funcionando sin problema)."
        )
        return

    control_url = f"{_ws_base_url()}/ws/agent-control"
    headers = [f"X-Server-Id: {SERVER_ID}", f"X-Api-Key: {API_KEY}"]
    state = {"backoff": 5}

    def on_open(_ws):
        state["backoff"] = 5
        logger.debug("Canal de control conectado al backend")

    def on_message(_ws, message):
        try:
            data = json.loads(message)
        except (TypeError, ValueError):
            return
        if data.get("type") == "START_TUNNEL":
            threading.Thread(
                target=handle_remote_tunnel,
                args=(data.get("sessionId"), int(data.get("targetPort", 3389))),
                daemon=True,
            ).start()

    while True:
        try:
            app = websocket.WebSocketApp(control_url, header=headers, on_open=on_open, on_message=on_message)
            app.run_forever(ping_interval=30, ping_timeout=10)
        except Exception as exc:
            logger.debug("Conexión de control interrumpida: %s", exc)

        time.sleep(state["backoff"])
        state["backoff"] = min(state["backoff"] * 2, 120)


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
    parser.add_argument(
        "--version",
        action="store_true",
        help="Imprime la version del agente y termina.",
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

    latest_version = send_telemetry(payload)
    check_and_apply_update(latest_version)

    global _last_backup_check
    now = time.monotonic()
    if now - _last_backup_check >= BACKUP_CHECK_INTERVAL_SECONDS:
        _last_backup_check = now
        backup_payload = build_backup_payload()

        # Siempre en INFO (no solo en --debug): al instalar en un servidor
        # nuevo, esta linea es la forma de confirmar que metodo de deteccion
        # de backup quedo activo (WMI de Windows Server Backup vs. el
        # fallback wbadmin) sin tener que correr el agente en modo debug.
        logger.info(
            "Estado de backup -> resultado=%s | metodo=%s | VSS activo=%s | ultimo backup=%s",
            backup_payload["result"],
            backup_payload["method"],
            backup_payload["vssServiceOk"],
            backup_payload.get("lastBackupAt", "N/D"),
        )
        if debug:
            logger.debug(
                "Detalle completo del backup:\n%s", json.dumps(backup_payload, indent=2, ensure_ascii=False)
            )
            if backup_payload.get("detail"):
                logger.debug("Detalle de backup:\n%s", backup_payload["detail"])

        send_backup_status(backup_payload)


def main() -> None:
    args = parse_args()

    if args.version:
        print(AGENT_VERSION)
        return

    if args.debug:
        logger.setLevel(logging.DEBUG)
        _console_handler.setLevel(logging.DEBUG)

    validate_config()
    _cleanup_previous_update()
    logger.info(
        "Agente Enterprise SOC iniciado (v%s). Backend=%s, intervalo=%ss, debug=%s, once=%s",
        AGENT_VERSION,
        BACKEND_URL,
        POLL_INTERVAL_SECONDS,
        args.debug,
        args.once,
    )

    if not args.once:
        threading.Thread(target=start_control_connection, daemon=True).start()

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
#    IMPORTANTE al publicar una version nueva: subi el .exe compilado a
#    backend/downloads/enterprise-soc-agent.exe Y actualiza el valor de
#    AGENT_LATEST_VERSION en Admin -> Configuracion con el mismo numero que
#    tiene la constante AGENT_VERSION de este archivo. Si no coinciden, los
#    agentes viejos nunca se enteran de que hay una version nueva (o peor,
#    quedan reintentando actualizarse a la misma version sin parar).
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
