@echo off
setlocal
rem Build + test the stalks engine using VS Build Tools 2026 (no global installs needed).

set "BT=C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools"
set "CMAKE=%BT%\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
set "NINJA=%BT%\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe"

call "%BT%\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b 1

"%CMAKE%" -S "%~dp0." -B "%~dp0build" -G Ninja ^
    -DCMAKE_MAKE_PROGRAM="%NINJA%" -DCMAKE_BUILD_TYPE=Release
if errorlevel 1 exit /b 1

"%CMAKE%" --build "%~dp0build"
if errorlevel 1 exit /b 1

"%~dp0build\stalks_tests.exe"
