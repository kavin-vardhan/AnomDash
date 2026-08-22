@echo off
setlocal

set "SERVEDIR=%~dp0dashboard"
set "PORT=5180"
set "URL=http://127.0.0.1:%PORT%/"

if not exist "%~dp0config.bat" (
    echo config.bat not found. Run Setup.bat first.
    echo.
    pause
    exit /b 1
)
if not exist "%SERVEDIR%\index.html" (
    echo ERROR: dashboard\index.html not found next to Run.bat.
    echo The delivery folder should contain Setup.bat, Run.bat, dashboard\ and host-tools\.
    echo.
    pause
    exit /b 1
)
if not exist "%SERVEDIR%\config.json" (
    echo ERROR: dashboard\config.json not found. Re-run Setup.bat - it creates it.
    echo Without it the dashboard loads but cannot connect to the game.
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

set "HEARTBEAT=%~dp0.watcher_alive"

echo Launching the encoder watcher, the overlay inspector and the dashboard server...
echo Close all three windows to stop.
start "Anomaly Watcher" cmd /k ""%PY%" "%~dp0host-tools\encode_watcher.py" --ffmpeg "%FFMPEG%" --root "%CAPTURES_ROOT%" --heartbeat "%HEARTBEAT%""
start "Anomaly Overlay Inspector" cmd /k ""%PY%" "%~dp0host-tools\overlay_watcher.py" --root "%CAPTURES_ROOT%" --script "%~dp0host-tools\verify_capture.py""
start "Anomaly Dashboard Server" cmd /k ""%PY%" "%~dp0host-tools\serve_dashboard.py" --directory "%SERVEDIR%" --port %PORT%"

ping -n 4 127.0.0.1 >nul 2>&1
start "" "%URL%"

ping -n 3 127.0.0.1 >nul 2>&1

"%PY%" "%~dp0host-tools\selfcheck.py" --dashboard-port %PORT% --heartbeat "%HEARTBEAT%"

echo.
echo The dashboard is at %URL% - leave the three windows open while you capture.
echo This window can be closed.
pause
endlocal
