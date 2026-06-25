@echo off
setlocal

set "PY=C:\Python313\python.exe"
set "SCRIPT=%~dp0overlay_watcher.py"

if not exist "%PY%" (
    echo.
    echo ERROR: Python interpreter not found at %PY%
    echo This launcher needs the Pillow-equipped Python at C:\Python313\python.exe.
    echo Edit the PY line in this .bat to point at your Python, then run it again.
    echo.
    pause
    exit /b 1
)

if not exist "%SCRIPT%" (
    echo.
    echo ERROR: overlay_watcher.py not found at %SCRIPT%
    echo.
    pause
    exit /b 1
)

echo Overlay watcher running - leave this window open; close it when done capturing.
echo.
"%PY%" "%SCRIPT%" %*
