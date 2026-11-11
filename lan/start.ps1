# A LAN night on this computer (lan.cmd runs this; lan/compose.yaml, lan/Dockerfile, lan/Caddyfile).
# Asks for tonight's admin password (not shown, not saved), builds and starts the game's container, starts Caddy in
# front of it and shows the address players type. Enter stops both. Tonight's data stays in a Docker volume.
#
#   lan.cmd                          https://lan.brieltje.be: a certificate from Let's Encrypt, the name in Cloudflare
#   lan.cmd -Address 192.168.1.10    the address the name points at, when this computer has several networks
#   lan.cmd -Domain spel.brieltje.be another name under brieltje.be
#   lan.cmd -NewToken                type the Cloudflare token again
#   lan.cmd -Staging                 Let's Encrypt's test service (browsers don't trust it: only for trying out)
#   lan.cmd -Http [-Port 8090]       plain http on this computer's address: no name, no certificate
param(
  [string]$Domain = 'lan.brieltje.be',
  [string]$Address = '',
  [switch]$Http,
  [int]$Port = 8080,
  [switch]$NewToken,
  [switch]$Staging
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$compose = Join-Path $PSScriptRoot 'compose.yaml'
$gamePort = 18080 # the game's own port, open to this computer only (compose.yaml); players come in through Caddy
# Caddy with its Cloudflare add-on, built from these versions in Docker on the first start and kept in $own (outside
# the repository). Go checks every module it fetches against its public checksum database.
$caddyVersion = '2.11.9'
$cloudflareVersion = '0.2.4'
$builder = 'caddy:2.11.9-builder@sha256:1b828679ae08622c534d8e83ed80c6c25d343202f0586fe3b52d8e0ce33413b9'
$own = Join-Path $env:LOCALAPPDATA 'brieltje-lan'
$arch = 'amd64'
if ($env:PROCESSOR_IDENTIFIER -match '^ARM') { $arch = 'arm64' } # e.g. "ARMv8 (64-bit) Family 8 ..."
$caddy = Join-Path $own "caddy-$caddyVersion-cloudflare-$cloudflareVersion-$arch.exe"
$tokenFile = Join-Path $own 'cloudflare-token.dpapi'
$caddyLog = Join-Path $own 'caddy.log'
$line = '-' * 64

function Get-Plain([Security.SecureString]$s) {
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

Write-Host "`nBrieltje: a LAN night on this computer`n"
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Host 'Docker is not installed. Install Docker Desktop (docker.com), start it, then try again.'
  exit 1
}
docker info *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Docker is not running. Start Docker Desktop, wait until it says it is running, then try again.'
  exit 1
}
New-Item -ItemType Directory -Force $own | Out-Null

# Caddy, once.
if (-not (Test-Path $caddy)) {
  Write-Host "Building Caddy $caddyVersion with its Cloudflare add-on (only the first time: a few minutes, needs the internet)..."
  $out = Join-Path $own 'build'
  New-Item -ItemType Directory -Force $out | Out-Null
  $buildLog = Join-Path $own 'caddy-build.log'
  # Its chatter to a log (Windows PowerShell turns a native program's stderr into errors, so not under 'Stop').
  $ErrorActionPreference = 'Continue'
  docker run --rm -v "${out}:/out" -e GOOS=windows -e "GOARCH=$arch" -e XCADDY_SETCAPS=0 $builder `
    xcaddy build "v$caddyVersion" --with "github.com/caddy-dns/cloudflare@v$cloudflareVersion" --output /out/caddy.exe *> $buildLog
  $built = $LASTEXITCODE -eq 0
  $ErrorActionPreference = 'Stop'
  if (-not $built -or -not (Test-Path (Join-Path $out 'caddy.exe'))) {
    Write-Host "`nCaddy could not be built. Is there internet? Try again. What went wrong is in $buildLog"
    exit 1
  }
  Move-Item -Force (Join-Path $out 'caddy.exe') $caddy
  Remove-Item -Recurse -Force $out
}

