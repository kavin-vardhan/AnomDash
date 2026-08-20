@echo off
setlocal

echo ============================================================
echo   Build a client delivery bundle
echo ============================================================
echo.
echo   This is a DEV TOOL. It never ships to the client.
echo   It copies exactly what host-tools\bundle_manifest.txt lists.
echo.

set "PY="
for /f "delims=" %%I in ('where py 2^>nul') do if not defined PY set "PY=%%~fI"
if not defined PY for /f "delims=" %%I in ('where python 2^>nul') do if not defined PY set "PY=%%~fI"
if not defined PY (
    echo ERROR: Python 3 was not found on PATH.
    echo.
    pause
    exit /b 1
)

set "DEST="
set /p "DEST=Destination folder for the bundle (created if missing): "
if not defined DEST (
    echo No destination given. Nothing was done.
    echo.
    pause
    exit /b 1
)
set "DEST=%DEST:"=%"

echo.
"%PY%" "%~dp0make_delivery.py" --dest "%DEST%"
set "RC=%errorlevel%"

echo.
if not "%RC%"=="0" (
    echo Bundle NOT created - see the message above.
) else (
    echo Bundle ready. Deliver the whole folder as-is.
)
echo.
pause
endlocal
exit /b %RC%
