#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Desinstala el agente Enterprise SOC: detiene y elimina la tarea programada
    y, opcionalmente, borra los archivos instalados.

.EXAMPLE
    .\uninstall-agent.ps1
.EXAMPLE
    .\uninstall-agent.ps1 -RemoveFiles -InstallDir "C:\Program Files\EnterpriseSOC\Agent"
#>

param(
    [string]$TaskName = "EnterpriseSOCAgent",
    [string]$InstallDir = "C:\Program Files\EnterpriseSOC\Agent",
    [switch]$RemoveFiles
)

$ErrorActionPreference = "Stop"

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Host "Deteniendo y eliminando la tarea '$TaskName'..."
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Tarea eliminada." -ForegroundColor Green
} else {
    Write-Host "No hay ninguna tarea '$TaskName' registrada." -ForegroundColor Yellow
}

if ($RemoveFiles) {
    if (Test-Path $InstallDir) {
        Remove-Item -Path $InstallDir -Recurse -Force
        Write-Host "Carpeta $InstallDir eliminada." -ForegroundColor Green
    }
} else {
    Write-Host "Los archivos en $InstallDir se conservaron (usa -RemoveFiles para borrarlos tambien)." -ForegroundColor Yellow
    Write-Host "Nota: el registro del servidor en el backend tampoco se borra desde aqui; si queres" -ForegroundColor Yellow
    Write-Host "eliminarlo del NOC, hacelo desde la pestana Admin del dashboard." -ForegroundColor Yellow
}
