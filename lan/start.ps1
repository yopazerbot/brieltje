# A LAN night on this computer, in Docker (lan.cmd runs this; lan/compose.yaml, lan/Dockerfile).
# Asks for tonight's admin password (not shown, not saved), builds and starts the game's container, shows the
# addresses players type, and stops the container when you press Enter. Tonight's data stays in a Docker volume.
param([int]$Port = 8080)
$ErrorActionPreference = 'Stop'
$compose = Join-Path $PSScriptRoot 'compose.yaml'

Write-Host "`nBrieltje: a LAN night on this computer (Docker)`n"
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Host 'Docker is not installed. Install Docker Desktop (docker.com), start it, then try again.'
  exit 1
}
docker info *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Docker is not running. Start Docker Desktop, wait until it says it is running, then try again.'
  exit 1
}

do {
  $secure = Read-Host -AsSecureString 'An admin password for tonight (at least 8 characters, not shown)'
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  if ($plain.Length -lt 8) { Write-Host 'Too short. Try again.' }
} while ($plain.Length -lt 8)

Write-Host "`nBuilding and starting the game (the first time takes a few minutes)..."
$env:ADMIN_PASSWORD = $plain
$env:LAN_PORT = "$Port"
try {
  docker compose -f $compose up --build --detach --wait
  $ok = $LASTEXITCODE -eq 0
} finally {
  # Only the container keeps it: gone from this window's environment at once.
  Remove-Item Env:ADMIN_PASSWORD -ErrorAction SilentlyContinue
  $plain = $null
}
if (-not $ok) {
  Write-Host "`nThe game did not start. Is port $Port in use? Try: lan.cmd -Port 8090"
  exit 1
}

# This computer's addresses on its networks: real ones first; virtual adapters (WSL, Hyper-V, VirtualBox, Docker, VPNs)
# set apart, as players can't reach those.
$virtual = 'vEthernet|VirtualBox|WSL|Hyper-V|Docker|VMware|VPN|Tailscale|ZeroTier|Loopback|Bluetooth'
$all = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' }
# By the adapter's name and its description (VirtualBox's is called Ethernet 2; its description says VirtualBox).
$desc = @{}
Get-NetAdapter -ErrorAction SilentlyContinue | ForEach-Object { $desc[[int]$_.ifIndex] = $_.InterfaceDescription }
$isVirtual = { param($a) ($a.InterfaceAlias -match $virtual) -or ("$($desc[[int]$a.InterfaceIndex])" -match $virtual) }
$real = $all | Where-Object { -not (& $isVirtual $_) }
$other = $all | Where-Object { & $isVirtual $_ }
$line = '-' * 60
Write-Host "`n$line"
if ($real) {
  Write-Host "Players type this in their browser (same network):`n"
  foreach ($a in $real) { Write-Host ("    http://{0}:{1}    ({2})" -f $a.IPAddress, $Port, $a.InterfaceAlias) }
} else {
  Write-Host "No network found: only this computer can play (http://localhost:$Port)."
}
if ($other) { Write-Host ("`n  (not for players: " + (($other | ForEach-Object { "$($_.IPAddress) on $($_.InterfaceAlias)" }) -join ', ') + ')') }
Write-Host "`nYou, the host:   http://localhost:$Port/admin/  (log in as admin), then Host"
Write-Host "Watch players:   http://localhost:$Port/admin/watch/  (one player or up to four side by side)"
Write-Host "The big screen:  http://localhost:$Port/admin/scores/  (F for full screen)"
Write-Host "`nWindows may ask whether Docker may use the network: allow it on private networks."
Write-Host $line
Read-Host "`nPress Enter to stop the server"
docker compose -f $compose stop
Write-Host 'Stopped. Tonight''s players and scores are kept for next time (a new evening starts with the server).'
