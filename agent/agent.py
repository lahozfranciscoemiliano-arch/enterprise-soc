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
import ipaddress
import struct
import threading
import time
from concurrent.futures import ThreadPoolExecutor
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
AGENT_VERSION = "1.6.0"


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
# Diagnostico preventivo (discos, servicios, parches, Defender, eventos
# criticos): mas pesado que las metricas basicas, no hace falta cada minuto.
DIAGNOSTICS_INTERVAL_SECONDS = int(os.getenv("DIAGNOSTICS_INTERVAL_SECONDS", "300"))
# Destinos para medir internet desde ADENTRO del sitio (ICMP, sin depender
# del idioma de Windows ni de privilegios de administrador).
INTERNET_PROBE_HOSTS = [h.strip() for h in os.getenv("INTERNET_PROBE_HOSTS", "1.1.1.1,8.8.8.8").split(",") if h.strip()]
PUBLIC_IP_URLS = ("https://api.ipify.org", "https://ifconfig.me/ip", "https://icanhazip.com")
PUBLIC_IP_REFRESH_SECONDS = int(os.getenv("PUBLIC_IP_REFRESH_SECONDS", "300"))
# Inventario de red (PCs, usuarios del AD, impresoras, mapa de IPs). Lo hace
# el servidor que tiene los roles de AD/DHCP (BSFS2): "auto" lo activa solo
# si detecta esos roles; "true"/"false" lo fuerzan.
INVENTORY_ENABLED = os.getenv("INVENTORY_ENABLED", "auto").strip().lower()
INVENTORY_INTERVAL_SECONDS = int(os.getenv("INVENTORY_INTERVAL_SECONDS", "300"))
# Subredes adicionales a barrer que no tengan ambito DHCP (ej. la de
# servidores con IP fija): "192.168.110.0/24,10.0.5.0/24".
INVENTORY_EXTRA_SUBNETS = [x.strip() for x in os.getenv("INVENTORY_EXTRA_SUBNETS", "").split(",") if x.strip()]
SNMP_COMMUNITY = os.getenv("SNMP_COMMUNITY", "public")
INVENTORY_MAX_IPS = 4096

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


def windows_exe(name: str, *subdirs: str) -> str:
    """Ruta absoluta de una herramienta de Windows (powershell, route, arp,
    wbadmin). Como tarea programada con la cuenta SYSTEM el PATH puede venir
    recortado y llamarlas por nombre falla con "WinError 2". Si el agente
    corre en 32 bits sobre un Windows de 64, usa Sysnative para llegar a las
    versiones de 64 bits (los modulos de AD y DHCP solo existen ahi)."""
    if sys.platform != "win32":
        return name
    root = os.environ.get("SystemRoot", r"C:\Windows")
    for system_dir in ("Sysnative", "System32"):
        candidate = os.path.join(root, system_dir, *subdirs, name)
        if os.path.exists(candidate):
            return candidate
    return name


@dataclass
class NetSample:
    bytes_sent: int
    bytes_recv: int
    timestamp: float


_last_net_sample: NetSample | None = None
# -inf fuerza que la primera vuelta del loop siempre revise el backup,
# sin importar el intervalo configurado.
_last_backup_check: float = float("-inf")

# Que metodos de backup se leen en este equipo (el backend lo confirma en
# cada respuesta de /api/backup-status, configurable desde Admin):
#   MULTI    -> servidores ALOHA*: todos los metodos (scripts, SQL, etc.).
#   NATIVE   -> resto: solo Windows Server Backup / Copias de seguridad.
#   EXCLUDED -> no se lee nada (equipos sin backup que vigilar).
MULTI_METHOD_PREFIXES = tuple(
    p.strip().upper() for p in os.getenv("BACKUP_MULTI_METHOD_PREFIXES", "ALOHA,ALLOHA").split(",") if p.strip()
)
_backup_mode: str = (
    "MULTI" if os.getenv("COMPUTERNAME", socket_module.gethostname()).upper().startswith(MULTI_METHOD_PREFIXES) else "NATIVE"
)
BACKUP_EXCLUDED_RECHECK_SECONDS = 6 * 3600

# Diagnostico extendido: lo arma un hilo aparte (puede tardar: WMI, Visor de
# Eventos, Windows Update) y el loop de telemetria solo lo adjunta, asi un
# chequeo lento nunca atrasa el latido cada 60 s.
_diag_lock = threading.Lock()
_pending_diagnostics: dict[str, Any] | None = None
_diagnostics_threaded = False


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


# ---------------------------------------------------------------------------
# Red e internet del sitio
# ---------------------------------------------------------------------------

def icmp_ping(host: str, timeout_ms: int = 1000) -> float | None:
    """Un ping ICMP; devuelve el RTT en ms o None si no hubo respuesta.

    En Windows usa IcmpSendEcho (iphlpapi.dll) directamente: no necesita
    privilegios de administrador y, a diferencia de parsear la salida de
    ping.exe, no depende del idioma del sistema. Fuera de Windows (pruebas)
    cae a una conexion TCP al puerto 443.
    """
    try:
        address = socket_module.gethostbyname(host)
    except OSError:
        return None

    if sys.platform != "win32":
        start = time.perf_counter()
        try:
            with socket_module.create_connection((address, 443), timeout=timeout_ms / 1000):
                return round((time.perf_counter() - start) * 1000, 1)
        except OSError:
            return None

    from ctypes import wintypes

    class IP_OPTION_INFORMATION(ctypes.Structure):
        _fields_ = [("Ttl", ctypes.c_ubyte), ("Tos", ctypes.c_ubyte), ("Flags", ctypes.c_ubyte),
                    ("OptionsSize", ctypes.c_ubyte), ("OptionsData", ctypes.c_void_p)]

    class ICMP_ECHO_REPLY(ctypes.Structure):
        _fields_ = [("Address", wintypes.ULONG), ("Status", wintypes.ULONG), ("RoundTripTime", wintypes.ULONG),
                    ("DataSize", wintypes.USHORT), ("Reserved", wintypes.USHORT), ("Data", ctypes.c_void_p),
                    ("Options", IP_OPTION_INFORMATION)]

    iphlpapi = ctypes.windll.iphlpapi
    iphlpapi.IcmpCreateFile.restype = wintypes.HANDLE
    iphlpapi.IcmpSendEcho.argtypes = [wintypes.HANDLE, wintypes.ULONG, ctypes.c_void_p, wintypes.WORD,
                                      ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD]
    iphlpapi.IcmpCloseHandle.argtypes = [wintypes.HANDLE]

    handle = iphlpapi.IcmpCreateFile()
    if not handle or handle == wintypes.HANDLE(-1).value:
        return None
    try:
        payload = b"enterprise-soc"
        reply_size = ctypes.sizeof(ICMP_ECHO_REPLY) + len(payload) + 8
        reply = ctypes.create_string_buffer(reply_size)
        dest = int.from_bytes(socket_module.inet_aton(address), "little")
        count = iphlpapi.IcmpSendEcho(handle, dest, payload, len(payload), None, reply, reply_size, timeout_ms)
        if count == 0:
            return None
        echo = ICMP_ECHO_REPLY.from_buffer_copy(reply)
        if echo.Status != 0:  # IP_SUCCESS
            return None
        return float(echo.RoundTripTime)
    finally:
        iphlpapi.IcmpCloseHandle(handle)


def probe_host(host: str, attempts: int = 3) -> dict[str, Any]:
    rtts = [r for r in (icmp_ping(host) for _ in range(attempts)) if r is not None]
    return {
        "host": host,
        "lossPct": round(100 * (attempts - len(rtts)) / attempts, 1),
        "avgMs": round(sum(rtts) / len(rtts), 1) if rtts else None,
    }


_ROUTE_RE = re.compile(r"^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)\s+\S+\s+(\d+)", re.MULTILINE)


def get_default_gateway() -> str | None:
    """Gateway por defecto (router/Fortigate del sitio) desde 'route print':
    las columnas son numericas, asi que el parseo no depende del idioma."""
    if sys.platform != "win32":
        return None
    try:
        proc = subprocess.run([windows_exe("route.exe"), "print", "-4", "0.0.0.0"], capture_output=True, timeout=10)
    except Exception:
        return None
    routes = _ROUTE_RE.findall(_decode_console_bytes(proc.stdout or b""))
    if not routes:
        return None
    return min(routes, key=lambda r: int(r[1]))[0]  # menor metrica = ruta activa


_public_ip_cache: dict[str, Any] = {"ip": None, "at": float("-inf")}


def get_public_ip() -> str | None:
    """IP publica con la que sale el sitio a internet. Comparada contra las
    IPs de los dos ISP cargadas en el CMDB, le dice al backend por cual
    enlace esta saliendo (y si hubo failover al secundario)."""
    now = time.monotonic()
    if now - _public_ip_cache["at"] < PUBLIC_IP_REFRESH_SECONDS:
        return _public_ip_cache["ip"]
    ip = None
    for url in PUBLIC_IP_URLS:
        try:
            response = requests.get(url, timeout=5)
            candidate = response.text.strip()
            if response.ok and re.fullmatch(r"[0-9a-fA-F:.]{7,45}", candidate):
                ip = candidate
                break
        except requests.exceptions.RequestException:
            continue
    _public_ip_cache.update(ip=ip, at=now)
    return ip


_last_nic_counters: dict[str, Any] = {}


def collect_nic_status() -> list[dict[str, Any]]:
    """Placas de red activas: velocidad negociada y errores/descartes desde el
    ciclo anterior (un cable o puerto de switch en mal estado se ve aca
    antes de que se corte del todo)."""
    global _last_nic_counters
    nics: list[dict[str, Any]] = []
    try:
        stats = psutil.net_if_stats()
        counters = psutil.net_io_counters(pernic=True)
    except Exception:
        return nics
    for name, st in stats.items():
        if not st.isup or "loopback" in name.lower() or name.lower().startswith(("lo", "isatap", "teredo")):
            continue
        c = counters.get(name)
        prev = _last_nic_counters.get(name)
        errors = drops = None
        if c and prev:
            errors = max(0, (c.errin + c.errout) - (prev.errin + prev.errout))
            drops = max(0, (c.dropin + c.dropout) - (prev.dropin + prev.dropout))
        nics.append({"name": name, "speedMbps": st.speed or None, "errors": errors, "drops": drops})
    _last_nic_counters = counters
    return nics[:6]


def collect_network_status() -> dict[str, Any]:
    gateway = get_default_gateway()
    probes = [probe_host(h) for h in INTERNET_PROBE_HOSTS]
    reachable = [p for p in probes if p["avgMs"] is not None]

    dns_ms = None
    try:
        start = time.perf_counter()
        socket_module.getaddrinfo("www.microsoft.com", 443)
        dns_ms = round((time.perf_counter() - start) * 1000, 1)
    except OSError:
        pass

    internet_up = bool(reachable)
    return {
        "gateway": gateway,
        "gatewayProbe": probe_host(gateway) if gateway else None,
        "internetUp": internet_up,
        "internetLatencyMs": round(sum(p["avgMs"] for p in reachable) / len(reachable), 1) if reachable else None,
        "internetLossPct": round(sum(p["lossPct"] for p in probes) / len(probes), 1) if probes else None,
        "probes": probes,
        "dnsOk": dns_ms is not None,
        "dnsMs": dns_ms,
        "publicIp": get_public_ip() if internet_up else None,
        "nics": collect_nic_status(),
    }


# Cortes de internet vistos desde el sitio. Mientras el sitio esta sin
# internet el agente NO puede avisarle al backend (esta en la nube), asi que
# registra el corte localmente y lo reporta con su duracion cuando vuelve.
_outage_started_at: str | None = None
_pending_outages: list[dict[str, Any]] = []


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def track_outage(internet_up: bool) -> None:
    global _outage_started_at
    if not internet_up and _outage_started_at is None:
        _outage_started_at = _utc_now_iso()
        logger.warning("Sin salida a internet desde este sitio (inicio del corte: %s)", _outage_started_at)
    elif internet_up and _outage_started_at is not None:
        ended = _utc_now_iso()
        duration = int(_seconds_between(_outage_started_at, ended))
        _pending_outages.append({"startedAt": _outage_started_at, "endedAt": ended, "durationSeconds": duration})
        logger.warning("Internet restablecido tras %s s sin conexion", duration)
        _outage_started_at = None
        del _pending_outages[:-20]


# ---------------------------------------------------------------------------
# Diagnostico preventivo
# ---------------------------------------------------------------------------

