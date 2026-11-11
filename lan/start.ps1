# A LAN night on this computer (lan.cmd runs this; lan/compose.yaml, lan/Dockerfile, lan/Caddyfile, lan/network.ps1).
# Finds the network the players are on, fixes what in Windows would keep them out, asks for tonight's admin password
# (not shown, not saved), starts the game's container and Caddy in front of it, and shows the address players type.
# While it runs it keeps an eye on the network: a new address (another network, a new lease) moves the name along.
# Enter or Q stops both. Tonight's data stays in a Docker volume.
#
#   lan.cmd                          https://lan.brieltje.be: a certificate from Let's Encrypt, the name in Cloudflare
#   lan.cmd -Address 192.168.1.10    the address the name points at, instead of the one it picks
#   lan.cmd -Domain spel.brieltje.be another name under brieltje.be
#   lan.cmd -NewToken                type the Cloudflare token again
#   lan.cmd -Staging                 Let's Encrypt's test service (browsers don't trust it: only for trying out)
#   lan.cmd -Http [-Port 8090]       plain http on this computer's address: no name, no certificate
#   lan.cmd -StopAfter 30            stop by itself after so many minutes (a test run)
#
# Without internet it uses the certificate it has; without one either, it starts over plain http by itself.
param(
  [string]$Domain = 'lan.brieltje.be',
  [string]$Address = '',
  [switch]$Http,
  [int]$Port = 8080,
  [switch]$NewToken,
  [switch]$Staging,
  [int]$StopAfter = 0
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
. (Join-Path $PSScriptRoot 'network.ps1')
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
$caddyData = Join-Path $own 'caddy'
$caddyLog = Join-Path $own 'caddy.log'
$interactive = -not [Console]::IsInputRedirected
$line = '-' * 64

function Get-Plain([Security.SecureString]$s) {
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

# The game's container, over https (secure cookies) or plain http. The password reaches only the container.
function Start-Game([bool]$overHttp) {
  $env:ADMIN_PASSWORD = Get-Plain $script:password
  $env:LAN_GAME_PORT = "$gamePort"
  if ($overHttp) { $env:LAN_NODE_ENV = '' } else { $env:LAN_NODE_ENV = 'production' }
  try {
    docker compose -f $compose up --build --detach --wait
    return $LASTEXITCODE -eq 0
  } finally {
    Remove-Item Env:ADMIN_PASSWORD -ErrorAction SilentlyContinue
  }
}

# Caddy on Windows itself: it sees each player's own address (Docker Desktop would show the game one for all).
function Start-Caddy([bool]$overHttp) {
  $env:LAN_CADDY_DATA = $caddyData -replace '\\', '/'
  $env:LAN_GAME_PORT = "$gamePort"
  if ($overHttp) {
    $env:LAN_PORT = "$Port"
    $config = Join-Path $PSScriptRoot 'Caddyfile.http'
  } else {
    $env:LAN_DOMAIN = $Domain
    $env:CF_API_TOKEN = Get-Plain $script:token
    if ($Staging) { $env:LAN_ACME_CA = 'https://acme-staging-v02.api.letsencrypt.org/directory' }
    $config = Join-Path $PSScriptRoot 'Caddyfile'
  }
  try {
    return Start-Process -FilePath $caddy -ArgumentList @('run', '--config', "`"$config`"", '--adapter', 'caddyfile') `
      -NoNewWindow -PassThru -RedirectStandardError $caddyLog -RedirectStandardOutput "$caddyLog.out"
  } finally {
    Remove-Item Env:CF_API_TOKEN -ErrorAction SilentlyContinue # only Caddy keeps it
  }
}

# Waits until Caddy answers on the players' address. True when it does.
function Wait-Caddy($proc, [bool]$overHttp, [int]$seconds) {
  if ($overHttp) { $url = "http://127.0.0.1:$Port/"; $resolve = @() }
  else { $url = "https://$Domain/"; $resolve = @('--resolve', "${Domain}:443:127.0.0.1") }
  $insecure = @()
  if ($Staging) { $insecure = @('-k') }
  $deadline = (Get-Date).AddSeconds($seconds)
  do {
    Start-Sleep -Seconds 2
    Write-Host -NoNewline '.'
    if ($proc.HasExited) { break }
    $code = & curl.exe -s --ssl-no-revoke -o NUL -w '%{http_code}' --max-time 5 @resolve @insecure $url
    if ($code -eq '200') { Write-Host ''; return $true }
    # A refused token won't come right by waiting (other failures may: Caddy tries again).
    if (-not $overHttp -and "$(Get-CertificateTrouble $caddyLog)" -match 'refused') { break }
  } while ((Get-Date) -lt $deadline)
  Write-Host ''
  return $false
}

function Stop-Caddy($proc) {
  if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue; $proc.WaitForExit(5000) | Out-Null }
}

function Show-Addresses([bool]$overHttp, $net, $nets) {
  Write-Host "`n$line"
  if ($overHttp) {
    $real = @($nets | Where-Object { -not $_.Virtual })
    if ($real) {
      Write-Host "Players type this in their browser (same network):`n"
      foreach ($n in $real) { Write-Host ("    http://{0}:{1}    ({2})" -f $n.Address, $Port, $n.Alias) }
    } else {
      Write-Host "No network found: only this computer can play (http://localhost:$Port)."
    }
    $base = "http://localhost:$Port"
  } else {
    Write-Host "Players type this in their browser (same network):`n"
    Write-Host "    https://$Domain"
    Write-Host "`n  (this computer: $($net.Address) on $($net.Alias))"
    $base = "https://$Domain"
  }
  Write-Host "`nYou, the host:   $base/admin/  (log in as admin), then Host"
  Write-Host "Watch players:   $base/admin/watch/  (one player or up to four side by side)"
  Write-Host "The big screen:  $base/admin/scores/  (F for full screen)"
  Write-Host $line
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
$online = Test-Internet
if ($online) { Write-Host 'Internet: yes.' } else { Write-Host 'Internet: no (fine once there is a certificate).' }

# Caddy, once.
if (-not (Test-Path $caddy)) {
  if (-not $online) { Write-Host 'The first start needs the internet: it builds Caddy. Connect, then try again.'; exit 1 }
  Write-Host "Building Caddy $caddyVersion with its Cloudflare add-on (only the first time: a few minutes)..."
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
    Write-Host "`nCaddy could not be built. Try again. What went wrong is in $buildLog"
    exit 1
  }
  Move-Item -Force (Join-Path $out 'caddy.exe') $caddy
  Remove-Item -Recurse -Force $out
}

# The network the players are on.
$nets = Get-LanNetworks
$net = Select-LanNetwork $nets $Address $interactive
if (-not $net) {
  Write-Host 'No network found. Connect this computer to the players'' network (cable or Wi-Fi), then try again.'
  exit 1
}
Write-Host ('Players'' network: {0}' -f (Format-LanNetwork $net))
Repair-Windows $net $caddy $interactive

# Plain http when there's no other way: no internet and no certificate.
if (-not $Http) {
  $end = Get-CertificateEnd $caddyData $Domain $Staging
  if ($end -and $end -gt (Get-Date)) {
    $days = [int]($end - (Get-Date)).TotalDays
    Write-Host ("Certificate for {0}: valid until {1:d MMM yyyy} ({2} days)." -f $Domain, $end, $days)
    if ($days -lt 21 -and -not $online) { Write-Host '  Under three weeks: start once with internet before the night, so Caddy renews it.' }
  } elseif (-not $online) {
    Write-Host "`nNo internet and no certificate for $Domain yet: starting over plain http instead."
    Write-Host '(Start once with internet to get the certificate; after that the venue needs none.)'
    $Http = $true
  }
}

# The ports Caddy needs.
$ports = @($Port)
if (-not $Http) { $ports = @(80, 443) }
foreach ($u in @(Get-PortUsers $ports $caddy)) {
  if ($u.Ours) {
    Write-Host "A Caddy from an earlier start still runs (process $($u.Id)): stopping it."
    Stop-Process -Id $u.Id -Force -ErrorAction SilentlyContinue
  } else {
    Write-Host "Port $($u.Port) is in use by $($u.Name) (process $($u.Id)). Close that program, then try again."
    if ($Http) { Write-Host '  Or use another port: lan.cmd -Http -Port 8090' }
    exit 1
  }
}

$script:token = $null
if (-not $Http) {
  # The Cloudflare token: asked once, kept encrypted for this Windows account on this computer (DPAPI).
  if ($NewToken -or -not (Test-Path $tokenFile)) {
    Write-Host "`nCaddy needs a Cloudflare API token to get the certificate and to point $Domain at this computer."
    Write-Host 'Make one at dash.cloudflare.com: My Profile > API Tokens > Create Token > "Edit zone DNS" template.'
    Write-Host '  Permissions: Zone / DNS / Edit, and add Zone / Zone / Read.'
    Write-Host "  Zone Resources: Include / Specific zone / $((($Domain -split '\.')[-2..-1]) -join '.'). Then Continue, Create Token.`n"
    do { $secure = Read-Host -AsSecureString 'The token (not shown)' } while ($secure.Length -lt 20)
    $secure | ConvertFrom-SecureString | Set-Content -Path $tokenFile -Encoding ASCII
    Write-Host "Kept encrypted in $tokenFile (lan.cmd -NewToken to change it).`n"
  }
  $script:token = Get-Content $tokenFile | ConvertTo-SecureString
  $recordSet = $false
  if ($online) {
    $why = Set-PublicRecord $Domain $net.Address (Get-Plain $script:token)
    if ($why) { Write-Host "Public DNS not changed ($why)." } else { Write-Host "Public DNS: $Domain points at $($net.Address)."; $recordSet = $true }
  }
  Show-NameCheck $Domain $net.Address $online
}

if ($env:ADMIN_PASSWORD -and $env:ADMIN_PASSWORD.Length -ge 8) {
  $script:password = ConvertTo-SecureString $env:ADMIN_PASSWORD -AsPlainText -Force # given beforehand: a start without a person
  Remove-Item Env:ADMIN_PASSWORD
} else {
  do {
    $script:password = Read-Host -AsSecureString "`nAn admin password for tonight (at least 8 characters, not shown)"
    if ($script:password.Length -lt 8) { Write-Host 'Too short. Try again.' }
  } while ($script:password.Length -lt 8)
}

$caddyProc = $null
try {
  Write-Host "`nBuilding and starting the game (the first time takes a few minutes)..."
  if (-not (Start-Game $Http)) {
    Write-Host "`nThe game did not start. Is port $gamePort in use by something else on this computer?"
    return
  }
  $caddyProc = Start-Caddy $Http
  Write-Host -NoNewline "`nStarting Caddy"
  $wait = 20
  if (-not $Http) {
    Write-Host -NoNewline ' and the certificate'
    if (-not (Get-CertificateEnd $caddyData $Domain $Staging)) { Write-Host -NoNewline ' (a first one takes a minute or two)'; $wait = 180 }
  }
  if (-not (Wait-Caddy $caddyProc $Http $wait)) {
    $trouble = $null
    if (-not $Http) { $trouble = Get-CertificateTrouble $caddyLog }
    if ($trouble) {
      Write-Host "`n$trouble"
    } else {
      Write-Host "`nCaddy did not answer. Its last words:"
      Get-Content $caddyLog -Tail 4 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $($_.Substring(0, [Math]::Min(200, $_.Length)))" }
    }
    Stop-Caddy $caddyProc
    Copy-Item $caddyLog "$caddyLog.failed" -Force -ErrorAction SilentlyContinue # kept: the next start writes a new log
    Write-Host "  (Caddy's log: $caddyLog.failed)"
    if ($Http) { return }
    $yes = 'y'
    if ($interactive) { $yes = Read-Host "`nStart over plain http instead (players type this computer's address)? [Y/n]" }
    if ($yes -and $yes -notmatch '^(y|j)') { return }
    $Http = $true
    if (@(Get-PortUsers @($Port) $caddy | Where-Object { -not $_.Ours })) { Write-Host "Port $Port is in use. Try: lan.cmd -Http -Port 8090"; return }
    if (-not (Start-Game $true)) { Write-Host 'The game did not start again.'; return }
    $caddyProc = Start-Caddy $true
    Write-Host -NoNewline 'Starting Caddy over plain http'
    if (-not (Wait-Caddy $caddyProc $true 20)) { Write-Host "Caddy did not answer. See $caddyLog"; return }
  }
  if (-not $Http) {
    $end = Get-CertificateEnd $caddyData $Domain $Staging
    if ($end) { Write-Host ("Certificate valid until {0:d MMM yyyy}." -f $end) }
  }
  $script:password = $null

  Show-Addresses $Http $net $nets
  Write-Host 'Windows may ask whether Caddy may use the network: allow it on private networks.'

  # Running: keep an eye on the network until Enter or Q (or -StopAfter).
  $stopAt = [datetime]::MaxValue
  if ($StopAfter -gt 0) { $stopAt = (Get-Date).AddMinutes($StopAfter) }
  if (-not $interactive -and $StopAfter -le 0) {
    Read-Host "`nPress Enter to stop the server"
    return
  }
  Write-Host "`nPress Enter or Q to stop the server. Meanwhile this window keeps an eye on the network."
  $nextCheck = (Get-Date).AddSeconds(15)
  $restarts = 0
  $lost = $false
  $nextRecordTry = Get-Date
  while ((Get-Date) -lt $stopAt) {
    if ($interactive -and [Console]::KeyAvailable) {
      $k = [Console]::ReadKey($true)
      if ($k.Key -eq 'Enter' -or $k.Key -eq 'Q' -or $k.Key -eq 'Escape') { break }
    }
    Start-Sleep -Milliseconds 250
    if ((Get-Date) -lt $nextCheck) { continue }
    $nextCheck = (Get-Date).AddSeconds(15)

    if ($caddyProc.HasExited) {
      if ($restarts -ge 3) { Write-Host "`nCaddy keeps stopping; see $caddyLog. Stop with Enter and start lan.cmd again."; $nextCheck = $stopAt; continue }
      $restarts++
      Write-Host "`n$(Get-Date -Format HH:mm) Caddy stopped; starting it again."
      $caddyProc = Start-Caddy $Http
    }

    # A new address: another network, or a new lease from the router.
    $new = Find-NewAddress $net
    if ($new) {
      if ($new -is [string]) { # 'lost'
        if (-not $lost) { Write-Host "`n$(Get-Date -Format HH:mm) This computer lost its network ($($net.Address)). Waiting for it to come back..." }
        $lost = $true
        continue
      }
      $lost = $false
      $nets = Get-LanNetworks
      Write-Host "`n$(Get-Date -Format HH:mm) This computer's address changed: $($net.Address) is now $($new.Address) on $($new.Alias)."
      $old = $net
      $net = $new
      if ($net.Category -eq 'Public' -or $net.Index -ne $old.Index) { Repair-Windows $net $caddy $interactive }
      if ($Http) { Show-Addresses $true $net $nets } else { $recordSet = $false; $nextRecordTry = Get-Date; Show-NameCheck $Domain $net.Address $false }
    }
    if (-not $Http -and -not $recordSet -and (Get-Date) -ge $nextRecordTry) {
      $nextRecordTry = (Get-Date).AddMinutes(2) # a refused token: not every 15 s all night
      if (Test-Internet) {
        $why = Set-PublicRecord $Domain $net.Address (Get-Plain $script:token)
        if (-not $why) {
          $recordSet = $true
          Write-Host "$(Get-Date -Format HH:mm) Public DNS: $Domain points at $($net.Address)."
          Show-NameCheck $Domain $net.Address $true
        }
      }
    }
  }
} finally {
  Stop-Caddy $caddyProc
  docker compose -f $compose stop
  $script:token = $null
  $script:password = $null
  Write-Host 'Stopped. Tonight''s players and scores are kept for next time (a new evening starts with the server).'
}
