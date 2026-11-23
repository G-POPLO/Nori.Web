@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
title NoriOS Source App - development entry

echo ============================================================
echo   NoriOS Source App - development entry  /source-app/
echo ============================================================
echo.

REM ---------- 1. Resolve Python interpreter ----------
set "PY="
if exist ".venv\Scripts\python.exe" (
    set "PY=.venv\Scripts\python.exe"
) else (
    where python >nul 2>&1
    if not errorlevel 1 (
        set "PY=python"
    ) else (
        echo [ERROR] Python 3.11+ not found.
        pause
        exit /b 1
    )
)

REM ---------- 2. Rebuild the source app (skip with --no-build) ----------
if /I "%~1"=="--no-build" (
    echo [1/3] Skipping build ^(--no-build^)
    if not exist "public\source-app\index.html" (
        echo [ERROR] no prior build found; run without --no-build once.
        pause
        exit /b 1
    )
) else (
    echo [1/3] Building source app -^> public\source-app\
    call npm run build:source-app
    if errorlevel 1 (
        echo [ERROR] source app build failed.
        pause
        exit /b 1
    )
)

REM ---------- 3. Pick content pack ----------
echo [2/3] Content pack
set "NORI_PACK_PATH="
if /I "%~2"=="--my-world" (
    if not exist "backend\data\my_world_pack.json" (
        echo [ERROR] my_world_pack.json missing.
        pause
        exit /b 1
    )
    set "NORI_PACK_PATH=%CD%\backend\data\my_world_pack.json"
    echo       Pack: my_world_pack.json  ^(your own content^)
) else if /I "%~1"=="--my-world" (
    if not exist "backend\data\my_world_pack.json" (
        echo [ERROR] my_world_pack.json missing.
        pause
        exit /b 1
    )
    set "NORI_PACK_PATH=%CD%\backend\data\my_world_pack.json"
    echo       Pack: my_world_pack.json  ^(your own content^)
) else (
    echo       Pack: live_world_pack.json  ^(built-in archive^)
)

REM ---------- 4. Warn about cache ----------
echo [3/3] Starting server
echo.
echo   Production entry : http://127.0.0.1:4173/
echo   Source app       : http://127.0.0.1:4173/source-app/
echo.
echo   NOTE: hard-refresh with Ctrl+Shift+R after a rebuild.
echo         Press Ctrl+C to stop.
echo.

start "" http://127.0.0.1:4173/source-app/
"!PY!" server.py

echo.
echo Server stopped.
pause
