@echo off
setlocal

set "PY=C:\Python313\python.exe"
set "SCRIPT=%~dp0encode_watcher.py"
set "FFMPEG=E:\Downloads\ffmpeg-8.1.2-full_build\ffmpeg-8.1.2-full_build\bin"

if not exist "%PY%" (
    echo.
    echo ERROR: Python interpreter not found at %PY%
    echo Edit the PY line in this .bat to point at your Python 3, then run it again.
    echo.
    pause
    exit /b 1
)

if not exist "%SCRIPT%" (
    echo.
    echo ERROR: encode_watcher.py not found at %SCRIPT%
    echo.
    pause
    exit /b 1
)

echo Encode watcher running - leave this window open; close it when done capturing.
echo.
"%PY%" "%SCRIPT%" --ffmpeg "%FFMPEG%" %*