def collect_volumes() -> list[dict[str, Any]]:
    volumes = []
    for part in psutil.disk_partitions(all=False):
        if sys.platform == "win32" and ("cdrom" in part.opts or not part.fstype):
            continue
        try:
            usage = psutil.disk_usage(part.mountpoint)
        except (PermissionError, OSError):
            continue
        volumes.append(
            {
                "mount": part.mountpoint.rstrip("\\") or part.mountpoint,
                "fs": part.fstype,
                "totalBytes": usage.total,
                "freeBytes": usage.free,
                "percent": round(usage.percent, 1),
            }
        )
    return volumes


def _wmi_query(namespace: str, query: str) -> list[Any]:
    if win32com is None:
        return []
    try:
        service = win32com.client.GetObject(f"winmgmts:\\\\.\\{namespace}")
        return list(service.ExecQuery(query))
    except Exception:
        return []


def _safe_attr(obj: Any, name: str) -> Any:
    try:
        return getattr(obj, name)
    except Exception:
        return None


PHYSICAL_DISK_HEALTH = {0: "Healthy", 1: "Warning", 2: "Unhealthy", 5: "Unknown"}
MEDIA_TYPES = {3: "HDD", 4: "SSD", 5: "SCM"}


def collect_physical_disks() -> list[dict[str, Any]]:
    """Salud fisica de los discos (Storage Management API + prediccion SMART):
    un disco en "Warning" o con prediccion de falla se reemplaza ANTES de
    perder datos."""
    disks = []
    for d in _wmi_query(r"root\Microsoft\Windows\Storage", "SELECT FriendlyName, MediaType, HealthStatus, Size FROM MSFT_PhysicalDisk"):
        disks.append(
            {
                "name": str(_safe_attr(d, "FriendlyName") or "Disco"),
                "mediaType": MEDIA_TYPES.get(_safe_attr(d, "MediaType"), "Desconocido"),
                "health": PHYSICAL_DISK_HEALTH.get(_safe_attr(d, "HealthStatus"), "Unknown"),
                "sizeBytes": int(_safe_attr(d, "Size") or 0) or None,
                "predictFailure": False,
            }
        )
    predicted = [bool(_safe_attr(p, "PredictFailure")) for p in _wmi_query(r"root\wmi", "SELECT PredictFailure FROM MSStorageDriver_FailurePredictStatus")]
    if any(predicted):
        if disks:
            for disk, flag in zip(disks, predicted):
                disk["predictFailure"] = disk["predictFailure"] or flag
        else:
            disks = [{"name": f"Disco {i}", "mediaType": "Desconocido", "health": "Unknown", "sizeBytes": None, "predictFailure": f} for i, f in enumerate(predicted)]
    return disks


def check_reboot_pending() -> bool:
    try:
        import winreg
    except ImportError:
        return False
    keys = [
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending",
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired",
    ]
    for key in keys:
        try:
            winreg.CloseKey(winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, key))
            return True
        except OSError:
            continue
    try:
        k = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager")
        value, _ = winreg.QueryValueEx(k, "PendingFileRenameOperations")
        winreg.CloseKey(k)
        return bool(value)
    except OSError:
        return False


