@echo off
cd /d "%~dp0"
echo Iniciando servidor...
start cmd /k "npx serve . -l 3000 --no-clipboard"
timeout /t 3 /nobreak >nul
start "" "http://localhost:3000"
