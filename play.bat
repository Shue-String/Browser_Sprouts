@echo off
start /min cmd /c "cd /d "%~dp0" && npm run dev"
timeout /t 2 /nobreak >nul
start http://localhost:5173/
