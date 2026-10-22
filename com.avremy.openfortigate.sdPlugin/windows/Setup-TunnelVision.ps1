<#
.SYNOPSIS
  One-time setup for the Tunnel Vision Stream Deck plugin on Windows. Run as administrator.

.DESCRIPTION
  Installs the helper to %ProgramFiles%\TunnelVision and registers two scheduled tasks,
  "TunnelVision Connect" and "TunnelVision Stop", that run it with highest privileges for your
  user. The plugin starts those tasks, so pressing a key never shows a UAC prompt.
  (This is the Windows equivalent of the macOS sudoers rule.)

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\Setup-TunnelVision.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\Setup-TunnelVision.ps1 -OpenConnectPath 'D:\Tools\openconnect\openconnect.exe'

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\Setup-TunnelVision.ps1 -Uninstall
#>
#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    # Full path to openconnect.exe. Auto-detected if omitted.
    [string]$OpenConnectPath,
    # Windows account that uses Stream Deck (must be an administrator account). Defaults to you.
    [string]$User = "$env:USERDOMAIN\$env:USERNAME",
    # Optional value passed to openconnect --script (normally not needed: openconnect uses
    # vpnc-script-win.js from its own folder).
    [string]$ScriptCommand,
    # Show a console window when the helper runs (use if your Windows lacks conhost --headless).
    [switch]$NoHeadless,
    [switch]$Uninstall,
    # Used by the plugin's "Run setup" button: write OK / ERROR: ... here and keep errors on screen.
    [string]$ResultFile
)

$ErrorActionPreference = 'Stop'

function Save-Result([string]$Text) {
    if ($ResultFile) { try { Set-Content -LiteralPath $ResultFile -Value $Text -Encoding ASCII } catch { } }
}

trap {
    $msg = $_.Exception.Message
    Write-Host ''
    Write-Host "Setup failed: $msg" -ForegroundColor Red
    Save-Result "ERROR: $msg"
    if ($ResultFile) { Read-Host 'Press Enter to close' | Out-Null }
    exit 1
}
$InstallDir = Join-Path $env:ProgramFiles 'TunnelVision'
$TaskNames = @('TunnelVision Connect', 'TunnelVision Stop')

if ($Uninstall) {
    foreach ($t in $TaskNames) { Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host 'Tunnel Vision helper removed. Your saved profiles in %LOCALAPPDATA%\TunnelVision were left in place.'
    return
}

# ---- find openconnect.exe ----
if (-not $OpenConnectPath) {
    $candidates = @()
    $cmd = Get-Command openconnect.exe -ErrorAction SilentlyContinue
    if ($cmd) { $candidates += $cmd.Source }
    $candidates += @(
        (Join-Path $env:ProgramFiles 'OpenConnect-GUI\openconnect.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'OpenConnect-GUI\openconnect.exe'),
        (Join-Path $env:ProgramFiles 'OpenConnect\openconnect.exe'),
        'C:\msys64\mingw64\bin\openconnect.exe',
        'C:\msys64\ucrt64\bin\openconnect.exe'
    )
    $OpenConnectPath = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
}
if (-not $OpenConnectPath -or -not (Test-Path -LiteralPath $OpenConnectPath)) {
    throw "openconnect.exe not found. Install OpenConnect-GUI (tick the command-line / console component) or pass -OpenConnectPath."
}
$OpenConnectPath = (Resolve-Path -LiteralPath $OpenConnectPath).Path
Write-Host "Using openconnect: $OpenConnectPath"

$ver = & $OpenConnectPath --version 2>&1 | Select-Object -First 1
Write-Host "  $ver"
if ("$ver" -match 'v(\d+)\.' -and [int]$Matches[1] -lt 9) {
    Write-Warning 'openconnect 9.0 or newer is needed for FortiGate (--protocol=fortinet).'
}
$ocDir = Split-Path -Parent $OpenConnectPath
if (-not $ScriptCommand -and -not (Test-Path -LiteralPath (Join-Path $ocDir 'vpnc-script-win.js')) -and -not (Test-Path -LiteralPath (Join-Path $ocDir 'vpnc-script.js'))) {
    Write-Warning "No vpnc-script-win.js next to openconnect.exe; routes/DNS may not be configured. Pass -ScriptCommand if yours lives elsewhere."
}

# The tasks run this binary elevated, so ordinary users must not be able to replace it.
$acl = Get-Acl -LiteralPath $OpenConnectPath
$weak = $acl.Access | Where-Object {
    $_.AccessControlType -eq 'Allow' -and
    $_.IdentityReference -match '\\(Users|Authenticated Users|Everyone)$|^Everyone$' -and
    ($_.FileSystemRights -band ([Security.AccessControl.FileSystemRights]'Write, Modify, FullControl'))
}
if ($weak) {
    Write-Warning "$OpenConnectPath is writable by non-admin users. Anything that can replace it could run as admin via Tunnel Vision. Prefer an install under Program Files."
}

# ---- install helper ----
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'tunnelvision-helper.ps1') -Destination $InstallDir -Force
@{ OpenConnect = $OpenConnectPath; Script = $ScriptCommand } | ConvertTo-Json |
    Set-Content -LiteralPath (Join-Path $InstallDir 'config.json') -Encoding ASCII
$helper = Join-Path $InstallDir 'tunnelvision-helper.ps1'

# ---- register tasks ----
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
$principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -MultipleInstances Parallel -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

foreach ($mode in 'Connect', 'Stop') {
    $psArgs = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$helper`" -Mode $mode"
    if ($NoHeadless) {
        $action = New-ScheduledTaskAction -Execute $ps -Argument $psArgs
    } else {
        $action = New-ScheduledTaskAction -Execute $conhost -Argument "--headless `"$ps`" $psArgs"
    }
    Register-ScheduledTask -TaskName "TunnelVision $mode" -Action $action -Principal $principal -Settings $settings `
        -Description "Tunnel Vision Stream Deck plugin: $mode openconnect tunnels (elevated helper)." -Force | Out-Null
    Write-Host "Registered task 'TunnelVision $mode' for $User"
}

Write-Host ''
Write-Host 'Done. You can close this window.' -ForegroundColor Green
Save-Result 'OK'
if ($ResultFile) { Start-Sleep -Seconds 2 }
