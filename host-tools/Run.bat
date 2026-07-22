@echo off
setlocal

set "APP=%~dp0Dashboard.exe"

if not exist "%~dp0config.bat" (
    echo config.bat not found. Run Setup.bat first.
    echo.
    pause
    exit /b 1
)
if not exist "%APP%" (
    echo Dashboard.exe not found next to Run.bat.
    echo The delivery folder should contain Dashboard.exe and config.json at its root.
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

echo Launching the encoder watcher and the dashboard app...
echo Close the app window and the watcher window to stop.
start "Anomaly Watcher" cmd /k ""%PY%" "%~dp0host-tools\encode_watcher.py" --ffmpeg "%FFMPEG%" --root "%CAPTURES_ROOT%" --heartbeat "%HEARTBEAT%""
start "" "%APP%"

ping -n 5 127.0.0.1 >nul 2>&1

"%PY%" "%~dp0host-tools\selfcheck.py" --dashboard-exe Dashboard.exe --heartbeat "%HEARTBEAT%"

echo Leave the app and watcher windows open while you capture. This window can be closed.
pause
endlocal
