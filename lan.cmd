@echo off
rem A LAN night on this computer: double-click. Builds the game if needed, asks for tonight's admin password,
rem starts the server and shows the address players type (web/lan.mjs).
cd /d "%~dp0web"
node lan.mjs %*
pause
