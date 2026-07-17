@echo off
setlocal

if not exist "%~dp0config.bat" (
    echo config.bat not found. Run Setup.bat first.
    echo.
    pause
    exit /b 1
)
if not exist "%~dp0dashboard\node_modules" (
    echo Dashboard dependencies not installed. Run Setup.bat first.
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
start "Anomaly Dashboard" /D "%~dp0dashboard" cmd /k "npm.cmd run dev -- --open"

endlocal