# A network Windows calls Public blocks players from reaching this computer.
foreach ($p in @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.NetworkCategory -eq 'Public' })) {
  Write-Host "Careful: Windows treats the network '$($p.Name)' ($($p.InterfaceAlias)) as Public, so players on it can't reach"
  Write-Host "this computer. Make it private: Settings > Network & internet > $($p.InterfaceAlias) > Private network.`n"
}

# This computer's addresses on its networks: real ones first; virtual adapters (WSL, Hyper-V, VirtualBox, Docker, VPNs)
# set apart, as players can't reach those. By the adapter's name and its description (VirtualBox's is called Ethernet 2).
$virtual = 'vEthernet|VirtualBox|WSL|Hyper-V|Docker|VMware|VPN|Tailscale|ZeroTier|Loopback|Bluetooth'
$all = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' }
$desc = @{}
Get-NetAdapter -ErrorAction SilentlyContinue | ForEach-Object { $desc[[int]$_.ifIndex] = $_.InterfaceDescription }
$isVirtual = { param($a) ($a.InterfaceAlias -match $virtual) -or ("$($desc[[int]$a.InterfaceIndex])" -match $virtual) }
$real = @($all | Where-Object { -not (& $isVirtual $_) })
$other = @($all | Where-Object { & $isVirtual $_ })

$token = $null
if (-not $Http) {
  # The address the name points at.
  if (-not $Address) {
    if ($real.Count -eq 1) { $Address = $real[0].IPAddress }
    elseif ($real.Count -gt 1) {
      Write-Host 'This computer is on several networks. Which one do the players use?'
      for ($i = 0; $i -lt $real.Count; $i++) { Write-Host ("  {0}. {1}  ({2})" -f ($i + 1), $real[$i].IPAddress, $real[$i].InterfaceAlias) }
      do { $n = 0; [void][int]::TryParse((Read-Host 'Number'), [ref]$n) } while ($n -lt 1 -or $n -gt $real.Count)
      $Address = $real[$n - 1].IPAddress
    } else {
      Write-Host 'No network found. Connect this computer to the players'' network, or try: lan.cmd -Http'
      exit 1
    }
  }

  # The Cloudflare token: asked once, kept encrypted for this Windows account on this computer (DPAPI).
  if ($NewToken -or -not (Test-Path $tokenFile)) {
    Write-Host "Caddy needs a Cloudflare API token to get the certificate and to point $Domain at this computer."
    Write-Host 'Make one at dash.cloudflare.com: My Profile > API Tokens > Create Token > "Edit zone DNS" template.'
    Write-Host '  Permissions: Zone / DNS / Edit, and add Zone / Zone / Read.'
    Write-Host "  Zone Resources: Include / Specific zone / $((($Domain -split '\.')[-2..-1]) -join '.'). Then Continue, Create Token.`n"
    do { $secure = Read-Host -AsSecureString 'The token (not shown)' } while ($secure.Length -lt 20)
    $secure | ConvertFrom-SecureString | Set-Content -Path $tokenFile -Encoding ASCII
    Write-Host "Kept encrypted in $tokenFile (lan.cmd -NewToken to change it).`n"
  }
  $token = Get-Plain (Get-Content $tokenFile | ConvertTo-SecureString)

  # The public record, so phones and browsers that ask Google or Cloudflare instead of your DNS still find this computer.
  $zoneName = (($Domain -split '\.')[-2..-1]) -join '.'
  try {
    $api = 'https://api.cloudflare.com/client/v4'
    $h = @{ Authorization = "Bearer $token" }
    $zone = @((Invoke-RestMethod -Headers $h -Uri "$api/zones?name=$zoneName" -TimeoutSec 10).result)[0]
    if (-not $zone) { throw "the token can't see $zoneName (it needs Zone / Zone / Read)" }
    $rec = @((Invoke-RestMethod -Headers $h -Uri "$api/zones/$($zone.id)/dns_records?type=A&name=$Domain" -TimeoutSec 10).result)[0]
    $body = @{ type = 'A'; name = $Domain; content = $Address; ttl = 60; proxied = $false; comment = 'LAN night (lan.cmd): the host computer on the local network' } | ConvertTo-Json
    if (-not $rec) {
      Invoke-RestMethod -Method Post -Headers $h -ContentType 'application/json' -Uri "$api/zones/$($zone.id)/dns_records" -Body $body -TimeoutSec 10 | Out-Null
    } elseif ($rec.content -ne $Address -or $rec.proxied) {
      Invoke-RestMethod -Method Patch -Headers $h -ContentType 'application/json' -Uri "$api/zones/$($zone.id)/dns_records/$($rec.id)" -Body $body -TimeoutSec 10 | Out-Null
    }
    Write-Host "Public DNS: $Domain points at $Address."
  } catch {
    Write-Host "Public DNS not changed ($($_.Exception.Message)). Your own DNS must point $Domain at $Address."
  }
  $seen = @()
  try { $seen = @(Resolve-DnsName -Name $Domain -Type A -DnsOnly -QuickTimeout -ErrorAction Stop | Where-Object { $_.Type -eq 'A' } | ForEach-Object { $_.IPAddress }) } catch {}
  if ($seen -notcontains $Address) {
    Write-Host "Careful: this computer's DNS answers $Domain with '$($seen -join ', ')', not $Address."
    Write-Host "Point it at $Address in your DNS (only that name, not a whole zone). Just changed? Wait a minute.`n"
  }
}

