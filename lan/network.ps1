# Helpers for lan/start.ps1, so a LAN night works on whichever network this computer is on (Yoshi, 11 Nov 2026:
# "Make the script smart so it works on different networks"): which network the players are on, whether there is
# internet, the public DNS record, what the DNS answers, the certificate Caddy keeps, and the Windows settings that
# keep players out (a Public network, a firewall rule that blocks Caddy, a port in use).

$script:VirtualPattern = 'vEthernet|VirtualBox|WSL|Hyper-V|Docker|VMware|VPN|Tailscale|ZeroTier|WireGuard|OpenVPN|AnyConnect|Fortinet|Loopback|Bluetooth|Npcap'

# The adapters that are up with an IPv4 address, best first: real before virtual (WSL, Hyper-V, VPNs: players can't
# reach those), one with a router (a default gateway) before one without, cable before Wi-Fi, then Windows' own order.
function Get-LanNetworks {
  $up = @{}
  Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' } | ForEach-Object { $up[[int]$_.ifIndex] = $_ }
  $list = foreach ($c in @(Get-NetIPConfiguration -ErrorAction SilentlyContinue)) {
    $a = $up[[int]$c.InterfaceIndex]
    if (-not $a) { continue }
    foreach ($ip in @($c.IPv4Address)) {
      if (-not $ip -or $ip.IPAddress -like '169.254.*' -or $ip.IPAddress -like '127.*') { continue }
      $gw = @($c.IPv4DefaultGateway)[0]
      $metric = 99999
      if ($gw) { $metric = [int]$gw.RouteMetric + [int]$c.IPv4Interface.InterfaceMetric }
      [pscustomobject]@{
        Address  = $ip.IPAddress
        Alias    = $c.InterfaceAlias
        Index    = [int]$c.InterfaceIndex
        Virtual  = ($c.InterfaceAlias -match $script:VirtualPattern) -or ("$($a.InterfaceDescription)" -match $script:VirtualPattern)
        Router   = [bool]$gw
        Wired    = "$($a.PhysicalMediaType)" -eq '802.3'
        Wireless = "$($a.PhysicalMediaType)" -match '802\.11'
        Category = "$($c.NetProfile.NetworkCategory)"
        Network  = "$($c.NetProfile.Name)"
        Metric   = $metric
      }
    }
  }
  @($list | Sort-Object @{ e = { $_.Virtual } }, @{ e = { -not $_.Router } }, @{ e = { -not $_.Wired } }, Metric)
}

function Format-LanNetwork($n) {
  $what = @()
  if ($n.Virtual) { $what += 'virtual' } elseif ($n.Wired) { $what += 'cable' } elseif ($n.Wireless) { $what += 'Wi-Fi' } else { $what += 'other' }
  if ($n.Router) { $what += 'has a router' } else { $what += 'no router' }
  if ($n.Network) { $what += "network '$($n.Network)'" }
  '{0,-15}  {1}  ({2})' -f $n.Address, $n.Alias, ($what -join ', ')
}

# The network the players use: the one asked for, the only real one, or the best of several, Enter to accept it.
function Select-LanNetwork($nets, [string]$want, [bool]$ask) {
  $real = @($nets | Where-Object { -not $_.Virtual })
  if ($want) {
    $hit = @($nets | Where-Object { $_.Address -eq $want })
    if ($hit) { return $hit[0] }
    Write-Host "This computer has no address $want right now; choosing from the networks it is on."
  }
  if ($real.Count -eq 0) { return $null }
  if ($real.Count -eq 1 -or -not $ask) { return $real[0] }
  Write-Host 'This computer is on several networks. Which one do the players use?'
  for ($i = 0; $i -lt $real.Count; $i++) { Write-Host ('  {0}. {1}' -f ($i + 1), (Format-LanNetwork $real[$i])) }
  while ($true) {
    $answer = Read-Host 'Number (Enter for 1)'
    if (-not $answer) { return $real[0] }
    $n = 0
    if ([int]::TryParse($answer, [ref]$n) -and $n -ge 1 -and $n -le $real.Count) { return $real[$n - 1] }
  }
}

# While the night runs: $null while this computer keeps $net's address; else the network it is on now (the same
# adapter's new address first, else the best real one), or 'lost' when it is on none.
function Find-NewAddress($net) {
  if (Get-NetIPAddress -IPAddress $net.Address -ErrorAction SilentlyContinue) { return $null }
  $nets = Get-LanNetworks
  $same = @($nets | Where-Object { $_.Index -eq $net.Index -and -not $_.Virtual })
  if ($same) { return $same[0] }
  $best = Select-LanNetwork $nets '' $false
  if ($best) { return $best }
  return 'lost'
}

