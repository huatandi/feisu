@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
 echo Please install Node.js 18 or newer, then run this file again.
 pause
 exit /b 1
)
start "" http://127.0.0.1:18749
node local-server.cjs
pause
