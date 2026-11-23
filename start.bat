@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
title NoriOS Local Compatibility Server

echo ============================================================
echo   NoriOS Local Compatibility Server - One-Click Launcher
echo ============================================================
echo.

REM ---------- 1. Resolve Python interpreter ----------
if exist ".venv\Scripts\python.exe" (
    set "PY=.venv\Scripts\python.exe"
    echo [1/4] Using virtual environment: .venv
    goto :deps
)

echo [1/4] Virtual environment not found.
where uv >nul 2>&1
if not errorlevel 1 (
    echo       uv found. Creating .venv and installing local dependencies...
    uv sync --extra local
    if errorlevel 1 (
        echo [ERROR] uv sync failed.
        goto :fail
    )
    if exist ".venv\Scripts\python.exe" (
        set "PY=.venv\Scripts\python.exe"
        goto :deps
    )
)

where python >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python 3.11+ is required but was not found.
    goto :fail
)
set "PY=python"
echo       Falling back to system Python.

:deps
echo [2/4] Checking dependencies...
"!PY!" -c "import fastapi, uvicorn, httpx, chess" >nul 2>&1
if errorlevel 1 (
    echo       Dependencies missing. Installing with pip...
    "!PY!" -m pip install -e ".[local]"
    if errorlevel 1 (
        echo [ERROR] Dependency installation failed.
        goto :fail
    )
)
echo       Dependencies OK.

echo [3/4] Checking port 4173...
netstat -ano | findstr ":4173" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo       Port 4173 is already in use. The server may already be running.
    start "" http://127.0.0.1:4173
    echo       Opened http://127.0.0.1:4173 in your browser.
    echo.
    pause
    exit /b 0
)
echo       Port 4173 is free.

echo [4/4] Starting server...
echo.
echo   URL:       http://127.0.0.1:4173
echo   WebSocket: ws://127.0.0.1:4173/api/arcade/web/v1
echo   Press Ctrl+C to stop.
echo.

if /I "%~1"=="--my-world" (
    if not exist "backend\data\my_world_pack.json" (
        echo [ERROR] backend\data\my_world_pack.json not found.
        echo         Run: python tools\compose_pack.py --out backend\data\my_world_pack.json
        pause
        exit /b 1
    )
    echo   Pack:      my_world_pack.json  ^(your own content^)
    set "NORI_PACK_PATH=%CD%\backend\data\my_world_pack.json"
) else (
    echo   Pack:      live_world_pack.json  ^(built-in archive^)
)

start "" http://127.0.0.1:4173
"!PY!" server.py

echo.
echo Server stopped.
pause
exit /b 0

:fail
echo.
echo Startup failed. Please check the messages above.
pause
exit /b 1