# Whether the internet answers: Cloudflare's API (for the record and the certificate). Twice, five seconds each: a
# first try after a while often takes over three seconds (the name looked up afresh).
function Test-Internet {
  foreach ($try in 1, 2) {
    $t = New-Object Net.Sockets.TcpClient
    try { if ($t.ConnectAsync('api.cloudflare.com', 443).Wait(5000) -and $t.Connected) { return $true } } catch {} finally { $t.Close() }
  }
  return $false
}

# Points the public A record at $address (DNS only, TTL 60), for phones and browsers that ask Google or Cloudflare
# instead of the venue's DNS. Returns $null when done, or why not.
function Set-PublicRecord([string]$domain, [string]$address, [string]$token) {
  $zoneName = (($domain -split '\.')[-2..-1]) -join '.'
  try {
    $api = 'https://api.cloudflare.com/client/v4'
    $h = @{ Authorization = "Bearer $token" }
    $zone = @((Invoke-RestMethod -Headers $h -Uri "$api/zones?name=$zoneName" -TimeoutSec 10).result)[0]
    if (-not $zone) { return "the token can't see $zoneName (it needs Zone / Zone / Read)" }
    $rec = @((Invoke-RestMethod -Headers $h -Uri "$api/zones/$($zone.id)/dns_records?type=A&name=$domain" -TimeoutSec 10).result)[0]
    $body = @{ type = 'A'; name = $domain; content = $address; ttl = 60; proxied = $false; comment = 'LAN night (lan.cmd): the host computer on the local network' } | ConvertTo-Json
    if (-not $rec) {
      Invoke-RestMethod -Method Post -Headers $h -ContentType 'application/json' -Uri "$api/zones/$($zone.id)/dns_records" -Body $body -TimeoutSec 10 | Out-Null
    } elseif ($rec.content -ne $address -or $rec.proxied) {
      Invoke-RestMethod -Method Patch -Headers $h -ContentType 'application/json' -Uri "$api/zones/$($zone.id)/dns_records/$($rec.id)" -Body $body -TimeoutSec 10 | Out-Null
    }
    return $null
  } catch {
    if ($_.Exception.Message -match '\((400|401|403)\)') { return 'Cloudflare refused the token. Make a new one and start with: lan.cmd -NewToken' }
    return $_.Exception.Message
  }
}

# Why Caddy can't get its certificate, in words, from its log; $null while it hasn't failed yet.
function Get-CertificateTrouble([string]$log) {
  $text = Get-Content -Raw $log -ErrorAction SilentlyContinue
  if (-not $text -or $text -notmatch 'could not get certificate') { return $null }
  if ($text -match 'adding temporary record|Invalid access token|Authentication error|Invalid request headers') { return 'Cloudflare refused the token. Make a new one and start with: lan.cmd -NewToken' }
  if ($text -match 'rateLimited|too many') { return 'Let''s Encrypt says: too many tries for now. Wait an hour, or use: lan.cmd -Http' }
  if ($text -match 'no such host|i/o timeout|connection refused|dial tcp') { return 'No connection to Let''s Encrypt or Cloudflare. Is there internet?' }
  return 'Caddy could not get the certificate (see its log).'
}

# The A records a DNS server gives for $domain: this computer's own (no server) or a named one. Empty when none.
function Get-NameAnswer([string]$domain, [string]$server = '') {
  try {
    $q = @{ Name = $domain; Type = 'A'; DnsOnly = $true; QuickTimeout = $true; NoHostsFile = $true; ErrorAction = 'Stop' }
    if ($server) { $q.Server = $server }
    return @(Resolve-DnsName @q | Where-Object { $_.Type -eq 'A' } | ForEach-Object { $_.IPAddress })
  } catch { return @() }
}

# Says what this computer's DNS and the public DNS answer for $domain, and what to do when it isn't $address.
function Show-NameCheck([string]$domain, [string]$address, [bool]$online) {
  Clear-DnsClientCache -ErrorAction SilentlyContinue
  $mine = Get-NameAnswer $domain
  if ($mine -contains $address) {
    Write-Host "DNS: $domain points at $address."
  } elseif ($mine.Count) {
    Write-Host "Careful: this network's DNS answers $domain with $($mine -join ', '), not $address."
    Write-Host "  Point it at $address in your DNS (a single record for that name). Just changed? It can take a minute."
  } else {
    Write-Host "Careful: this network's DNS has no answer for $domain. Add a record for it pointing at $address,"
    Write-Host '  or players need the internet to find it through the public record.'
  }
  if ($online) {
    $public = Get-NameAnswer $domain '1.1.1.1'
    if ($public -notcontains $address -and $public.Count) { Write-Host "  (The public DNS still says $($public -join ', '); it follows within a minute.)" }
  }
}

