@echo off
setlocal
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
    echo.
    echo ERROR: Node.js was not found on this computer.
    echo Please install it from https://nodejs.org, then run runTest.bat again.
    echo.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo First-time setup: installing dependencies, this may take a minute...
    call npm install
    if errorlevel 1 (
        echo.
        echo ERROR: npm install failed - see the messages above.
        echo.
        pause
        exit /b 1
    )
)

start "Sprouts dev server" cmd /k "cd /d "%~dp0" && npm run dev -- --port 5173 --strictPort"
timeout /t 3 /nobreak >nul
start http://localhost:5173/

endlocal
