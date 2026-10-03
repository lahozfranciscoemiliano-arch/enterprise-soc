#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Instala el agente Enterprise SOC como tarea programada persistente.

.DESCRIPTION
    1. Consigue enterprise-soc-agent.exe: lo copia desde AgentExePath si ya esta
       compilado localmente, o si no existe lo descarga directamente del backend
       (GET /downloads/enterprise-soc-agent.exe) -- asi no hace falta compilar ni
       copiar el binario a mano en cada servidor nuevo.
    2. Llama a POST /api/servers/enroll en el backend con el secreto compartido
       (AGENT_ENROLLMENT_SECRET) para auto-registrar este servidor y obtener
       credenciales unicas (SERVER_ID + API_KEY) sin tocar la base a mano.
    3. Escribe el .env del agente en InstallDir con esas credenciales.
    4. Registra una Tarea Programada que corre como SYSTEM (necesario para que
       wbadmin/WMI puedan leer el estado real de backups) al iniciar Windows,
       con reinicio automatico si el proceso se cae.

    Requiere PowerShell como Administrador (por el registro de la tarea con
    privilegios SYSTEM). Reinstalar en la misma maquina (mismo -ServerName)
    rota la API key automaticamente en el backend.

.EXAMPLE
    .\install-agent.ps1 -BackendUrl "https://noc.midominio.com" -EnrollmentSecret "el-secreto-del-backend"

.EXAMPLE
    .\install-agent.ps1 -BackendUrl "http://192.168.1.10:3000" -EnrollmentSecret "abc123" -ServerName "DDBS01"
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$BackendUrl,

    [Parameter(Mandatory = $true)]
    [string]$EnrollmentSecret,

    [string]$ServerName = $env:COMPUTERNAME,

    [string]$IpAddress = "",

    [string]$InstallDir = "C:\Program Files\EnterpriseSOC\Agent",

    # Vacio = buscar enterprise-soc-agent.exe junto a este script (y si no
    # esta, descargarlo del backend). Se resuelve mas abajo: en Windows
    # PowerShell 5.1 $PSScriptRoot puede venir vacio dentro de param().
    [string]$AgentExePath = "",

    [string]$TaskName = "EnterpriseSOCAgent"
)

$ErrorActionPreference = "Stop"

# El NOC se publica con HTTPS: Windows PowerShell 5.1 en servidores viejos
# (2012 R2 / 2016) negocia TLS 1.0 por defecto y la conexion falla con
# "No se puede crear un canal seguro SSL/TLS". Se habilita TLS 1.2.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

if (-not $AgentExePath) {
    $scriptDir = $PSScriptRoot
    if (-not $scriptDir -and $MyInvocation.MyCommand.Path) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
    if (-not $scriptDir) { $scriptDir = (Get-Location).Path }
    $AgentExePath = Join-Path $scriptDir "enterprise-soc-agent.exe"
}

function Write-Step($message) {
    Write-Host ""
    Write-Host "==> $message" -ForegroundColor Cyan
}

Write-Step "Verificando requisitos"

if (-not $IpAddress) {
    $IpAddress = (
        Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.InterfaceAlias -notmatch "Loopback" -and $_.IPAddress -notlike "169.254.*" } |
        Select-Object -First 1 -ExpandProperty IPAddress
    )
    if (-not $IpAddress) { $IpAddress = "0.0.0.0" }
}

Write-Host "  Servidor:    $ServerName"
Write-Host "  IP detectada: $IpAddress"
Write-Host "  Backend:     $BackendUrl"
Write-Host "  Destino:     $InstallDir"

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$destExe = Join-Path $InstallDir "enterprise-soc-agent.exe"

