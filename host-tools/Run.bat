@echo off
setlocal

set "DASH_PORT=5180"
set "DASH_URL=http://127.0.0.1:%DASH_PORT%/"

if not exist "%~dp0config.bat" (
    echo config.bat not found. Run Setup.bat first.
    echo.
    pause
    exit /b 1
)
if not exist "%~dp0dashboard\index.html" (
    echo Dashboard files not found in "%~dp0dashboard".
    echo That folder should hold the built dashboard: index.html, assets, config.json.
    echo.
    pause
    exit /b 1
)
call "%~dp0config.bat"

if not exist "%PY%" (
    echo ERROR: Python not found at "%PY%". Re-run Setup.bat.
    echo.
    pause
    exit /b 1
)

echo Launching the encoder watcher and the dashboard in their own windows...
echo Close both windows to stop.
start "Anomaly Watcher" cmd /k ""%PY%" "%~dp0host-tools\encode_watcher.py" --ffmpeg "%FFMPEG%" --root "%CAPTURES_ROOT%""
start "Anomaly Dashboard" cmd /k ""%PY%" "%~dp0host-tools\serve_dashboard.py" --directory "%~dp0dashboard" --port %DASH_PORT%"

ping -n 4 127.0.0.1 >nul 2>&1
start "" "%DASH_URL%"

endlocal