if ($env:ADMIN_PASSWORD -and $env:ADMIN_PASSWORD.Length -ge 8) {
  $plain = $env:ADMIN_PASSWORD # given beforehand, for a start without a person at the keyboard
} else {
  do {
    $plain = Get-Plain (Read-Host -AsSecureString 'An admin password for tonight (at least 8 characters, not shown)')
    if ($plain.Length -lt 8) { Write-Host 'Too short. Try again.' }
  } while ($plain.Length -lt 8)
}

Write-Host "`nBuilding and starting the game (the first time takes a few minutes)..."
$env:ADMIN_PASSWORD = $plain
$env:LAN_GAME_PORT = "$gamePort"
if ($Http) { $env:LAN_NODE_ENV = '' } else { $env:LAN_NODE_ENV = 'production' }
try {
  docker compose -f $compose up --build --detach --wait
  $ok = $LASTEXITCODE -eq 0
} finally {
  # Only the container keeps it: gone from this window's environment at once.
  Remove-Item Env:ADMIN_PASSWORD -ErrorAction SilentlyContinue
  $plain = $null
}
if (-not $ok) {
  Write-Host "`nThe game did not start. Is port $gamePort in use by something else on this computer?"
  exit 1
}

$caddyProc = $null
try {
  # Caddy on Windows itself: it sees each player's own address (Docker Desktop would show the game one for all).
  $env:LAN_CADDY_DATA = (Join-Path $own 'caddy') -replace '\\', '/'
  if ($Http) {
    $env:LAN_PORT = "$Port"
    $config = Join-Path $PSScriptRoot 'Caddyfile.http'
  } else {
    $env:LAN_DOMAIN = $Domain
    $env:CF_API_TOKEN = $token
    if ($Staging) { $env:LAN_ACME_CA = 'https://acme-staging-v02.api.letsencrypt.org/directory' }
    $config = Join-Path $PSScriptRoot 'Caddyfile'
  }
  try {
    $caddyProc = Start-Process -FilePath $caddy -ArgumentList @('run', '--config', "`"$config`"", '--adapter', 'caddyfile') `
      -NoNewWindow -PassThru -RedirectStandardError $caddyLog -RedirectStandardOutput "$caddyLog.out"
  } finally {
    # Only Caddy keeps the token.
    Remove-Item Env:CF_API_TOKEN -ErrorAction SilentlyContinue
    $token = $null
  }

  if ($Http) { $url = "http://127.0.0.1:$Port/"; $resolve = @() } else { $url = "https://$Domain/"; $resolve = @('--resolve', "${Domain}:443:127.0.0.1") }
  $insecure = @()
  if ($Staging) { $insecure = @('-k') }
  Write-Host -NoNewline "`nStarting Caddy"
  if (-not $Http) { Write-Host -NoNewline ' and getting the certificate (with internet, up to a minute or two the first time)' }
  $deadline = (Get-Date).AddSeconds(180)
  $code = ''
  do {
    Start-Sleep -Seconds 2
    Write-Host -NoNewline '.'
    if ($caddyProc.HasExited) { break }
    $code = & curl.exe -s --ssl-no-revoke -o NUL -w '%{http_code}' --max-time 5 @resolve @insecure $url
  } while ($code -ne '200' -and (Get-Date) -lt $deadline)
  Write-Host ''
  if ($code -ne '200') {
    Write-Host "`nCaddy did not answer on $url. Its last words ($caddyLog):"
    Get-Content $caddyLog -Tail 8 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" }
    if (-not $Http) { Write-Host "`nNo internet for a first certificate? Start once where there is internet, or use: lan.cmd -Http" }
    return # the finally below stops Caddy and the game
  }

  if (-not $Http) {
    # How long the certificate lasts (Caddy renews it itself, a month ahead, whenever it has the internet).
    try {
      $tcp = New-Object Net.Sockets.TcpClient('127.0.0.1', 443)
      $ssl = New-Object Net.Security.SslStream($tcp.GetStream(), $false, ([Net.Security.RemoteCertificateValidationCallback] { $true }))
      $ssl.AuthenticateAsClient($Domain)
      $end = (New-Object Security.Cryptography.X509Certificates.X509Certificate2($ssl.RemoteCertificate)).NotAfter
      $ssl.Dispose(); $tcp.Dispose()
      $days = [int]($end - (Get-Date)).TotalDays
      Write-Host ("Certificate valid until {0:d MMM yyyy} ({1} days)." -f $end, $days)
      if ($days -lt 21) { Write-Host 'Under three weeks: start once with internet before the night, so Caddy renews it.' }
    } catch {}
  }

  Write-Host "`n$line"
  if ($Http) {
    if ($real) {
      Write-Host "Players type this in their browser (same network):`n"
      foreach ($a in $real) { Write-Host ("    http://{0}:{1}    ({2})" -f $a.IPAddress, $Port, $a.InterfaceAlias) }
    } else {
      Write-Host "No network found: only this computer can play (http://localhost:$Port)."
    }
    if ($other) { Write-Host ("`n  (not for players: " + (($other | ForEach-Object { "$($_.IPAddress) on $($_.InterfaceAlias)" }) -join ', ') + ')') }
    $base = "http://localhost:$Port"
  } else {
    Write-Host "Players type this in their browser (same network):`n"
    Write-Host "    https://$Domain"
    Write-Host "`n  (this computer: $Address)"
    $base = "https://$Domain"
  }
  Write-Host "`nYou, the host:   $base/admin/  (log in as admin), then Host"
  Write-Host "Watch players:   $base/admin/watch/  (one player or up to four side by side)"
  Write-Host "The big screen:  $base/admin/scores/  (F for full screen)"
  Write-Host "`nWindows may ask whether Caddy may use the network: allow it on private networks."
  Write-Host $line
  Read-Host "`nPress Enter to stop the server"
} finally {
  if ($caddyProc -and -not $caddyProc.HasExited) { Stop-Process -Id $caddyProc.Id -Force -ErrorAction SilentlyContinue }
  docker compose -f $compose stop
  Write-Host 'Stopped. Tonight''s players and scores are kept for next time (a new evening starts with the server).'
}
