@echo off
rem Build the Stalks engine to a single self-contained ES module for the browser (Position
rem Browser). Requires the Emscripten SDK on PATH (run emsdk_env.bat first).
rem
rem Output: ..\src\engine\stalksWasm.js  -- MODULARIZE + EXPORT_ES6 factory, with the .wasm inlined
rem as base64 (SINGLE_FILE), so it needs no separate asset and works in the viteSingleFile build.
rem The name deliberately differs from the stalks.ts wrapper: a sibling "stalks.js" would collide
rem with "stalks.ts" under bundler/TS resolution (./stalks.js resolves to the .ts, not the artifact).
rem
rem The default export is an async factory; see src/engine/stalksWasm.d.ts / stalks.ts for usage.

setlocal
cd /d "%~dp0"

if not exist "..\src\engine" mkdir "..\src\engine"

rem Fixed heap (no ALLOW_MEMORY_GROWTH). With growth, Emscripten 6 backs the heap with a *resizable*
rem ArrayBuffer, and Firefox's TextDecoder.decode() rejects views over resizable buffers -- it throws
rem when embind decodes a returned std::string. (TEXTDECODER=0, the old JS-decode fallback, was removed
rem in Emscripten 6.) A fixed, non-resizable heap decodes fine on every browser. 256MB is far above the
rem worst realistic case (largest <=12-life analysis is ~tens of MB); it is reserved lazily by the OS
rem and only when the engine instantiates (i.e. when the Position Browser is first opened).
emcc ^
  -std=c++20 -O2 -fexceptions --bind ^
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sSINGLE_FILE=1 -sINITIAL_MEMORY=256MB ^
  -sEXPORT_NAME=createStalksModule ^
  -sENVIRONMENT=web ^
  -I src ^
  src/boundary.cpp src/position.cpp src/encoding.cpp src/moves.cpp ^
  src/canon.cpp src/collections.cpp src/graph.cpp src/analyze.cpp src/wasm_api.cpp ^
  -o ..\src\engine\stalksWasm.js

if errorlevel 1 (
  echo.
  echo BUILD FAILED. Ensure the Emscripten SDK is installed and emsdk_env.bat has been run.
  exit /b 1
)

echo.
echo Built ..\src\engine\stalksWasm.js
endlocal
