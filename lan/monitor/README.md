# The server's dashboards on a LAN night

`lan.cmd -Monitor` starts two more containers beside the game: Prometheus, which reads the game server's own numbers
every 2 seconds and keeps them for two days, and Grafana, which shows them. Without `-Monitor` nothing changes.

## On the night

1. Start Docker Desktop. Wait until it runs.
2. In a terminal in the game's folder: `.\lan.cmd -Monitor`. Answer its questions as always.
3. On this computer, open <http://localhost:3030>. Log in as `admin` with tonight's admin password.
4. **Game night** opens. On a second monitor, use <http://localhost:3030/d/brieltje-game-night?kiosk>
   (full screen, no menus).
5. After the evening: **After the night** (Dashboards, Brieltje) shows it all again, per minute, for two days.

Another port: `.\lan.cmd -Monitor -MonitorPort 3031`.

## What the colours mean

The tile at the top left is the verdict, from the game's tick and the event loop, the worst of the last 10 seconds
(a spike keeps its colour long enough to be seen, and the tile doesn't flicker).

| Tile | What it means | What to do |
|---|---|---|
| **All good** (green) | The tick's p99 is under 30 ms, the event loop's delay under 50 ms. | Nothing. |
| **Busy** (orange) | The tick's p99 is over 30 ms, or the loop's delay over 50 ms. Players don't feel it yet. | Nothing yet. |
| **Slow** (red) | The tick's p99 is over 45 ms (its budget is 50), or the loop's delay over 100 ms. | Red for more than a few seconds: close the big screen's extra watch views first. Who lags is on the host page. |
| **No answer** (red) | Prometheus could not read the game. | Look at the lan.cmd window. Docker restarts the game after a crash. |

The blue bands across the charts are the games being played (Zombies, Steal the flag...). A spike reads against them.

## What is measured

The game server (`web/server/metrics.mjs`, `web/server/linkQuality.mjs`), counts only. No player's name, address,
session or text is in any number or label.

| Number | What it tells you |
|---|---|
| `brieltje_tick_seconds{stat}` | A game tick's mean, p99 and slowest since the last scrape. Over 50 ms everyone stutters. |
| `brieltje_tick_duration_seconds` | Every tick as a histogram, for the evening's percentiles. |
| `brieltje_ticks_slow_total{over}` | Ticks over 30 ms and over 50 ms since the start. |
| `brieltje_event_loop_delay_seconds{stat}` | How late the server runs anything: a busy loop answers everyone late. |
| `brieltje_event_loop_utilization` | The share of time the server was busy (1 = one core full). |
| `brieltje_players{place}` | Players in the house (the open world), in players' rooms, in the duel's rooms. |
| `brieltje_games{place}`, `brieltje_watchers` | Games running; the admin's watch views open. |
| `brieltje_game_on{place,kind,phase}` | The game being played. It draws the bands. |
| `brieltje_zombies_up{place}`, `brieltje_vehicles_in_use{kind}` | Zombies standing; cars, bikes, horses, helicopters in use. |
| `brieltje_ws_opened_total`, `brieltje_ws_closed_total{why}` | Connections opened and closed: the page left, the server closed it, or it was lost. |
| `brieltje_reconnects_total` | Players back after their connection was lost. |
| `brieltje_link_rtt_seconds{stat}` | The players' round trip to the server: median, p95, slowest. Over 150 ms a player feels it. |
| `brieltje_link_slow_players` | How many players are over 150 ms now. |
| `brieltje_link_pongs_missed_total` | Pings a page did not answer within 2 s: Wi-Fi trouble. |
| `brieltje_messages_in_total{type}` | Messages from the pages, by the server's own list of types. |
| `brieltje_messages_dropped_total` | Messages dropped by the rate limits: a page sends too fast. |
| `brieltje_bytes_in_total`, `brieltje_bytes_out_total`, `brieltje_messages_out_total` | What the game receives and sends. |
| `brieltje_http_requests_total{code}`, `brieltje_static_bytes_total` | HTTP answers by class, and the game's files sent (the first load of 30 phones is the evening's heaviest moment). |
| `process_resident_memory_bytes`, `brieltje_heap_*`, `brieltje_external_bytes`, `brieltje_array_buffers_bytes` | The server's memory. |
| `process_cpu_*_seconds_total` | The server's processor time. |
| `brieltje_gc_total{kind}`, `brieltje_gc_seconds_total{kind}`, `brieltje_gc_pause_max_seconds` | Garbage collections and their pauses. |
| `process_start_time_seconds`, `brieltje_uptime_seconds` | When the server started. |
| `brieltje_metrics_build_seconds` | What the previous scrape cost the server. |

