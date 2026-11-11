@echo off
rem A LAN night on this computer: double-click. Starts the game in Docker (lan/start.ps1, lan/compose.yaml): asks for
rem tonight's admin password, shows the address players type, and stops the game when you press Enter.
rem Another port: lan.cmd -Port 8090. Without Docker: cd web, then npm run lan.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0lan\start.ps1" %*
pause
