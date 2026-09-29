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

set "PLUGINREPO="
set /p "PLUGINREPO=AnomalyInjector plugin repo folder (Enter = none, dashboard-only bundle): "
if defined PLUGINREPO set "PLUGINREPO=%PLUGINREPO:"=%"

set "TOKENLOG="
set /p "TOKENLOG=A log of the DELIVERED game build, for the dashboard token (Enter = none): "
if defined TOKENLOG set "TOKENLOG=%TOKENLOG:"=%"

set "ARGS=--dest "%DEST%""
if defined PLUGINREPO set "ARGS=%ARGS% --plugin-repo "%PLUGINREPO%""
if defined TOKENLOG set "ARGS=%ARGS% --token-log "%TOKENLOG%""

echo.
"%PY%" "%~dp0make_delivery.py" %ARGS%
set "RC=%errorlevel%"

echo.
if "%RC%"=="0" (
    echo Bundle COMPLETE. Deliver the whole folder as-is.
) else if "%RC%"=="4" (
    echo Bundle built but NOT COMPLETE - see ACTION REQUIRED above. Do not deliver it as-is.
) else (
    echo Bundle NOT created - see the message above.
)
echo.
pause
endlocal
exit /b %RC%