# When the certificate Caddy keeps for $domain runs out, or $null when it has none.
function Get-CertificateEnd([string]$storage, [string]$domain, [bool]$staging) {
  $ca = 'acme-v02.api.letsencrypt.org-directory'
  if ($staging) { $ca = 'acme-staging-v02.api.letsencrypt.org-directory' }
  $file = Join-Path $storage "certificates\$ca\$domain\$domain.crt"
  if (-not (Test-Path $file)) { return $null }
  try {
    $pem = Get-Content -Raw $file
    $m = [regex]::Match($pem, '-----BEGIN CERTIFICATE-----(.+?)-----END CERTIFICATE-----', 'Singleline')
    if (-not $m.Success) { return $null }
    $der = [Convert]::FromBase64String(($m.Groups[1].Value -replace '\s', ''))
    return (New-Object Security.Cryptography.X509Certificates.X509Certificate2(, $der)).NotAfter
  } catch { return $null }
}

# What in Windows would keep players out: the network set to Public, a firewall rule that blocks Caddy (Windows makes
# one when its question about a new program goes unanswered), no rule that lets it in. Offers to fix it all at once
# with one Windows permission prompt. The rule lets in this Caddy only, on private and work networks, never Public.
function Get-WindowsFixes($net, [string]$caddy) {
  $program = (Resolve-Path $caddy).Path
  $ruleName = "Brieltje LAN night ($([IO.Path]::GetFileNameWithoutExtension($program)))"
  $rules = @(Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { $_.Program -eq $program } | Get-NetFirewallRule -ErrorAction SilentlyContinue)
  $blocking = @($rules | Where-Object { $_.Action -eq 'Block' -and $_.Enabled -eq 'True' })
  $allowed = @($rules | Where-Object { $_.Action -eq 'Allow' -and $_.Enabled -eq 'True' -and "$($_.Profile)" -match 'Private|Any' })
  $public = $net -and $net.Category -eq 'Public'
  $todo = @()
  $fix = @()
  if ($public) {
    $todo += "Windows treats the network on $($net.Alias) as Public, which keeps players out."
    $fix += "Set-NetConnectionProfile -InterfaceIndex $($net.Index) -NetworkCategory Private"
  }
  if ($blocking) {
    $todo += 'A firewall rule blocks Caddy (left by an unanswered Windows question).'
    $fix += ($blocking | ForEach-Object { "Remove-NetFirewallRule -Name '$($_.Name -replace "'", "''")'" })
  }
  if (-not $allowed) {
    $todo += 'No firewall rule lets players reach Caddy yet.'
    $fix += "New-NetFirewallRule -DisplayName '$($ruleName -replace "'", "''")' -Direction Inbound -Action Allow -Profile Private,Domain -Program '$($program -replace "'", "''")' | Out-Null"
  }
  [pscustomobject]@{ Todo = $todo; Fix = $fix }
}

function Repair-Windows($net, [string]$caddy, [bool]$ask) {
  $f = Get-WindowsFixes $net $caddy
  $todo = @($f.Todo)
  $fix = @($f.Fix)
  if (-not $todo) { return }
  Write-Host ''
  $todo | ForEach-Object { Write-Host "Careful: $_" }
  if (-not $ask) { Write-Host '  Start lan.cmd yourself to fix it.'; return }
  $yes = Read-Host 'Fix it now? Windows asks for permission once. [Y/n]'
  if ($yes -and $yes -notmatch '^(y|j)') { Write-Host '  Left as it is. Players may not get in.'; return }
  $cmd = ($fix -join '; ')
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes("`$ErrorActionPreference = 'Stop'; $cmd"))
  try {
    $p = Start-Process powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile', '-EncodedCommand', $encoded)
    if ($p.ExitCode -eq 0) { Write-Host '  Fixed.' } else { Write-Host "  That didn't work (code $($p.ExitCode)). Players may not get in." }
  } catch {
    Write-Host '  Not fixed (no permission). Players may not get in.'
  }
}

# Programs other than our Caddy that already listen on the ports Caddy needs. Empty when they are free.
function Get-PortUsers([int[]]$ports, [string]$caddy) {
  $mine = [IO.Path]::GetFileNameWithoutExtension($caddy)
  @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort } | ForEach-Object {
      $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
      [pscustomobject]@{ Port = $_.LocalPort; Name = "$($p.ProcessName)"; Id = $_.OwningProcess; Ours = "$($p.ProcessName)" -eq $mine }
    } | Sort-Object Port, Id -Unique)
}