def _com_date_to_iso(value: Any) -> str | None:
    try:
        return datetime(value.year, value.month, value.day, value.hour, value.minute, tzinfo=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000000Z")
    except Exception:
        return None


# La busqueda de actualizaciones pendientes contra Windows Update puede tardar
# minutos: corre en un hilo aparte cada 12 hs y el diagnostico usa el ultimo
# resultado disponible.
_updates_cache: dict[str, Any] = {"pending": None, "checkedAt": None, "running": False, "lastRun": float("-inf")}


def _search_pending_updates() -> None:
    try:
        import pythoncom
        pythoncom.CoInitialize()
        session = win32com.client.Dispatch("Microsoft.Update.Session")
        result = session.CreateUpdateSearcher().Search("IsInstalled=0 and Type='Software' and IsHidden=0")
        critical = 0
        for i in range(result.Updates.Count):
            severity = str(_safe_attr(result.Updates.Item(i), "MsrcSeverity") or "")
            if severity in ("Critical", "Important"):
                critical += 1
        _updates_cache.update(pending=result.Updates.Count, pendingCritical=critical, checkedAt=_utc_now_iso())
    except Exception as exc:
        logger.info("No se pudo consultar Windows Update: %s", exc)
    finally:
        _updates_cache["running"] = False


def collect_update_status() -> dict[str, Any]:
    status: dict[str, Any] = {"lastInstalledAt": None}
    if win32com is None:
        return status
    try:
        session = win32com.client.Dispatch("Microsoft.Update.Session")
        searcher = session.CreateUpdateSearcher()
        total = searcher.GetTotalHistoryCount()
        if total:
            history = searcher.QueryHistory(0, min(total, 50))
            dates = [
                _com_date_to_iso(history.Item(i).Date)
                for i in range(history.Count)
                if _safe_attr(history.Item(i), "ResultCode") in (2, 3)  # Succeeded / SucceededWithErrors
            ]
            dates = [d for d in dates if d]
            status["lastInstalledAt"] = max(dates) if dates else None
    except Exception as exc:
        logger.debug("No se pudo leer el historial de Windows Update: %s", exc)

    now = time.monotonic()
    if not _updates_cache["running"] and now - _updates_cache["lastRun"] > 12 * 3600:
        _updates_cache.update(running=True, lastRun=now)
        threading.Thread(target=_search_pending_updates, daemon=True).start()
    status["pending"] = _updates_cache.get("pending")
    status["pendingCritical"] = _updates_cache.get("pendingCritical")
    status["pendingCheckedAt"] = _updates_cache.get("checkedAt")
    return status


# Servicios automaticos que es NORMAL encontrar detenidos (arranque por
# disparador o que terminan solos): no son una señal de problema.
BENIGN_STOPPED_SERVICES = {
    "gupdate", "gupdatem", "edgeupdate", "edgeupdatem", "sppsvc", "remoteregistry", "mapsbroker",
    "tiledatamodelsvc", "wbiosrvc", "clr_optimization_v4.0.30319_32", "clr_optimization_v4.0.30319_64",
    "sysmain", "usosvc", "wuauserv", "bits", "cdpsvc", "onesyncsvc", "wlidsvc", "ngcsvc", "ngcctnrsvc",
    "tabletinputservice", "shellhwdetection", "stisvc", "dosvc", "waasmedicsvc", "trustedinstaller",
    "googleupdaterservice", "googleupdaterinternalservice", "intelaudioservice", "wpnservice",
}


def collect_stopped_services() -> list[dict[str, str]]:
    stopped = []
    if not hasattr(psutil, "win_service_iter"):
        return stopped
    try:
        for svc in psutil.win_service_iter():
            try:
                info = svc.as_dict()
            except Exception:
                continue
            name = info.get("name") or ""
            if info.get("start_type") != "automatic" or info.get("status") == "running":
                continue
            if name.lower() in BENIGN_STOPPED_SERVICES or "_" in name and name.split("_")[0].lower() in ("cdpusersvc", "onesyncsvc", "wpnuserservice"):
                continue
            stopped.append({"name": name, "displayName": info.get("display_name") or name})
    except Exception as exc:
        logger.debug("No se pudo listar servicios: %s", exc)
    return stopped[:40]


def collect_defender_status() -> dict[str, Any] | None:
    items = _wmi_query(
        r"root\Microsoft\Windows\Defender",
        "SELECT AntivirusEnabled, RealTimeProtectionEnabled, AntivirusSignatureAge, QuickScanAge FROM MSFT_MpComputerStatus",
    )
    if not items:
        return None
    d = items[0]
    return {
        "antivirusEnabled": bool(_safe_attr(d, "AntivirusEnabled")),
        "realTimeEnabled": bool(_safe_attr(d, "RealTimeProtectionEnabled")),
        "signatureAgeDays": _safe_attr(d, "AntivirusSignatureAge"),
        "quickScanAgeDays": _safe_attr(d, "QuickScanAge"),
    }


# Señales tempranas en el Visor de Eventos (ultimas 24 hs). Cada una suele
# aparecer dias o semanas antes de la falla "grande":
EVENT_SIGNALS = {
    # Reintentos/reseteos de E/S de disco (solo informativo, NO alerta): los
    # generan tambien discos USB de backup que se desconectan, lectores de
    # tarjetas, discos que se duermen o un AHCI con drivers viejos. Antes se
    # sumaban a los sectores defectuosos y daban avisos falsos en casi todos
    # los servidores. Ya no se cuentan los eventos informativos (Ntfs 98 =
    # "volumen verificado") ni las extracciones sorpresivas (157) ni "no
    # listo" (15).
    "diskErrors": ("System", "*[System[Provider[@Name='disk' or @Name='storahci' or @Name='stornvme'] and (EventID=11 or EventID=51 or EventID=129 or EventID=153) and TimeCreated[timediff(@SystemTime) <= 86400000]]]"),
    # Apagados no esperados (corte de luz, cuelgue, UPS).
    "unexpectedShutdowns": ("System", "*[System[(EventID=41 or EventID=6008) and TimeCreated[timediff(@SystemTime) <= 86400000]]]"),
    # Pantallazos azules.
    "bugchecks": ("System", "*[System[EventID=1001 and Provider[@Name='Microsoft-Windows-WER-SystemErrorReporting'] and TimeCreated[timediff(@SystemTime) <= 86400000]]]"),
    # Windows detecto memoria virtual agotada.
    "lowMemory": ("System", "*[System[EventID=2004 and TimeCreated[timediff(@SystemTime) <= 86400000]]]"),
    # Inicios de sesion fallidos (fuerza bruta RDP, credenciales viejas).
    "failedLogons": ("Security", "*[System[EventID=4625 and TimeCreated[timediff(@SystemTime) <= 86400000]]]"),
    # Malware detectado por Microsoft Defender.
    "malwareDetections": ("Microsoft-Windows-Windows Defender/Operational", "*[System[(EventID=1116 or EventID=1117) and TimeCreated[timediff(@SystemTime) <= 86400000]]]"),
}


# Señal REAL de disco fallando: sector defectuoso (disk 7), falla predicha
# por el propio disco (disk 52) o estructura NTFS corrupta (Ntfs 55). Se
# descartan los discos USB / extraibles (backups externos, pendrives), que
# no son el disco del servidor.
DISK_BAD_BLOCK_XPATH = (
    "*[System[Provider[@Name='disk' or @Name='Ntfs' or @Name='Microsoft-Windows-Ntfs'] "
    "and (EventID=7 or EventID=52 or EventID=55) and TimeCreated[timediff(@SystemTime) <= 86400000]]]"
)
_HARDDISK_RE = re.compile(r"Harddisk(\d+)", re.IGNORECASE)


def _removable_disk_indexes() -> set[int]:
    indexes: set[int] = set()
    for d in _wmi_query(r"root\cimv2", "SELECT Index, InterfaceType, MediaType FROM Win32_DiskDrive"):
        iface = str(_safe_attr(d, "InterfaceType") or "").upper()
        media = str(_safe_attr(d, "MediaType") or "").lower()
        if iface in ("USB", "1394") or "removable" in media or "external" in media:
            try:
                indexes.add(int(_safe_attr(d, "Index")))
            except (TypeError, ValueError):
                continue
    return indexes


def count_disk_bad_blocks() -> int:
    events = _evt_query("System", DISK_BAD_BLOCK_XPATH, max_events=500)
    if not events:
        return 0
    removable = _removable_disk_indexes()
    count = 0
    for xml in events:
        match = _HARDDISK_RE.search(xml)
        if match and int(match.group(1)) in removable:
            continue
        count += 1
    return count


def collect_event_signals() -> dict[str, int]:
    signals = {key: len(_evt_query(channel, xpath, max_events=500)) for key, (channel, xpath) in EVENT_SIGNALS.items()}
    try:
        signals["diskBadBlocks"] = count_disk_bad_blocks()
    except Exception as exc:
        logger.debug("No se pudieron contar los sectores defectuosos: %s", exc)
    return signals


def collect_top_processes(limit: int = 5) -> dict[str, list[dict[str, Any]]]:
    procs = []
    for p in psutil.process_iter(["name", "memory_info"]):
        try:
            cpu = p.cpu_percent(None)  # desde la llamada anterior (process_iter cachea los objetos)
            mem = p.info["memory_info"].rss if p.info.get("memory_info") else 0
            procs.append({"name": p.info.get("name") or "?", "cpu": round(cpu / max(psutil.cpu_count() or 1, 1), 1), "memBytes": mem})
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    procs = [p for p in procs if p["name"].lower() not in ("system idle process", "idle")]
    return {
        "byCpu": sorted(procs, key=lambda p: p["cpu"], reverse=True)[:limit],
        "byMemory": sorted(procs, key=lambda p: p["memBytes"], reverse=True)[:limit],
    }


def collect_diagnostics() -> dict[str, Any]:
    """Todo lo que permite anticiparse a una falla. Cada bloque es
    independiente y best-effort: si uno falla (WMI roto, sin permisos), el
    resto se manda igual."""
    boot = psutil.boot_time()
    swap = psutil.swap_memory()
    diagnostics: dict[str, Any] = {
        "collectedAt": _utc_now_iso(),
        "uptimeSeconds": int(time.time() - boot),
        "lastBootAt": datetime.fromtimestamp(boot, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000000Z"),
        "os": f"{os.getenv('OS', '')} {sys.getwindowsversion().build if sys.platform == 'win32' else ''}".strip(),
        "cpuCount": psutil.cpu_count(),
        "memoryTotalBytes": psutil.virtual_memory().total,
        "pagefilePercent": round(swap.percent, 1),
    }
    collectors = {
        "volumes": collect_volumes,
        "physicalDisks": collect_physical_disks,
        "rebootPending": check_reboot_pending,
        "updates": collect_update_status,
        "stoppedServices": collect_stopped_services,
        "defender": collect_defender_status,
        "eventSignals": collect_event_signals,
        "topProcesses": collect_top_processes,
    }
    for key, fn in collectors.items():
        try:
            diagnostics[key] = fn()
        except Exception as exc:
            logger.warning("Diagnostico '%s' fallo: %s", key, exc)
    return diagnostics


_last_diagnostics_at: float = float("-inf")


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
    """True si el servicio de Volume Shadow Copy (VSS) puede usarse.

    Casi cualquier mecanismo de backup nativo de Windows (Server Backup,
    Backup and Restore, VSS-aware de terceros) depende de este servicio.
    VSS es de inicio MANUAL: Windows lo arranca cuando un backup lo pide y lo
    detiene solo a los pocos minutos de estar ocioso, asi que "detenido" es
    su estado normal. Solo es un problema si esta DESHABILITADO (ahi el
    backup falla).
    """
    if win32serviceutil is None or win32service is None:
        return False

    try:
        status = win32serviceutil.QueryServiceStatus("VSS")
        if status[1] == win32service.SERVICE_RUNNING:
            return True
        scm = win32service.OpenSCManager(None, None, win32service.SC_MANAGER_CONNECT)
        try:
            svc = win32service.OpenService(scm, "VSS", win32service.SERVICE_QUERY_CONFIG)
            try:
                start_type = win32service.QueryServiceConfig(svc)[1]
            finally:
                win32service.CloseServiceHandle(svc)
        finally:
            win32service.CloseServiceHandle(scm)
        return start_type != win32service.SERVICE_DISABLED
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
    target_path = safe_get("LastBackupTargetPath")

    if last_result_hr is None and last_backup_time is None and last_successful_time is None:
        return None

    result = "SUCCESS" if last_result_hr in (0, None) else "FAILED"

    status: dict[str, Any] = {
        "result": result,
        "method": "WINDOWS_SERVER_BACKUP",
        "lastBackupAt": _wmi_datetime_to_iso(last_backup_time) or _wmi_datetime_to_iso(last_successful_time),
        "detail": f"LastBackupResultHR={last_result_hr}",
    }
    if target_path:
        status["targetPath"] = str(target_path)
    return status


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
            [windows_exe("wbadmin.exe"), "get", "versions"],
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

    status: dict[str, Any] = {
        "result": "SUCCESS",
        "method": "WBADMIN",
        "detail": output[-600:],
    }
    versions = _parse_wbadmin_versions(output)
    if versions:
        # Sin esto, cada chequeo llegaba al backend sin fecha y no habia forma
        # de distinguir "el backup de anoche" del "de hace una semana".
        status["lastBackupAt"] = versions[0]
        status["versions"] = versions
    target = _extract_target_path(output)
    if target:
        status["targetPath"] = target
    return status


_WBADMIN_VERSION_RE = re.compile(r"\b(\d{2})/(\d{2})/(\d{4})-(\d{2}):(\d{2})\b")


def _parse_wbadmin_versions(output: str) -> list[str]:
    """Fechas de los backups listados por 'wbadmin get versions', mas nuevos
    primero, en ISO-8601 UTC.

    El "identificador de version" de wbadmin tiene SIEMPRE el formato
    MM/DD/YYYY-HH:MM en UTC, sin importar el idioma ni la configuracion
    regional de Windows (es el valor que se le pasa a 'wbadmin start
    recovery -version:'), asi que se puede parsear sin depender del idioma.
    """
    found: set[str] = set()
    for month, day, year, hour, minute in _WBADMIN_VERSION_RE.findall(output):
        try:
            dt = datetime(int(year), int(month), int(day), int(hour), int(minute), tzinfo=timezone.utc)
        except ValueError:
            continue
        found.add(dt.strftime("%Y-%m-%dT%H:%M:00.000000Z"))
    return sorted(found, reverse=True)[:60]


# Canal "Microsoft-Windows-Backup" del Visor de Eventos: lo escribe Windows
# Server Backup (y wbadmin) en cada corrida. Es la unica fuente que da la
# DURACION real de cada backup (inicio -> fin) y tambien las corridas que
# fallaron, que ni wbadmin ni el WMI listan.
BACKUP_EVENT_START = {1}
BACKUP_EVENT_SUCCESS = {4}
BACKUP_EVENT_FAILURE = {5, 8, 9, 17, 18, 19, 20, 21, 22, 49, 50, 52, 100, 517, 518, 521, 527, 528, 544, 545, 546, 561, 564, 612}
_EVT_ID_RE = re.compile(r"<EventID[^>]*>(\d+)</EventID>")
_EVT_TIME_RE = re.compile(r"<TimeCreated SystemTime=['\"]([^'\"]+)['\"]")


def _evt_query(channel: str, xpath: str, max_events: int = 500) -> list[str]:
    """Devuelve el XML de los eventos de un canal (API moderna EvtQuery, que a
    diferencia de OpenEventLog tambien lee canales "Applications and Services
    Logs" como Microsoft-Windows-Backup), mas nuevos primero."""
    if win32evtlog is None:
        return []
    results: list[str] = []
    try:
        handle = win32evtlog.EvtQuery(
            channel, win32evtlog.EvtQueryChannelPath | win32evtlog.EvtQueryReverseDirection, xpath
        )
    except Exception:
        return []  # canal inexistente (caracteristica no instalada) o sin permisos
    while len(results) < max_events:
        try:
            batch = win32evtlog.EvtNext(handle, 100)
        except Exception:
            break
        if not batch:
            break
        for event in batch:
            try:
                results.append(win32evtlog.EvtRender(event, win32evtlog.EvtRenderEventXml))
            except Exception:
                continue
    return results[:max_events]


def _evt_time_iso(xml: str) -> str | None:
    match = _EVT_TIME_RE.search(xml)
    if not match:
        return None
    raw = match.group(1)
    # "2026-09-25T03:00:01.1234567Z" -> precision de microsegundos
    try:
        base, _, frac = raw.rstrip("Z").partition(".")
        dt = datetime.strptime(base, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
        micro = int((frac + "000000")[:6]) if frac else 0
        return dt.replace(microsecond=micro).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    except ValueError:
        return None


def _seconds_between(start_iso: str, end_iso: str) -> float:
    fmt = "%Y-%m-%dT%H:%M:%S.%fZ"
    return (datetime.strptime(end_iso, fmt) - datetime.strptime(start_iso, fmt)).total_seconds()


def read_backup_runs(max_runs: int = 30) -> list[dict[str, Any]]:
    """Corridas de backup reconstruidas desde el Visor de Eventos, mas nuevas
    primero: [{startedAt, finishedAt, durationSeconds, result, eventId}]."""
    ids = sorted(BACKUP_EVENT_START | BACKUP_EVENT_SUCCESS | BACKUP_EVENT_FAILURE)
    xpath = "*[System[(" + " or ".join(f"EventID={i}" for i in ids) + ")]]"
    events: list[tuple[str, int]] = []
    for xml in _evt_query("Microsoft-Windows-Backup", xpath, max_events=max_runs * 4):
        id_match = _EVT_ID_RE.search(xml)
        when = _evt_time_iso(xml)
        if id_match and when:
            events.append((when, int(id_match.group(1))))
    events.sort()  # cronologico para emparejar inicio -> fin

    runs: list[dict[str, Any]] = []
    started_at: str | None = None
    for when, event_id in events:
        if event_id in BACKUP_EVENT_START:
            started_at = when
            continue
        result = "SUCCESS" if event_id in BACKUP_EVENT_SUCCESS else "FAILED"
        # Una corrida fallida puede escribir varios eventos de error seguidos:
        # solo el primero cierra la corrida.
        if (
            started_at is None
            and result == "FAILED"
            and runs
            and runs[-1]["result"] == "FAILED"
            and _seconds_between(runs[-1]["finishedAt"], when) < 900
        ):
            continue
        duration = None
        if started_at:
            duration = int(_seconds_between(started_at, when))
            if duration < 0 or duration > 2 * 24 * 3600:
                duration = None
        runs.append(
            {
                "startedAt": started_at,
                "finishedAt": when,
                "durationSeconds": duration,
                "result": result,
                "eventId": event_id,
            }
        )
        started_at = None

    runs.reverse()
    return runs[:max_runs]


def _extract_target_path(output: str) -> str | None:
    """Busca una ruta de Windows (UNC o de unidad) en la salida de wbadmin.

    La etiqueta "Backup target:" esta en el idioma del sistema (no se puede
    buscar por texto), pero la ruta en si sigue la sintaxis estandar de
    Windows sin importar el idioma -- un patron agnostico al idioma, igual
    que el heuristico de fechas de arriba.
    """
    match = re.search(r"\\\\[^\s\\]+(?:\\[^\s\\]+)+|[A-Za-z]:\\[^\s]*", output)
    return match.group(0).rstrip(".,;") if match else None


def estimate_backup_size(target_path: str) -> int | None:
    """Suma el tamano de los archivos en target_path (ruta local o UNC del
    backup) como aproximacion honesta al tamano real del backup -- ni
    wbadmin ni el WMI de Windows Server Backup exponen ese dato
    directamente. Best-effort: cualquier problema de acceso (ruta de red
    caida, permisos, timeout) devuelve None en vez de fallar el ciclo
    entero de reporte de backup.

    Limitado a MAX_FILES / MAX_SECONDS para no colgarse escaneando un
    recurso de red lento o con demasiados archivos.
    """
    MAX_FILES = 20_000
    MAX_SECONDS = 25
    start = time.monotonic()
    total = 0
    scanned = 0

    try:
        for root, _dirs, files in os.walk(target_path, onerror=lambda _e: None):
            for name in files:
                scanned += 1
                if scanned > MAX_FILES or (time.monotonic() - start) > MAX_SECONDS:
                    return total or None
                try:
                    total += os.path.getsize(os.path.join(root, name))
                except OSError:
                    continue
    except Exception:
        return None

    return total or None


# ---------------------------------------------------------------------------
# Deteccion de TODOS los metodos de backup del equipo (no solo Windows Server
# Backup): tareas programadas con scripts (robocopy/xcopy/7-Zip/bat/ps1, con
# lectura de sus logs), Historial de archivos, SQL Server, y software de
# terceros (Veeam, Acronis, Cobian, Macrium...). Pensado para las PCs de caja
# (ALOHA) que no son Windows Server y resguardan con un script o con el
# "Historial de archivos".
# ---------------------------------------------------------------------------

BACKUP_TASK_PATTERN = (
    r"backup|respaldo|resguardo|copia|robocopy|xcopy|wbadmin|7z|7-zip|winrar|\brar\b|\.zip|compress-archive|"
    r"sqlcmd|\.bak\b|cobian|veeam|acronis|macrium|syncback|freefilesync|goodsync|bvckup|aloha"
)
BACKUP_TASK_EXCLUDE = r"enterprisesoc|googleupdate|microsoftedgeupdate|onedrive|adobe|mozilla|office"

PS_BACKUP_TASKS = r"""
function Iso($d) { if ($d -and $d.Year -gt 2001) { $d.ToUniversalTime().ToString('o') } else { $null } }
$pat = '__PATTERN__'
$exc = '__EXCLUDE__'
$out = @(Get-ScheduledTask | Where-Object { $_.TaskPath -notlike '\Microsoft\*' } | ForEach-Object {
  $t = $_
  $acts = @($t.Actions | Where-Object { $_.Execute } | ForEach-Object { [pscustomobject]@{ execute = [Environment]::ExpandEnvironmentVariables($_.Execute); arguments = $_.Arguments; workingDirectory = $_.WorkingDirectory } })
  $text = ($t.TaskName + ' ' + (($acts | ForEach-Object { $_.execute + ' ' + $_.arguments }) -join ' '))
  if ($text -match $pat -and $t.TaskName -notmatch $exc) {
    $i = $t | Get-ScheduledTaskInfo
    [pscustomobject]@{ name = $t.TaskName; path = $t.TaskPath; state = "$($t.State)"; enabled = [bool]$t.Settings.Enabled
      actions = $acts; lastRun = (Iso $i.LastRunTime); lastResult = [int64]$i.LastTaskResult; nextRun = (Iso $i.NextRunTime); missedRuns = [int]$i.NumberOfMissedRuns
      user = $t.Principal.UserId }
  }
})
ConvertTo-Json -InputObject $out -Depth 5 -Compress
"""

PS_SQL_BACKUPS = r"""
$res = @()
foreach ($inst in @(__INSTANCES__)) {
  $server = if ($inst -eq 'MSSQLSERVER') { '.' } else { ".\$inst" }
  try {
    $cn = New-Object System.Data.SqlClient.SqlConnection("Server=$server;Integrated Security=SSPI;Connect Timeout=5;Application Name=EnterpriseSOC")
    $cn.Open()
    $cmd = $cn.CreateCommand()
    $cmd.CommandTimeout = 20
    $cmd.CommandText = "SELECT d.name, d.recovery_model_desc, MAX(CASE WHEN b.type='D' THEN b.backup_finish_date END), MAX(CASE WHEN b.type='I' THEN b.backup_finish_date END), MAX(CASE WHEN b.type='L' THEN b.backup_finish_date END), MAX(CASE WHEN b.type='D' THEN b.backup_size END), MAX(b.backup_finish_date) FROM sys.databases d LEFT JOIN msdb.dbo.backupset b ON b.database_name = d.name WHERE d.name <> 'tempdb' AND d.state = 0 GROUP BY d.name, d.recovery_model_desc"
    $r = $cmd.ExecuteReader()
    $dbs = @()
    while ($r.Read()) {
      $f = { param($i) if ($r.IsDBNull($i)) { $null } else { $r.GetDateTime($i).ToUniversalTime().ToString('o') } }
      $dbs += [pscustomobject]@{ name = $r.GetString(0); recovery = $r.GetString(1); lastFull = (& $f 2); lastDiff = (& $f 3); lastLog = (& $f 4); fullSize = $(if ($r.IsDBNull(5)) { $null } else { [double]$r.GetDecimal(5) }) }
    }
    $cn.Close()
    $res += [pscustomobject]@{ instance = $inst; databases = $dbs; error = $null }
  } catch { $res += [pscustomobject]@{ instance = $inst; databases = @(); error = $_.Exception.Message } }
}
ConvertTo-Json -InputObject $res -Depth 5 -Compress
"""

THIRD_PARTY_BACKUP = {
    "veeam": "Veeam Agent", "acronis": "Acronis", "macrium": "Macrium Reflect", "reflect": "Macrium Reflect",
    "cobian": "Cobian Backup", "easeus": "EaseUS Todo Backup", "aomei": "AOMEI Backupper", "iperius": "Iperius Backup",
    "duplicati": "Duplicati", "urbackup": "UrBackup", "backupexec": "Veritas Backup Exec", "arcserve": "Arcserve",
    "carbonite": "Carbonite", "crashplan": "CrashPlan", "altaro": "Altaro", "nakivo": "NAKIVO", "bvckup": "Bvckup 2",
    "syncback": "SyncBack", "goodsync": "GoodSync", "freefilesync": "FreeFileSync",
}

ARCHIVE_EXTS = (".7z", ".zip", ".rar", ".bak", ".vhd", ".vhdx", ".tib", ".tibx", ".mrimg", ".tar", ".gz", ".vbk", ".vib", ".adi")
STALE_HOURS = 48

_ARG = r'("[^"]+"|\S+)'
_RE_ROBOCOPY = re.compile(r"robocopy(?:\.exe)?\"?\s+" + _ARG + r"\s+" + _ARG + r"([^\r\n]*)", re.IGNORECASE)
_RE_XCOPY = re.compile(r"\b(?:xcopy|copy)(?:\.exe)?\s+(?:/\S+\s+)*" + _ARG + r"\s+" + _ARG, re.IGNORECASE)
_RE_7Z = re.compile(r"(?:7z|7za|7zg|rar|winrar)(?:\.exe)?\"?\s+a\s+(?:-\S+\s+)*" + _ARG, re.IGNORECASE)
_RE_SQL_DISK = re.compile(r"TO\s+DISK\s*=\s*N?'([^']+)'", re.IGNORECASE)
_RE_WBADMIN_TARGET = re.compile(r"-backupTarget:" + _ARG, re.IGNORECASE)
_RE_PS_DEST = re.compile(r"-Destination(?:Path)?\s+" + _ARG, re.IGNORECASE)
_RE_LOG = re.compile(r"/(?:UNI)?LOG\+?:" + _ARG, re.IGNORECASE)
_RE_SCRIPT = re.compile(r"(\"[^\"]+\.(?:bat|cmd|ps1|vbs)\"|[^\s\"]+\.(?:bat|cmd|ps1|vbs))", re.IGNORECASE)
_RE_RC_SUMMARY = re.compile(
    r"^\s*[^:\r\n]{1,25}:\s+([\d.,]+\s?[kmgt]?)\s+([\d.,]+\s?[kmgt]?)\s+([\d.,]+\s?[kmgt]?)\s+([\d.,]+\s?[kmgt]?)\s+([\d.,]+\s?[kmgt]?)\s+([\d.,]+\s?[kmgt]?)\s*$",
    re.IGNORECASE | re.MULTILINE,
)


def _unquote(v: str) -> str:
    return v.strip().strip('"').strip()


def _read_text_file(path: str, limit: int = 200_000) -> str:
    try:
        with open(path, "rb") as f:
            data = f.read(limit)
        return _decode_console_bytes(data)
    except OSError:
        return ""


def _read_tail(path: str, limit: int = 24_000) -> str:
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - limit))
            return _decode_console_bytes(f.read())
    except OSError:
        return ""


def _file_mtime_iso(path: str) -> str | None:
    try:
        return datetime.fromtimestamp(os.path.getmtime(path), timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000000Z")
    except OSError:
        return None


def _hours_since(iso: str | None) -> float | None:
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - dt).total_seconds() / 3600
    except ValueError:
        return None


def parse_robocopy_log(path: str) -> dict[str, Any] | None:
    """Resumen de la ultima corrida de robocopy desde su log (/LOG:). Las
    etiquetas del resumen dependen del idioma, pero las 6 columnas numericas
    (Total, Copiados, Omitidos, No coinciden, ERROR, Extras) no."""
    tail = _read_tail(path)
    if not tail:
        return None
    rows = _RE_RC_SUMMARY.findall(tail)
    if len(rows) < 3:
        return None
    dirs, files, size = rows[-3], rows[-2], rows[-1]

    def n(v: str) -> int:
        digits = re.sub(r"[^\d]", "", v)
        return int(digits) if digits else 0

    return {
        "logPath": path,
        "finishedAt": _file_mtime_iso(path),
        "filesTotal": n(files[0]),
        "filesCopied": n(files[1]),
        "filesSkipped": n(files[2]),
        "filesFailed": n(files[4]),
        "dirsFailed": n(dirs[4]),
        "bytesTotal": size[0].strip(),
        "bytesCopied": size[1].strip(),
        "errorLines": len(re.findall(r"\bERROR\b\s+\d+\s+\(0x", tail)),
    }


def latest_archive_in(directory: str) -> dict[str, Any] | None:
    """Ultimo archivo de backup (.7z/.zip/.bak/...) en la carpeta destino (o
    una subcarpeta): su fecha es la del ultimo backup y su tamano el real."""
    best = None
    try:
        for root, dirs, files in os.walk(directory):
            for name in files:
                if name.lower().endswith(ARCHIVE_EXTS):
                    full = os.path.join(root, name)
                    try:
                        st = os.stat(full)
                    except OSError:
                        continue
                    if best is None or st.st_mtime > best[1]:
                        best = (full, st.st_mtime, st.st_size)
            if root.count(os.sep) - directory.count(os.sep) >= 1:
                dirs[:] = []
    except OSError:
        return None
    if not best:
        return None
    return {
        "file": best[0],
        "modifiedAt": datetime.fromtimestamp(best[1], timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000000Z"),
        "sizeBytes": best[2],
    }


def _analyze_commands(text: str, base_dir: str | None) -> dict[str, Any]:
    """Destinos, logs y herramientas usadas en los comandos de una tarea/script."""
    info: dict[str, Any] = {"tools": [], "targets": [], "logs": []}

    def add(key: str, value: str) -> None:
        value = _unquote(value)
        if value and value not in info[key]:
            info[key].append(value)

    for m in _RE_ROBOCOPY.finditer(text):
        add("tools", "robocopy")
        add("targets", m.group(2))
        for lm in _RE_LOG.finditer(m.group(3)):
            add("logs", lm.group(1))
    for m in _RE_XCOPY.finditer(text):
        add("tools", "xcopy")
        add("targets", m.group(2))
    for m in _RE_7Z.finditer(text):
        add("tools", "7-Zip/RAR")
        add("targets", os.path.dirname(_unquote(m.group(1))) or _unquote(m.group(1)))
    for m in _RE_SQL_DISK.finditer(text):
        add("tools", "SQL BACKUP")
        add("targets", os.path.dirname(m.group(1)))
    for m in _RE_WBADMIN_TARGET.finditer(text):
        add("tools", "wbadmin")
        add("targets", m.group(1))
    for m in _RE_PS_DEST.finditer(text):
        add("tools", "PowerShell")
        add("targets", m.group(1))
    for lm in _RE_LOG.finditer(text):
        add("logs", lm.group(1))

    if base_dir:
        info["logs"] = [l if os.path.isabs(l) else os.path.join(base_dir, l) for l in info["logs"]]
    return info


def _task_result(exit_code: int, uses_robocopy_directly: bool) -> tuple[str, str]:
    code = exit_code & 0xFFFFFFFF
    if code == 0x41301:
        return "RUNNING", "en ejecución ahora"
    if code == 0x41303:
        return "WARNING", "la tarea nunca se ejecutó"
    if code in (0x41306, 0x800710E0):
        return "WARNING", f"Windows no la ejecutó (código 0x{code:X}: condiciones/equipo apagado)"
    if uses_robocopy_directly:
        return ("SUCCESS", f"robocopy código {code}") if code < 8 else ("FAILED", f"robocopy código {code} (errores de copia)")
    if code == 0:
        return "SUCCESS", "código 0"
    return "FAILED", f"terminó con código {code} (0x{code:X})"


def detect_scheduled_backup_jobs() -> list[dict[str, Any]]:
    script = PS_BACKUP_TASKS.replace("__PATTERN__", BACKUP_TASK_PATTERN.replace("'", "''")).replace("__EXCLUDE__", BACKUP_TASK_EXCLUDE)
    tasks = run_powershell_json(script, timeout=90)
    jobs = []
    for t in tasks:
        actions = t.get("actions") or []
        texts = []
        base_dir = None
        direct_robocopy = False
        for a in actions:
            exe = a.get("execute") or ""
            args = a.get("arguments") or ""
            base_dir = a.get("workingDirectory") or base_dir
            texts.append(f"{exe} {args}")
            if os.path.basename(exe.strip('"')).lower().startswith("robocopy"):
                direct_robocopy = True
            # Script invocado (bat/cmd/ps1/vbs): se lee para ver que hace.
            for m in _RE_SCRIPT.finditer(f"{exe} {args}"):
                path = _unquote(m.group(1))
                if not os.path.isabs(path) and base_dir:
                    path = os.path.join(base_dir, path)
                content = _read_text_file(path)
                if content:
                    texts.append(content)
                    base_dir = base_dir or os.path.dirname(path)
        analysis = _analyze_commands("\n".join(texts), base_dir)

        result, reason = _task_result(int(t.get("lastResult") or 0), direct_robocopy)
        last_run = t.get("lastRun")
        ran_ok = result == "SUCCESS"
        job: dict[str, Any] = {
            "method": "SCHEDULED_TASK",
            "name": t.get("name"),
            "tool": ", ".join(analysis["tools"]) or "script",
            "enabled": bool(t.get("enabled", True)),
            "lastRunAt": last_run,
            "nextRunAt": t.get("nextRun"),
            "missedRuns": t.get("missedRuns") or 0,
            "runAs": t.get("user"),
            "result": result,
            "detail": f"Tarea programada: {reason}",
            "targetPath": next((p for p in analysis["targets"] if "%" not in p and "$" not in p), analysis["targets"][0] if analysis["targets"] else None),
        }

        # Log de robocopy: archivos copiados / con error en la ultima corrida.
        for log in analysis["logs"]:
            if "%" in log or not os.path.exists(log):
                continue
            stats = parse_robocopy_log(log)
            if stats:
                job["stats"] = stats
                if stats["filesFailed"] or stats["dirsFailed"]:
                    job["result"] = "FAILED" if job["result"] == "SUCCESS" and stats["filesCopied"] == 0 else "WARNING"
                    job["detail"] += f" · {stats['filesFailed']} archivo(s) no se pudieron copiar"
                break

        # Ultimo archivo de backup en los destinos (tamano real y fecha); si
        # es una copia espejo (robocopy /MIR) se estima el tamano de la carpeta.
        for target in [p for p in analysis["targets"] if "%" not in p and "$" not in p][:3]:
            if not os.path.isdir(target):
                continue
            archive = latest_archive_in(target)
            if archive:
                job["lastFile"] = archive
                job["sizeBytes"] = archive["sizeBytes"]
                job["targetPath"] = target
                break
        if not job.get("sizeBytes") and job.get("targetPath") and "robocopy" in analysis["tools"] and os.path.isdir(job["targetPath"]):
            job["sizeBytes"] = estimate_backup_size(job["targetPath"])

        # La tarea corrio bien (aunque robocopy haya salteado algun archivo):
        # hay un backup de esa fecha.
        if ran_ok:
            job["lastSuccessAt"] = last_run
        hours = _hours_since(last_run)
        if not job["enabled"]:
            job["result"] = "WARNING"
            job["detail"] = "La tarea de backup está DESHABILITADA. " + job["detail"]
        elif hours is not None and hours > STALE_HOURS and t.get("nextRun"):
            job["result"] = "WARNING" if job["result"] != "FAILED" else "FAILED"
            job["detail"] += f" · no corre hace {int(hours)} h"
        jobs.append(job)
    return jobs


def detect_file_history_jobs() -> list[dict[str, Any]]:
    """Historial de archivos de Windows (por usuario)."""
    jobs = []
    users_dir = os.path.join(os.environ.get("SystemDrive", "C:") + "\\", "Users")
    try:
        users = os.listdir(users_dir)
    except OSError:
        return jobs
    for user in users:
        conf_dir = os.path.join(users_dir, user, "AppData", "Local", "Microsoft", "Windows", "FileHistory", "Configuration")
        conf = os.path.join(conf_dir, "Config1.xml")
        if not os.path.exists(conf):
            continue
        xml = _read_text_file(conf, 100_000)
        target = re.search(r"<TargetUrl>(.*?)</TargetUrl>", xml)
        name = re.search(r"<TargetName>(.*?)</TargetName>", xml)
        freq = re.search(r"<DPFrequency>(\d+)</DPFrequency>", xml)
        catalog = os.path.join(conf_dir, "Catalog1.edb")
        last = _file_mtime_iso(catalog) or _file_mtime_iso(conf)
        hours = _hours_since(last)
        freq_h = int(freq.group(1)) / 3600 if freq else 1
        stale = hours is not None and hours > max(72, freq_h * 3)
        jobs.append(
            {
                "method": "FILE_HISTORY",
                "name": f"Historial de archivos ({user})",
                "tool": "Historial de archivos de Windows",
                "lastRunAt": last,
                "lastSuccessAt": None if stale else last,
                "result": "WARNING" if stale else "SUCCESS",
                "targetPath": target.group(1) if target else (name.group(1) if name else None),
                "detail": (f"Sin copias hace {int(hours)} h" if stale else "Copias al día") + (f" · cada {round(freq_h, 1)} h" if freq else ""),
            }
        )
    return jobs


def detect_third_party_backup() -> list[dict[str, Any]]:
    jobs: dict[str, dict[str, Any]] = {}
    if not hasattr(psutil, "win_service_iter"):
        return []
    for svc in psutil.win_service_iter():
        try:
            info = svc.as_dict()
        except Exception:
            continue
        text = f"{info.get('name', '')} {info.get('display_name', '')}".lower().replace(" ", "")
        for key, product in THIRD_PARTY_BACKUP.items():
            if key in text and product not in jobs:
                running = info.get("status") == "running"
                jobs[product] = {
                    "method": "THIRD_PARTY",
                    "name": product,
                    "tool": product,
                    "result": "UNKNOWN" if running else "WARNING",
                    "detail": f"Servicio {info.get('display_name')} {'en ejecución' if running else 'DETENIDO'}",
                    "lastRunAt": None,
                }
    # Veeam Agent informa cada trabajo en su propio registro de eventos (190).
    veeam = jobs.get("Veeam Agent")
    if veeam:
        for xml in _evt_query("Veeam Agent", "*[System[(EventID=190)]]", max_events=10):
            when = _evt_time_iso(xml)
            data = " ".join(v for _, v in _EVT_DATA_RE.findall(xml)) + " " + " ".join(re.findall(r"<Data>([^<]*)</Data>", xml))
            outcome = "FAILED" if re.search(r"fail", data, re.I) else "WARNING" if re.search(r"warn", data, re.I) else "SUCCESS" if re.search(r"success", data, re.I) else None
            if outcome:
                veeam.update(result=outcome, lastRunAt=when, detail=f"Último trabajo de Veeam: {outcome}")
                if outcome == "SUCCESS":
                    veeam["lastSuccessAt"] = when
                break
    return list(jobs.values())


def detect_sql_backups() -> list[dict[str, Any]]:
    """Backups de SQL Server segun msdb (ultima copia completa/diferencial/log por base)."""
    instances = []
    if hasattr(psutil, "win_service_iter"):
        for svc in psutil.win_service_iter():
            name = svc.name()
            if name == "MSSQLSERVER" or name.upper().startswith("MSSQL$"):
                try:
                    if svc.status() == "running":
                        instances.append(name.split("$", 1)[1] if "$" in name else "MSSQLSERVER")
                except Exception:
                    continue
    if not instances:
        return []
    script = PS_SQL_BACKUPS.replace("__INSTANCES__", ",".join(f"'{i}'" for i in instances))
    jobs = []
    for inst in run_powershell_json(script, timeout=120):
        label = f"SQL Server ({inst.get('instance')})"
        if inst.get("error"):
            jobs.append({"method": "SQL_SERVER", "name": label, "tool": "SQL Server", "result": "UNKNOWN",
                         "detail": "No se pudo leer msdb con la cuenta SYSTEM: " + str(inst["error"])[:200]})
            continue
        dbs = [d for d in inst.get("databases") or [] if d.get("name") not in ("model",)]
        problems, lasts = [], []
        for d in dbs:
            hours = _hours_since(d.get("lastFull"))
            newest = max(filter(None, [d.get("lastFull"), d.get("lastDiff")]), default=None)
            if newest:
                lasts.append(newest)
            newest_hours = _hours_since(newest)
            if hours is None:
                problems.append(f"{d['name']}: nunca tuvo backup completo")
            elif newest_hours is not None and newest_hours > 8 * 24:
                problems.append(f"{d['name']}: último backup hace {int(newest_hours / 24)} días")
            if d.get("recovery") == "FULL" and ((_hours_since(d.get("lastLog")) or 1e9) > 24):
                problems.append(f"{d['name']}: modo FULL sin backup de log en 24 h (el log crece)")
        last = max(lasts) if lasts else None
        jobs.append(
            {
                "method": "SQL_SERVER",
                "name": label,
                "tool": "SQL Server",
                "result": "WARNING" if problems else "SUCCESS",
                "lastRunAt": last,
                "lastSuccessAt": last,
                "detail": "; ".join(problems[:6]) if problems else f"{len(dbs)} base(s) con backup al día",
                "databases": dbs[:30],
            }
        )
    return jobs


RESULT_RANK = {"SUCCESS": 0, "RUNNING": 0, "UNKNOWN": 1, "WARNING": 2, "FAILED": 3}
METHOD_LABEL = {
    "WINDOWS_SERVER_BACKUP": "Windows Server Backup",
    "WBADMIN": "Copias de seguridad de Windows",
    "SCHEDULED_TASK": "Tarea programada",
    "FILE_HISTORY": "Historial de archivos",
    "SQL_SERVER": "SQL Server",
    "THIRD_PARTY": "Software de backup",
}


def collect_backup_jobs() -> list[dict[str, Any]]:
    jobs: list[dict[str, Any]] = []
    for name, fn in (
        ("tareas programadas", detect_scheduled_backup_jobs),
        ("historial de archivos", detect_file_history_jobs),
        ("software de terceros", detect_third_party_backup),
        ("SQL Server", detect_sql_backups),
    ):
        try:
            jobs.extend(fn())
        except Exception as exc:
            logger.warning("Deteccion de backups (%s) fallo: %s", name, exc)
    return jobs[:25]


def merge_backup_status(status: dict[str, Any], jobs: list[dict[str, Any]]) -> dict[str, Any]:
    """Combina el backup nativo (Windows Server Backup / wbadmin) con los demas
    metodos detectados en un unico estado: el peor resultado manda."""
    native_configured = status.get("result") not in ("NOT_CONFIGURED", "UNKNOWN", None)
    all_jobs = list(jobs)
    if native_configured:
        all_jobs.insert(0, {
            "method": status.get("method"),
            "name": METHOD_LABEL.get(status.get("method"), status.get("method")),
            "tool": METHOD_LABEL.get(status.get("method"), status.get("method")),
            "result": status.get("result"),
            "lastRunAt": status.get("lastBackupAt"),
            "lastSuccessAt": status.get("lastBackupAt") if status.get("result") == "SUCCESS" else None,
            "targetPath": status.get("targetPath"),
            "sizeBytes": status.get("sizeBytes"),
            "durationSeconds": status.get("durationSeconds"),
            "detail": (status.get("detail") or "")[:300],
        })
    if not all_jobs:
        return status

    status["jobs"] = all_jobs
    known = [j for j in all_jobs if j.get("result") != "UNKNOWN"]
    worst = max(known, key=lambda j: RESULT_RANK.get(j.get("result"), 1)) if known else all_jobs[0]
    overall = worst.get("result") if known else "UNKNOWN"
    status["result"] = "SUCCESS" if overall == "RUNNING" else overall
    status["method"] = worst.get("method") if len(all_jobs) == 1 or not native_configured else status.get("method")

    successes = [j["lastSuccessAt"] for j in all_jobs if j.get("lastSuccessAt")]
    if successes:
        status["lastBackupAt"] = max(successes)
    principal = next((j for j in all_jobs if j.get("targetPath")), None)
    if principal and not status.get("targetPath"):
        status["targetPath"] = principal["targetPath"]
    if not status.get("sizeBytes"):
        size = next((j.get("sizeBytes") for j in all_jobs if j.get("sizeBytes")), None)
        if size:
            status["sizeBytes"] = size

    lines = []
    for j in all_jobs:
        when = j.get("lastRunAt")
        hours = _hours_since(when)
        ago = f"hace {int(hours)} h" if hours is not None and hours < 72 else (f"hace {int(hours / 24)} días" if hours is not None else "sin ejecuciones")
        lines.append(f"[{j.get('result')}] {j.get('name')} ({j.get('tool')}): {ago}. {j.get('detail') or ''}".strip())
    status["detail"] = "\n".join(lines)[:1000]
    return status


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

    try:
        runs = read_backup_runs()
    except Exception as exc:
        logger.warning("No se pudo leer el historial de backups del Visor de Eventos: %s", exc)
        runs = []
    if runs:
        status["runs"] = runs
        latest = runs[0]
        last_success = next((r for r in runs if r["result"] == "SUCCESS"), None)
        if last_success and last_success.get("durationSeconds") is not None:
            status["durationSeconds"] = last_success["durationSeconds"]
        if not status.get("lastBackupAt") and last_success:
            status["lastBackupAt"] = last_success["finishedAt"]
        # wbadmin solo lista los backups que SALIERON bien: si la ultima
        # corrida del Visor de Eventos fallo despues del ultimo backup
        # listado, el estado real es FALLIDO aunque haya versiones viejas.
        if (
            status.get("method") == "WBADMIN"
            and status.get("result") == "SUCCESS"
            and latest["result"] == "FAILED"
            and latest["finishedAt"] > (status.get("lastBackupAt") or "")
        ):
            status["result"] = "FAILED"
            status["detail"] = (
                f"La ultima corrida de backup ({latest['finishedAt']}) fallo "
                f"(evento {latest['eventId']} de Microsoft-Windows-Backup). "
                + (status.get("detail") or "")
            )

    # Tamano real del backup: best-effort, solo si se detecto una ruta de
    # destino y el ultimo resultado fue exitoso (si fallo, el contenido
    # puede estar incompleto/no ser representativo).
    if status.get("result") == "SUCCESS" and status.get("targetPath"):
        try:
            size = estimate_backup_size(status["targetPath"])
            if size is not None:
                status["sizeBytes"] = size
        except Exception as exc:
            logger.warning("No se pudo estimar el tamano del backup en %s: %s", status.get("targetPath"), exc)

    # Demas metodos del equipo (scripts, Historial de archivos, SQL,
    # terceros): solo en los servidores ALOHA*. En el resto cuenta
    # unicamente Windows Server Backup (evita avisos falsos por tareas o
    # archivos viejos que no son el backup del servidor).
    if _backup_mode == "MULTI":
        try:
            status = merge_backup_status(status, collect_backup_jobs())
        except Exception as exc:
            logger.warning("No se pudieron combinar los metodos de backup detectados: %s", exc)

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

    metadata: dict[str, Any] = {}
    for key in ("runs", "versions", "durationSeconds", "jobs"):
        if status.get(key):
            metadata[key] = status[key]
    if metadata:
        payload["metadata"] = metadata

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
        global _backup_mode
        mode = body.get("backupMode")
        if mode in ("MULTI", "NATIVE", "EXCLUDED") and mode != _backup_mode:
            logger.info("Modo de lectura de backups: %s -> %s (definido en el NOC)", _backup_mode, mode)
            _backup_mode = mode
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
    global _last_diagnostics_at
    metrics = collect_system_metrics()
    recent_errors = collect_recent_errors()

    metadata: dict[str, Any] = {
        "hostname": os.getenv("COMPUTERNAME", ""),
        "recentEventLogErrors": recent_errors,
    }

    try:
        network = collect_network_status()
        track_outage(network["internetUp"])
        if _pending_outages:
            network["outages"] = list(_pending_outages)
        metadata["network"] = network
    except Exception as exc:
        logger.warning("No se pudo medir la red: %s", exc)

    global _pending_diagnostics
    if _diagnostics_threaded:
        with _diag_lock:
            if _pending_diagnostics is not None:
                metadata["diagnostics"] = _pending_diagnostics
                _pending_diagnostics = None
    else:
        now = time.monotonic()
        if now - _last_diagnostics_at >= DIAGNOSTICS_INTERVAL_SECONDS:
            _last_diagnostics_at = now
            metadata["diagnostics"] = collect_diagnostics()

    return {
        **metrics,
        "recordedAt": _utc_now_iso(),
        "agentVersion": AGENT_VERSION,
        "metadata": metadata,
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
        # Los cortes de internet ya reportados no se vuelven a mandar.
        for outage in (payload.get("metadata", {}).get("network") or {}).get("outages", []):
            if outage in _pending_outages:
                _pending_outages.remove(outage)
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
        if "diagnostics" in payload.get("metadata", {}):
            global _last_diagnostics_at, _pending_diagnostics
            _last_diagnostics_at = float("-inf")  # reintentar el diagnostico en el proximo ciclo
            with _diag_lock:
                if _pending_diagnostics is None:
                    _pending_diagnostics = payload["metadata"]["diagnostics"]
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
        # La opcion "reiniciar si falla" del Programador de tareas NO reacciona
        # al codigo de salida (solo a fallas al iniciar): antes de salir se
        # asegura el disparador "vigilante" que relanza la tarea cada minuto
        # si no esta corriendo, y se sale limpio. Arranca de nuevo ya con el
        # .exe nuevo en menos de un minuto.
        ensure_task_watchdog(force=True)
        sys.exit(0)
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


# ---------------------------------------------------------------------------
# Inventario de red: DHCP, Active Directory, sesiones de usuarios, impresoras
# y barrido de IPs. Corre en un hilo aparte cada INVENTORY_INTERVAL_SECONDS,
# solo en el servidor con los roles (ver INVENTORY_ENABLED).
# ---------------------------------------------------------------------------

_CREATE_NO_WINDOW = 0x08000000


def run_powershell_json(script: str, timeout: int = 180) -> list[Any]:
    """Ejecuta PowerShell y devuelve la salida de ConvertTo-Json como lista.

    El script debe terminar escribiendo JSON (ConvertTo-Json -InputObject
    @(...)); la salida se fuerza a UTF-8 para no romper tildes/eñes en
    nombres de usuarios y equipos.
    """
    full = (
        "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; "
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; " + script
    )
    proc = subprocess.run(
        [windows_exe("powershell.exe", "WindowsPowerShell", "v1.0"), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", full],
        capture_output=True,
        timeout=timeout,
        creationflags=_CREATE_NO_WINDOW if sys.platform == "win32" else 0,
    )
    if proc.returncode != 0:
        raise RuntimeError(_decode_console_bytes(proc.stderr or b"").strip()[-400:] or f"codigo {proc.returncode}")
    out = (proc.stdout or b"").decode("utf-8", errors="replace").strip().lstrip("﻿")
    if not out:
        return []
    data = json.loads(out)
    return data if isinstance(data, list) else [data]


def _service_exists(name: str) -> bool:
    if not hasattr(psutil, "win_service_get"):
        return False
    try:
        psutil.win_service_get(name)
        return True
    except Exception:
        return False


def detect_inventory_roles() -> dict[str, bool]:
    return {
        "dhcp": _service_exists("DHCPServer"),
        "ad": _service_exists("NTDS"),
        "printServer": _service_exists("Spooler"),
    }


PS_DHCP = r"""
Import-Module DhcpServer
function Iso($d) { if ($d) { $d.ToUniversalTime().ToString('o') } else { $null } }
$scopes = @(Get-DhcpServerv4Scope | ForEach-Object {
  $s = $_
  $st = Get-DhcpServerv4ScopeStatistics -ScopeId $s.ScopeId
  [pscustomobject]@{
    scopeId = $s.ScopeId.IPAddressToString; name = $s.Name; mask = $s.SubnetMask.IPAddressToString
    start = $s.StartRange.IPAddressToString; end = $s.EndRange.IPAddressToString; state = "$($s.State)"
    leaseHours = [math]::Round($s.LeaseDuration.TotalHours, 1)
    inUse = [int]$st.InUse; free = [int]$st.Free; percentInUse = [math]::Round([double]$st.PercentageInUse, 1); reserved = [int]$st.Reserved
    exclusions = @(Get-DhcpServerv4ExclusionRange -ScopeId $s.ScopeId -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ start = $_.StartRange.IPAddressToString; end = $_.EndRange.IPAddressToString } })
    leases = @(Get-DhcpServerv4Lease -ScopeId $s.ScopeId -AllLeases -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ ip = $_.IPAddress.IPAddressToString; mac = "$($_.ClientId)"; host = $_.HostName; state = "$($_.AddressState)"; expires = (Iso $_.LeaseExpiryTime) } })
    reservations = @(Get-DhcpServerv4Reservation -ScopeId $s.ScopeId -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ ip = $_.IPAddress.IPAddressToString; mac = "$($_.ClientId)"; name = $_.Name; description = $_.Description } })
  }
})
ConvertTo-Json -InputObject $scopes -Depth 5 -Compress
"""

PS_AD_COMPUTERS = r"""
Import-Module ActiveDirectory
function Iso($d) { if ($d) { $d.ToUniversalTime().ToString('o') } else { $null } }
$c = @(Get-ADComputer -Filter * -Properties LastLogonDate,OperatingSystem,OperatingSystemVersion,Enabled,Description,whenCreated,DNSHostName | ForEach-Object {
  [pscustomobject]@{ name = $_.Name; dns = $_.DNSHostName; os = $_.OperatingSystem; osVersion = $_.OperatingSystemVersion; enabled = [bool]$_.Enabled
    description = $_.Description; lastLogon = (Iso $_.LastLogonDate); created = (Iso $_.whenCreated); ou = ($_.DistinguishedName -replace '^CN=[^,]+,', '') }
})
ConvertTo-Json -InputObject $c -Depth 3 -Compress
"""

PS_AD_USERS = r"""
Import-Module ActiveDirectory
function Iso($d) { if ($d) { $d.ToUniversalTime().ToString('o') } else { $null } }
$u = @(Get-ADUser -Filter * -Properties DisplayName,Department,Title,Enabled,LockedOut,PasswordNeverExpires,PasswordLastSet,LastLogonDate,'msDS-UserPasswordExpiryTimeComputed',EmailAddress | ForEach-Object {
  $exp = $null
  try { $raw = [int64]$_.'msDS-UserPasswordExpiryTimeComputed'; if ($raw -gt 0 -and $raw -lt 2650467743999999999) { $exp = [datetime]::FromFileTimeUtc($raw).ToString('o') } } catch { }
  [pscustomobject]@{ sam = $_.SamAccountName; displayName = $_.DisplayName; department = $_.Department; title = $_.Title; email = $_.EmailAddress
    enabled = [bool]$_.Enabled; lockedOut = [bool]$_.LockedOut; neverExpires = [bool]$_.PasswordNeverExpires
    passwordLastSet = (Iso $_.PasswordLastSet); passwordExpiresAt = $exp; lastLogon = (Iso $_.LastLogonDate) }
})
ConvertTo-Json -InputObject $u -Depth 3 -Compress
"""

PS_PRINT_QUEUES = r"""
$ports = @{}
Get-PrinterPort -ErrorAction SilentlyContinue | ForEach-Object { if ($_.PrinterHostAddress) { $ports[$_.Name] = $_.PrinterHostAddress } }
$p = @(Get-Printer -ErrorAction SilentlyContinue | Where-Object { $ports.ContainsKey($_.PortName) } | ForEach-Object {
  [pscustomobject]@{ name = $_.Name; ip = $ports[$_.PortName]; driver = $_.DriverName; status = "$($_.PrinterStatus)"; jobs = [int]$_.JobCount; shared = [bool]$_.Shared; location = $_.Location; comment = $_.Comment }
})
ConvertTo-Json -InputObject $p -Depth 3 -Compress
"""


def _ps_section(name: str, script: str) -> tuple[list[Any], str | None]:
    try:
        return run_powershell_json(script), None
    except Exception as exc:
        logger.warning("Inventario: fallo '%s': %s", name, exc)
        return [], f"{name}: {exc}"[:400]


# --- Eventos de seguridad del controlador de dominio -----------------------

_EVT_DATA_RE = re.compile(r"<Data Name=['\"]([^'\"]+)['\"]>([^<]*)</Data>")
_last_security_query: str | None = None  # ISO UTC del ultimo evento procesado
_ip_last_user: dict[str, dict[str, str]] = {}

DIRECTORY_EVENT_IDS = {
    4720: "user_created",
    4726: "user_deleted",
    4724: "password_reset",
    4740: "lockout",
    4767: "unlock",
    4728: "group_member_added",
    4732: "group_member_added",
    4756: "group_member_added",
    4729: "group_member_removed",
    4733: "group_member_removed",
    4757: "group_member_removed",
}


def _evt_data(xml: str) -> dict[str, str]:
    return {k: v for k, v in _EVT_DATA_RE.findall(xml)}


def _clean_ip(value: str | None) -> str | None:
    if not value or value in ("-", "::1", "127.0.0.1"):
        return None
    return value.replace("::ffff:", "")


def collect_security_events() -> dict[str, Any]:
    """Inicios de sesion (4768: el DC entrega un TGT de Kerberos cuando un
    usuario inicia sesion en una PC; trae usuario + IP de la PC), intentos
    fallidos (4771) y auditoria del directorio. Incremental: solo lo nuevo
    desde la corrida anterior (la primera mira las ultimas 24 h)."""
    global _last_security_query
    since = _last_security_query or datetime.fromtimestamp(time.time() - 86400, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    time_filter = f"TimeCreated[@SystemTime>'{since}']"

    logons: list[dict[str, Any]] = []
    failures: dict[tuple[str, str | None], int] = {}
    newest = since

    for xml in _evt_query("Security", f"*[System[(EventID=4768) and {time_filter}]]", max_events=20000):
        when = _evt_time_iso(xml)
        data = _evt_data(xml)
        user = data.get("TargetUserName", "")
        if not when or not user or user.endswith("$") or data.get("Status", "0x0") != "0x0":
            continue
        ip = _clean_ip(data.get("IpAddress"))
        if not ip:
            continue
        newest = max(newest, when)
        prev = _ip_last_user.get(ip)
        if prev and prev["user"] == user and prev["at"] >= when:
            continue
        _ip_last_user[ip] = {"user": user, "at": when}
        logons.append({"user": user, "domain": data.get("TargetDomainName"), "ip": ip, "at": when})

    for xml in _evt_query("Security", f"*[System[(EventID=4771 or EventID=4625) and {time_filter}]]", max_events=5000):
        when = _evt_time_iso(xml)
        data = _evt_data(xml)
        user = data.get("TargetUserName", "")
        if not when or not user or user.endswith("$"):
            continue
        newest = max(newest, when)
        key = (user.lower(), _clean_ip(data.get("IpAddress")))
        failures[key] = failures.get(key, 0) + 1

    ids = " or ".join(f"EventID={i}" for i in DIRECTORY_EVENT_IDS)
    directory: list[dict[str, Any]] = []
    for xml in _evt_query("Security", f"*[System[({ids}) and {time_filter}]]", max_events=2000):
        when = _evt_time_iso(xml)
        id_match = _EVT_ID_RE.search(xml)
        if not when or not id_match:
            continue
        event_id = int(id_match.group(1))
        data = _evt_data(xml)
        newest = max(newest, when)
        kind = DIRECTORY_EVENT_IDS[event_id]
        entry = {"eventId": event_id, "kind": kind, "at": when, "actor": data.get("SubjectUserName")}
        if kind.startswith("group_member"):
            member = data.get("MemberName", "")
            cn = re.match(r"CN=([^,]+)", member)
            entry.update(target=cn.group(1) if cn else member, group=data.get("TargetUserName"))
        else:
            entry["target"] = data.get("TargetUserName")
        if kind == "lockout":
            entry["callerHost"] = data.get("TargetDomainName")  # "Caller Computer Name" en el 4740
        directory.append(entry)

    _last_security_query = newest
    return {
        "logons": logons[-5000:],
        "failedAuth": [{"user": u, "ip": ip, "count": c} for (u, ip), c in sorted(failures.items(), key=lambda x: -x[1])][:200],
        "directoryEvents": directory,
    }


# --- Barrido de IPs ---------------------------------------------------------

_ARP_RE = re.compile(r"(\d+\.\d+\.\d+\.\d+)\s+([0-9a-fA-F]{2}(?:-[0-9a-fA-F]{2}){5})")


def probe_alive(ip: str) -> str | None:
    """True si algo responde en esa IP: ping ICMP o un puerto TCP comun. Un
    "conexion rechazada" tambien cuenta (el equipo existe aunque bloquee
    ping, como Windows con el firewall por defecto)."""
    if icmp_ping(ip, 700) is not None:
        return "icmp"
    for port in (445, 135, 3389, 9100, 80, 443, 22):
        try:
            with socket_module.create_connection((ip, port), timeout=0.35):
                return f"tcp/{port}"
        except ConnectionRefusedError:
            return f"tcp/{port}"
        except OSError:
            continue
    return None


def read_arp_table() -> dict[str, str]:
    if sys.platform != "win32":
        return {}
    try:
        proc = subprocess.run([windows_exe("arp.exe"), "-a"], capture_output=True, timeout=15, creationflags=_CREATE_NO_WINDOW)
    except Exception:
        return {}
    out = _decode_console_bytes(proc.stdout or b"")
    return {ip: mac.lower() for ip, mac in _ARP_RE.findall(out) if not mac.lower().startswith("ff-ff")}


def ips_to_sweep(scopes: list[dict[str, Any]]) -> list[str]:
    ips: list[str] = []
    seen: set[str] = set()

    def add_range(first: ipaddress.IPv4Address, last: ipaddress.IPv4Address) -> None:
        cur = int(first)
        while cur <= int(last) and len(ips) < INVENTORY_MAX_IPS:
            ip = str(ipaddress.IPv4Address(cur))
            if ip not in seen:
                seen.add(ip)
                ips.append(ip)
            cur += 1

    # La subred COMPLETA de cada ambito, no solo el rango que reparte el
    # DHCP: asi tambien aparecen las IPs fijas (impresoras, servidores, APs).
    for scope in scopes:
        try:
            net = ipaddress.IPv4Network(f"{scope['scopeId']}/{scope['mask']}", strict=False)
            hosts = list(net.hosts())
            if hosts:
                add_range(hosts[0], hosts[-1])
        except (KeyError, ValueError):
            continue
    for subnet in INVENTORY_EXTRA_SUBNETS:
        try:
            net = ipaddress.IPv4Network(subnet, strict=False)
        except ValueError:
            continue
        hosts = list(net.hosts())
        if hosts:
            add_range(hosts[0], hosts[-1])
    return ips


def sweep_ips(ips: list[str]) -> dict[str, str]:
    if not ips:
        return {}
    with ThreadPoolExecutor(max_workers=128) as pool:
        results = pool.map(probe_alive, ips)
        return {ip: via for ip, via in zip(ips, results) if via}


# --- SNMP v2c minimo (sin dependencias) para leer impresoras ----------------

def _ber_len(n: int) -> bytes:
    if n < 0x80:
        return bytes([n])
    body = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(body)]) + body


def _ber(tag: int, payload: bytes) -> bytes:
    return bytes([tag]) + _ber_len(len(payload)) + payload


def _ber_int(v: int) -> bytes:
    body = v.to_bytes(max(1, (v.bit_length() + 8) // 8), "big", signed=True)
    return _ber(0x02, body)


def _ber_oid(oid: str) -> bytes:
    parts = [int(x) for x in oid.strip(".").split(".")]
    out = bytearray([parts[0] * 40 + parts[1]])
    for p in parts[2:]:
        chunk = [p & 0x7F]
        p >>= 7
        while p:
            chunk.insert(0, 0x80 | (p & 0x7F))
            p >>= 7
        out.extend(chunk)
    return _ber(0x06, bytes(out))


def _ber_parse(data: bytes, pos: int = 0) -> tuple[int, bytes, int]:
    tag = data[pos]
    length = data[pos + 1]
    pos += 2
    if length & 0x80:
        n = length & 0x7F
        length = int.from_bytes(data[pos:pos + n], "big")
        pos += n
    return tag, data[pos:pos + length], pos + length


def _decode_oid(body: bytes) -> str:
    parts = [body[0] // 40, body[0] % 40]
    value = 0
    for b in body[1:]:
        value = (value << 7) | (b & 0x7F)
        if not b & 0x80:
            parts.append(value)
            value = 0
    return ".".join(str(p) for p in parts)


def _decode_value(tag: int, body: bytes) -> Any:
    if tag == 0x02:
        return int.from_bytes(body, "big", signed=True) if body else 0
    if tag in (0x41, 0x42, 0x43, 0x46):
        return int.from_bytes(body, "big", signed=False) if body else 0
    if tag == 0x04:
        return body
    if tag == 0x06:
        return _decode_oid(body)
    if tag == 0x40:
        return ".".join(str(b) for b in body)
    return None  # null, noSuchObject (0x80), noSuchInstance (0x81), endOfMibView (0x82)


def snmp_request(host: str, oids: list[str], next_: bool = False, timeout: float = 1.5, community: str | None = None) -> list[tuple[str, Any]] | None:
    """GET (o GETNEXT) SNMP v2c. Devuelve [(oid, valor)] o None si no responde."""
    request_id = int.from_bytes(os.urandom(3), "big")
    varbinds = b"".join(_ber(0x30, _ber_oid(o) + b"\x05\x00") for o in oids)
    pdu = _ber(0xA1 if next_ else 0xA0, _ber_int(request_id) + _ber_int(0) + _ber_int(0) + _ber(0x30, varbinds))
    message = _ber(0x30, _ber_int(1) + _ber(0x04, (community or SNMP_COMMUNITY).encode()) + pdu)

    sock = socket_module.socket(socket_module.AF_INET, socket_module.SOCK_DGRAM)
    sock.settimeout(timeout)
    try:
        sock.sendto(message, (host, 161))
        data, _ = sock.recvfrom(65535)
    except OSError:
        return None
    finally:
        sock.close()

    try:
        _, msg, _ = _ber_parse(data)
        _, _, pos = _ber_parse(msg, 0)  # version
        _, _, pos = _ber_parse(msg, pos)  # community
        _, pdu_body, _ = _ber_parse(msg, pos)
        _, _, p = _ber_parse(pdu_body, 0)  # request id
        _, err, p = _ber_parse(pdu_body, p)
        _, _, p = _ber_parse(pdu_body, p)
        if int.from_bytes(err, "big"):
            return None
        _, vbs, _ = _ber_parse(pdu_body, p)
        out = []
        q = 0
        while q < len(vbs):
            _, vb, q = _ber_parse(vbs, q)
            _, oid_body, r = _ber_parse(vb, 0)
            vtag, vbody, _ = _ber_parse(vb, r)
            out.append((_decode_oid(oid_body), _decode_value(vtag, vbody)))
        return out
    except (IndexError, ValueError):
        return None


def snmp_walk(host: str, base: str, limit: int = 24) -> list[tuple[str, Any]]:
    rows = []
    oid = base
    for _ in range(limit):
        res = snmp_request(host, [oid], next_=True)
        if not res:
            break
        oid, value = res[0]
        if not oid.startswith(base + ".") or value is None:
            break
        rows.append((oid, value))
    return rows


def _txt(value: Any) -> str | None:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace").strip("\x00 ").strip() or None
    return None if value is None else str(value)


PRINTER_STATUS = {1: "other", 2: "unknown", 3: "idle", 4: "printing", 5: "warmup"}
DEVICE_STATUS = {1: "unknown", 2: "running", 3: "warning", 4: "testing", 5: "down"}
# hrPrinterDetectedErrorState (RFC 3805): bit 0 = MSB del primer octeto.
PRINTER_ERROR_BITS = [
    "lowPaper", "noPaper", "lowToner", "noToner", "doorOpen", "jammed", "offline", "serviceRequested",
    "inputTrayMissing", "outputTrayMissing", "markerSupplyMissing", "outputNearFull", "outputFull", "inputTrayEmpty", "overduePreventMaint",
]


def snmp_printer_info(ip: str) -> dict[str, Any] | None:
    """Estado de una impresora por la Printer-MIB estandar (HP, Brother,
    Epson, Ricoh, Kyocera, Lexmark...). None si no es una impresora o no
    responde SNMP."""
    status = snmp_request(ip, ["1.3.6.1.2.1.25.3.5.1.1"], next_=True, timeout=1.2)
    if not status or not status[0][0].startswith("1.3.6.1.2.1.25.3.5.1.1."):
        return None
    index = status[0][0].rsplit(".", 1)[-1]
    info: dict[str, Any] = {"ip": ip, "printerStatus": PRINTER_STATUS.get(status[0][1], "unknown")}

    base = snmp_request(
        ip,
        [
            "1.3.6.1.2.1.1.1.0",  # sysDescr
            "1.3.6.1.2.1.1.5.0",  # sysName
            "1.3.6.1.2.1.1.6.0",  # sysLocation
            f"1.3.6.1.2.1.25.3.2.1.3.{index}",  # hrDeviceDescr (modelo)
            f"1.3.6.1.2.1.25.3.2.1.5.{index}",  # hrDeviceStatus
            f"1.3.6.1.2.1.25.3.5.1.2.{index}",  # hrPrinterDetectedErrorState
            "1.3.6.1.2.1.43.5.1.1.17.1",  # prtGeneralSerialNumber
            "1.3.6.1.2.1.43.10.2.1.4.1.1",  # prtMarkerLifeCount (contador de paginas)
        ],
    ) or []
    values = dict(base)
    info["sysDescr"] = _txt(values.get("1.3.6.1.2.1.1.1.0"))
    info["sysName"] = _txt(values.get("1.3.6.1.2.1.1.5.0"))
    info["location"] = _txt(values.get("1.3.6.1.2.1.1.6.0"))
    info["model"] = _txt(values.get(f"1.3.6.1.2.1.25.3.2.1.3.{index}")) or info["sysDescr"]
    info["deviceStatus"] = DEVICE_STATUS.get(values.get(f"1.3.6.1.2.1.25.3.2.1.5.{index}"), "unknown")
    info["serial"] = _txt(values.get("1.3.6.1.2.1.43.5.1.1.17.1"))
    pages = values.get("1.3.6.1.2.1.43.10.2.1.4.1.1")
    info["pageCount"] = pages if isinstance(pages, int) else None

    errors = []
    raw = values.get(f"1.3.6.1.2.1.25.3.5.1.2.{index}")
    if isinstance(raw, bytes):
        for i, name in enumerate(PRINTER_ERROR_BITS):
            byte, bit = divmod(i, 8)
            if byte < len(raw) and raw[byte] & (0x80 >> bit):
                errors.append(name)
    info["errors"] = errors

    # Consumibles: descripcion, capacidad maxima y nivel (Printer-MIB).
    descriptions = snmp_walk(ip, "1.3.6.1.2.1.43.11.1.1.6.1")
    maxima = dict((o.rsplit(".", 1)[-1], v) for o, v in snmp_walk(ip, "1.3.6.1.2.1.43.11.1.1.8.1"))
    levels = dict((o.rsplit(".", 1)[-1], v) for o, v in snmp_walk(ip, "1.3.6.1.2.1.43.11.1.1.9.1"))
    supplies = []
    for oid, desc in descriptions:
        idx = oid.rsplit(".", 1)[-1]
        max_cap, level = maxima.get(idx), levels.get(idx)
        percent = None
        if isinstance(max_cap, int) and isinstance(level, int) and max_cap > 0 and level >= 0:
            percent = round(100 * level / max_cap)
        supplies.append({"name": _txt(desc) or f"Consumible {idx}", "percent": percent, "level": level, "max": max_cap})
    info["supplies"] = supplies[:12]
    return info


def collect_printers(alive: dict[str, str], queues: list[dict[str, Any]]) -> list[dict[str, Any]]:
    candidates = set(alive) | {q["ip"] for q in queues if q.get("ip")}
    candidates = {ip for ip in candidates if re.fullmatch(r"\d+\.\d+\.\d+\.\d+", ip or "")}
    with ThreadPoolExecutor(max_workers=48) as pool:
        found = [p for p in pool.map(snmp_printer_info, sorted(candidates)) if p]
    by_ip = {p["ip"]: p for p in found}
    # Colas del servidor de impresion cuya impresora no respondio SNMP:
    # igual se reportan (con el estado que ve Windows y si responde ping).
    for q in queues:
        ip = q.get("ip")
        entry = by_ip.get(ip)
        if entry is None:
            entry = {"ip": ip, "printerStatus": None, "snmp": False, "reachable": ip in alive}
            by_ip[ip] = entry
        entry.setdefault("queues", []).append(
            {"name": q.get("name"), "status": q.get("status"), "jobs": q.get("jobs"), "shared": q.get("shared"), "driver": q.get("driver")}
        )
        entry.setdefault("location", q.get("location"))
    return list(by_ip.values())


_inventory_roles: dict[str, bool] | None = None


def inventory_should_run() -> bool:
    global _inventory_roles
    if INVENTORY_ENABLED in ("false", "0", "no"):
        return False
    if _inventory_roles is None:
        _inventory_roles = detect_inventory_roles()
        logger.info("Roles detectados para el inventario de red: %s", _inventory_roles)
    if INVENTORY_ENABLED in ("true", "1", "yes"):
        return True
    return _inventory_roles["dhcp"] or _inventory_roles["ad"] or bool(INVENTORY_EXTRA_SUBNETS)


def build_inventory_payload() -> dict[str, Any]:
    started = time.monotonic()
    roles = _inventory_roles or detect_inventory_roles()
    errors: list[str] = []
    payload: dict[str, Any] = {"collectedAt": _utc_now_iso(), "roles": roles, "hostname": os.getenv("COMPUTERNAME", "")}

    scopes: list[dict[str, Any]] = []
    if roles.get("dhcp"):
        scopes, err = _ps_section("DHCP", PS_DHCP)
        errors += [err] if err else []
    payload["scopes"] = scopes

    if roles.get("ad"):
        payload["computers"], err = _ps_section("equipos del AD", PS_AD_COMPUTERS)
        errors += [err] if err else []
        payload["users"], err = _ps_section("usuarios del AD", PS_AD_USERS)
        errors += [err] if err else []
        try:
            payload.update(collect_security_events())
        except Exception as exc:
            errors.append(f"eventos de seguridad: {exc}"[:400])

    queues: list[dict[str, Any]] = []
    if roles.get("printServer"):
        queues, _ = _ps_section("colas de impresion", PS_PRINT_QUEUES)

    targets = ips_to_sweep(scopes)
    alive = sweep_ips(targets)
    arp = read_arp_table()
    payload["sweep"] = {"scanned": len(targets), "alive": {ip: {"via": via, "mac": arp.get(ip)} for ip, via in alive.items()}}
    payload["extraSubnets"] = INVENTORY_EXTRA_SUBNETS
    payload["printers"] = collect_printers(alive, queues)
    payload["errors"] = errors
    payload["durationSeconds"] = round(time.monotonic() - started, 1)
    return payload


def send_inventory(payload: dict[str, Any]) -> None:
    url = f"{BACKEND_URL}/api/inventory"
    headers = {"Content-Type": "application/json", "X-Server-Id": SERVER_ID, "X-Api-Key": API_KEY}
    try:
        response = requests.post(url, json=payload, headers=headers, timeout=60)
        response.raise_for_status()
        body = response.json() if response.content else {}
        if body.get("inventoryEnabled") is False:
            # Otro servidor es el recolector: no volver a escanear la red por
            # 6 horas (despues se vuelve a preguntar, por si cambio la config).
            global _inventory_paused_until
            _inventory_paused_until = time.monotonic() + 6 * 3600
            logger.info("Inventario de red desactivado para este servidor: %s", body.get("reason", "no es el recolector"))
            return
        logger.info(
            "Inventario enviado OK: %d ambito(s), %d equipo(s) AD, %d IP(s) activas de %d, %d impresora(s), %d inicio(s) de sesion (%.0fs)",
            len(payload.get("scopes", [])),
            len(payload.get("computers", [])),
            len(payload["sweep"]["alive"]),
            payload["sweep"]["scanned"],
            len(payload.get("printers", [])),
            len(payload.get("logons", [])),
            payload["durationSeconds"],
        )
    except requests.exceptions.RequestException as exc:
        status = getattr(exc.response, "status_code", "sin respuesta")
        logger.error("Fallo al enviar el inventario (HTTP %s): %s", status, exc)


_inventory_paused_until: float = 0.0


def inventory_loop() -> None:
    while True:
        try:
            if time.monotonic() >= _inventory_paused_until and inventory_should_run():
                send_inventory(build_inventory_payload())
        except Exception:
            logger.exception("Error en el ciclo de inventario de red")
        time.sleep(INVENTORY_INTERVAL_SECONDS)


# ---------------------------------------------------------------------------
# Tarea programada: vigilante e instancia unica
# ---------------------------------------------------------------------------
TASK_NAME = os.getenv("AGENT_TASK_NAME", "EnterpriseSOCAgent")

# Disparador diario que se repite cada minuto durante 24 h (en la practica,
# siempre): si el agente no esta corriendo (se cerro, se actualizo, fallo),
# el Programador de tareas lo vuelve a lanzar en menos de un minuto. Con
# "IgnoreNew" (valor por defecto) nunca abre una segunda instancia. Se usa
# esta forma y no "-RepetitionDuration indefinido" porque funciona igual en
# Windows 7/2012 R2 y en Windows 11/Server 2022.
PS_TASK_WATCHDOG = r"""
$name = '__TASK__'
$t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if (-not $t) { ConvertTo-Json -InputObject @([pscustomobject]@{ status = 'missing' }) -Compress; return }
$has = @($t.Triggers | Where-Object { $_.Repetition -and $_.Repetition.Interval }).Count -gt 0
if ($has -and -not $__FORCE__) { ConvertTo-Json -InputObject @([pscustomobject]@{ status = 'ok' }) -Compress; return }
$boot = New-ScheduledTaskTrigger -AtStartup
$daily = New-ScheduledTaskTrigger -Daily -At '00:00'
$daily.Repetition = (New-ScheduledTaskTrigger -Once -At '00:00' -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 1)).Repetition
$settings = $t.Settings
$settings.MultipleInstances = 'IgnoreNew'
$settings.StartWhenAvailable = $true
$settings.DisallowStartIfOnBatteries = $false
$settings.StopIfGoingOnBatteries = $false
$settings.ExecutionTimeLimit = 'PT0S'
Set-ScheduledTask -TaskName $name -Trigger $boot, $daily -Settings $settings | Out-Null
ConvertTo-Json -InputObject @([pscustomobject]@{ status = 'fixed' }) -Compress
"""


def ensure_task_watchdog(force: bool = False) -> None:
    """Agrega a la tarea programada del agente el disparador que la relanza
    cada minuto (instalaciones hechas con install-agent.ps1 anterior a 1.5.0
    no lo tienen, y tras una auto-actualizacion la tarea quedaba detenida)."""
    if sys.platform != "win32" or not getattr(sys, "frozen", False):
        return
    try:
        script = PS_TASK_WATCHDOG.replace("__TASK__", TASK_NAME).replace("$__FORCE__", "$true" if force else "$false")
        result = run_powershell_json(script, timeout=60)
        status = result[0].get("status") if result else None
        if status == "fixed":
            logger.info("Tarea programada '%s': vigilante de reinicio configurado", TASK_NAME)
        elif status == "missing":
            logger.warning("No existe la tarea programada '%s' (¿se instaló a mano?): el agente no se relanzará solo", TASK_NAME)
    except Exception as exc:
        logger.warning("No se pudo configurar el vigilante de la tarea programada: %s", exc)


_instance_mutex = None


def acquire_single_instance() -> bool:
    """Evita dos agentes a la vez (por ej. uno lanzado a mano y otro por la
    tarea programada): mandarian todo duplicado."""
    global _instance_mutex
    if sys.platform != "win32":
        return True
    try:
        kernel32 = ctypes.windll.kernel32
        kernel32.CreateMutexW.restype = ctypes.c_void_p
        _instance_mutex = kernel32.CreateMutexW(None, False, "Global\\EnterpriseSOCAgent")
        return kernel32.GetLastError() != 183  # ERROR_ALREADY_EXISTS
    except Exception:
        return True


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
        "--inventory",
        action="store_true",
        help="Ejecuta un ciclo de inventario de red (DHCP/AD/impresoras/IPs), muestra el resumen y termina.",
    )
    parser.add_argument(
        "--version",
        action="store_true",
        help="Imprime la version del agente y termina.",
    )
    return parser.parse_args()


def lower_process_priority() -> None:
    """El agente corre con prioridad "por debajo de lo normal": en un servidor
    de punto de venta (ALOHA) o de archivos, el monitoreo nunca debe competir
    por CPU/disco con el sistema que vigila."""
    try:
        proc = psutil.Process()
        if sys.platform == "win32":
            proc.nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
            try:
                proc.ionice(psutil.IOPRIO_LOW)
            except Exception:
                pass
        else:
            proc.nice(10)
    except Exception as exc:
        logger.debug("No se pudo bajar la prioridad del agente: %s", exc)


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


def diagnostics_loop() -> None:
    global _pending_diagnostics
    time.sleep(5)
    while True:
        try:
            diagnostics = collect_diagnostics()
            with _diag_lock:
                _pending_diagnostics = diagnostics
        except Exception:
            logger.exception("Error armando el diagnostico extendido")
        time.sleep(DIAGNOSTICS_INTERVAL_SECONDS)


def backup_loop(debug: bool) -> None:
    """Chequeo de backups en su propio hilo: leer scripts, logs de robocopy o
    SQL puede tardar, y no debe demorar la telemetria (el NOC marcaria el
    servidor como caido)."""
    time.sleep(20)
    while True:
        try:
            if _backup_mode == "EXCLUDED":
                time.sleep(BACKUP_EXCLUDED_RECHECK_SECONDS)
            check_backup(debug)
        except Exception:
            logger.exception("Error en el chequeo de backups")
        time.sleep(BACKUP_CHECK_INTERVAL_SECONDS)


def check_backup(debug: bool) -> None:
    global _last_backup_check
    _last_backup_check = time.monotonic()
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

    if not args.once and not args.inventory and not acquire_single_instance():
        logger.info("Ya hay otra instancia del agente corriendo; esta se cierra.")
        return

    _cleanup_previous_update()
    if not args.once and not args.inventory:
        threading.Thread(target=ensure_task_watchdog, daemon=True).start()

    if args.inventory:
        global _inventory_roles
        _inventory_roles = detect_inventory_roles()
        payload = build_inventory_payload()
        print(json.dumps({k: (v if k in ("roles", "errors", "durationSeconds") else len(v) if isinstance(v, list) else v) for k, v in payload.items() if k != "sweep"}, indent=2, ensure_ascii=False))
        print(f"IPs activas: {len(payload['sweep']['alive'])} de {payload['sweep']['scanned']} barridas")
        send_inventory(payload)
        return
    logger.info(
        "Agente Enterprise SOC iniciado (v%s). Backend=%s, intervalo=%ss, debug=%s, once=%s",
        AGENT_VERSION,
        BACKEND_URL,
        POLL_INTERVAL_SECONDS,
        args.debug,
        args.once,
    )

    if not args.once:
        global _diagnostics_threaded
        _diagnostics_threaded = True
        lower_process_priority()
        threading.Thread(target=start_control_connection, daemon=True).start()
        threading.Thread(target=inventory_loop, daemon=True).start()
        threading.Thread(target=diagnostics_loop, daemon=True).start()
        threading.Thread(target=backup_loop, args=(args.debug,), daemon=True).start()

    while True:
        cycle_start = time.monotonic()

        try:
            run_cycle(args.debug)
            if args.once:
                check_backup(args.debug)
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
