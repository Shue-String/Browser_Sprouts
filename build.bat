@echo off
cd /d "%~dp0"

echo === Building native Stalks engine (stalks_tests.exe) ===
call "%~dp0stalks\build.bat"
if errorlevel 1 (
  echo.
  echo Native Stalks build FAILED.
  pause
  exit /b 1
)

echo.
echo === Building Stalks WASM engine (src\engine\stalksWasm.js) ===
call "C:\Users\Chordus\emsdk\emsdk_env.bat" >nul
if errorlevel 1 (
  echo.
  echo emsdk_env.bat FAILED -- is the Emscripten SDK installed at C:\Users\Chordus\emsdk?
  pause
  exit /b 1
)
call "%~dp0stalks\build_wasm.bat"
if errorlevel 1 (
  echo.
  echo WASM build FAILED.
  pause
  exit /b 1
)
cd /d "%~dp0"

echo.
echo === Building frontend (dist\index.html) ===
call npm run build
if errorlevel 1 (
  echo.
  echo Frontend build FAILED.
  pause
  exit /b 1
)

echo.
echo === All builds succeeded. ===
pause
