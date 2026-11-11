@echo off
rem A LAN night on this computer: double-click. Starts the game in Docker and Caddy in front of it (lan/start.ps1,
rem lan/compose.yaml, lan/Caddyfile): asks for tonight's admin password, players type https://lan.brieltje.be, and
rem Enter stops it. Options: -Address <ip>, -Domain <name>, -NewToken, -Staging, -Http [-Port 8090].
rem Without Docker: cd web, then npm run lan.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0lan\start.ps1" %*
pause