if (Test-Path $AgentExePath) {
    Write-Step "Copiando el agente local a $InstallDir"
    Copy-Item -Path $AgentExePath -Destination $destExe -Force
} else {
    Write-Step "No hay .exe local; descargando la ultima version desde el backend"
    try {
        Invoke-WebRequest -Uri "$BackendUrl/downloads/enterprise-soc-agent.exe" -OutFile $destExe -UseBasicParsing
    } catch {
        throw "No se encontro el agente en '$AgentExePath' ni se pudo descargar desde " +
              "$BackendUrl/downloads/enterprise-soc-agent.exe. Compilalo con PyInstaller (ver agent.py) " +
              "y publicalo en backend/downloads/, o pasa la ruta correcta con -AgentExePath. Detalle: $_"
    }
    Write-Host "  Descargado OK ($([math]::Round((Get-Item $destExe).Length / 1MB, 1)) MB)" -ForegroundColor Green
}

Write-Step "Registrando este servidor en el backend (auto-enrolamiento)"
$enrollBody = @{
    name      = $ServerName
    hostname  = $ServerName
    ipAddress = $IpAddress
} | ConvertTo-Json

try {
    $enrolled = Invoke-RestMethod -Uri "$BackendUrl/api/servers/enroll" -Method Post `
        -Headers @{ "X-Enrollment-Secret" = $EnrollmentSecret } `
        -ContentType "application/json" -Body $enrollBody
} catch {
    $statusCode = $_.Exception.Response.StatusCode.value__
    throw "Fallo el enrolamiento contra $BackendUrl (HTTP $statusCode). Verifica BackendUrl, " +
          "EnrollmentSecret, y que AGENT_ENROLLMENT_SECRET este configurado en el backend. Detalle: $_"
}

Write-Host "  SERVER_ID: $($enrolled.serverId)" -ForegroundColor Green
Write-Host "  Credenciales recibidas OK" -ForegroundColor Green

Write-Step "Escribiendo configuracion (.env)"
$envContent = @"
BACKEND_URL=$BackendUrl
SERVER_ID=$($enrolled.serverId)
API_KEY=$($enrolled.apiKey)
POLL_INTERVAL_SECONDS=60
REQUEST_TIMEOUT_SECONDS=10
EVENT_LOG_MAX_ERRORS=10
BACKUP_CHECK_INTERVAL_SECONDS=1800
"@
Set-Content -Path (Join-Path $InstallDir ".env") -Value $envContent -Encoding UTF8

Write-Step "Registrando la tarea programada ($TaskName)"

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Host "  Ya existe una tarea '$TaskName', se reemplaza..." -ForegroundColor Yellow
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$action = New-ScheduledTaskAction -Execute (Join-Path $InstallDir "enterprise-soc-agent.exe") -WorkingDirectory $InstallDir
# Dos disparadores: al iniciar Windows, y uno diario que se repite cada
# minuto (vigilante): si el agente se cierra (auto-actualizacion, falla), el
# Programador de tareas lo vuelve a lanzar en menos de un minuto. Con
# MultipleInstances=IgnoreNew nunca abre una segunda instancia.
$bootTrigger = New-ScheduledTaskTrigger -AtStartup
$watchdogTrigger = New-ScheduledTaskTrigger -Daily -At '00:00'
$watchdogTrigger.Repetition = (New-ScheduledTaskTrigger -Once -At '00:00' `
    -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 1)).Repetition
$trigger = @($bootTrigger, $watchdogTrigger)
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 0)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings `
    -Description "Agente de monitoreo Enterprise SOC: envia CPU/RAM/disco, eventos y estado de backup." | Out-Null

Write-Step "Iniciando el agente"
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3
$task = Get-ScheduledTask -TaskName $TaskName
$taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName

Write-Host ""
Write-Host "=================================================" -ForegroundColor Green
Write-Host " Agente instalado y corriendo" -ForegroundColor Green
Write-Host "=================================================" -ForegroundColor Green
Write-Host "  Tarea:       $TaskName (estado: $($task.State))"
Write-Host "  Ultima corrida: $($taskInfo.LastRunTime)"
Write-Host "  Logs:        $InstallDir\agent.log"
Write-Host ""
Write-Host "IMPORTANTE: la revision de backups (wbadmin/WMI) necesita privilegios" -ForegroundColor Yellow
Write-Host "de Administrador. Como la tarea corre como SYSTEM, esto ya queda resuelto." -ForegroundColor Yellow
Write-Host ""
Write-Host "Para desinstalar: .\uninstall-agent.ps1"
