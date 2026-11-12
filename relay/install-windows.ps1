# BE-Aero Relay Server: install on Windows as a scheduled task that starts
# at boot (runs whether or not anyone is signed in). Run in an elevated
# PowerShell:   powershell -ExecutionPolicy Bypass -File install-windows.ps1
# Remove with:  powershell -ExecutionPolicy Bypass -File install-windows.ps1 -Uninstall
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$Dir = Join-Path $env:ProgramData 'BE-Aero Relay'
$Data = Join-Path $Dir 'data'
$Task = 'BE-Aero Relay Server'

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $Task -Confirm:$false -ErrorAction SilentlyContinue
  Get-ChildItem $Dir -Exclude data -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
  Write-Host "Removed. Its data is still in $Data (delete it to forget the paired devices)."
  return
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node.js 18+ is needed: https://nodejs.org' }
$major = [int](& $node -p 'process.versions.node.split(".")[0]')
if ($major -lt 18) { throw "Node.js 18+ is needed (found $(& $node -v))" }

New-Item -ItemType Directory -Force -Path $Dir, $Data | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot '*') -Destination $Dir -Recurse -Force -Exclude 'data'
# Only SYSTEM and Administrators may read the relay's identity and mail.
icacls $Data /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' | Out-Null

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$Dir\relay.js`"" -WorkingDirectory $Dir
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$env:RELAY_DATA = $Data
[Environment]::SetEnvironmentVariable('RELAY_DATA', $Data, 'Machine')
Register-ScheduledTask -TaskName $Task -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $Task
# Let devices on the network reach it.
New-NetFirewallRule -DisplayName $Task -Direction Inbound -Protocol TCP -LocalPort 41811 -Action Allow -ErrorAction SilentlyContinue | Out-Null

Write-Host 'Installed and started. Pair your devices (in this elevated window):'
Write-Host "    `$env:RELAY_DATA='$Data'; node '$Dir\relay.js' pair"