## This PC's own numbers (optional)

From inside Docker, Prometheus sees Docker's Linux layer, not Windows. `windows_exporter` (MIT licence, from the
Prometheus community) runs on Windows and adds the PC's processor, memory, network adapters and disk. Prometheus
already asks for it (`host.docker.internal:9182`); without it that target is just down and the dashboard's PC
panels say so.

To add it, as an ordinary program for the evening (no service, no firewall change):

1. Download `windows_exporter-<version>-amd64.exe` and `sha256sums.txt` from the official release page:
   <https://github.com/prometheus-community/windows_exporter/releases> (tested with 0.32.1).
2. Check it: `(Get-FileHash .\windows_exporter-0.32.1-amd64.exe).Hash` must equal its line in `sha256sums.txt`
   (upper or lower case does not matter).
3. Start it, bound to this PC only (127.0.0.1: nobody on the hall's network reaches it; Docker Desktop still
   passes Prometheus through to it):

   ```
   .\windows_exporter-0.32.1-amd64.exe --web.listen-address=127.0.0.1:9182 --collectors.enabled=cpu,memory,net,logical_disk,system,os
   ```

4. Leave its window open. To stop it: close that window, or Ctrl+C in it. Nothing is installed: delete the file to
   remove it.

The release also has an `.msi` that installs it as a Windows service and opens the firewall for it. Don't use that
here: it listens on every network and stays after the night.

## Where it listens

| What | Where | From the hall's network |
|---|---|---|
| The game (players) | Caddy on this PC, port 443 (or `-Http`'s port) | Yes, as always |
| The game's metrics | port 9464 inside the compose network only (not published) | No |
| Prometheus | port 9090 inside the compose network only (not published) | No |
| Grafana | 127.0.0.1:3030 on this PC | No |
| windows_exporter (if you run it) | 127.0.0.1:9182 on this PC | No |

On brieltje.be (Railway) `METRICS_PORT` is not set: no metrics listener runs there.

Grafana: anonymous access off, sign-up off, only `admin` with tonight's password (`start.ps1` sets it again at every
start, through the container's standard input). Nothing phones home and nothing needs the internet on the night:
usage reports, update checks (Grafana's and the plugins'), the plugin catalogue and preinstalled plugins, plugin
signing keys fetched online, gravatar pictures, the news feed, feedback links, external snapshots, public dashboards
and cloud migration are all off (`compose.yaml`). Every panel the dashboards use ships with Grafana. The alerts only
colour the dashboard and fill Grafana's own alert list: no contact point is set up and there is no mail server.

## The versions

| Image | Version | Digest | Licence |
|---|---|---|---|
| `prom/prometheus` | v3.13.5 (long-term support until July 2027) | `sha256:aafa9d694e6a883c02db516d9f6e5b84e14195f49a2a6456a4cca815edda72b9` | Apache-2.0 |
| `grafana/grafana` (OSS) | 13.3.1 | `sha256:0615ec4fbd4072004b7d86b46ded63013a74b7d6eb1119273dd89e8fa25c13cf` | AGPL-3.0 |

Both run unmodified, on this PC, for its owner: nothing of theirs is changed or offered to others, so neither licence
asks for anything to be published. Change a version only together with its digest (`docker buildx imagetools inspect
<image>:<tag>`), after reading its release notes.

## Changing the dashboards

They are made by `node lan/monitor/dashboards.mjs` into `grafana/dashboards/`. Changes made in Grafana's screens are not
kept: change `dashboards.mjs`, run it, and start again.
