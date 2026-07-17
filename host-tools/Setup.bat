@echo off
setlocal enabledelayedexpansion

set "FFMPEG_URL=https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"

set "ROOT=%~dp0"
set "DASHBOARD=%ROOT%dashboard"
set "HOSTTOOLS=%ROOT%host-tools"
set "FFDIR=%HOSTTOOLS%\ffmpeg"
set "CONFIG=%ROOT%config.bat"

echo ============================================================
echo   Anomaly capture - one-time setup
echo ============================================================
echo.

if not exist "%DASHBOARD%\package.json" (
    echo ERROR: dashboard folder not found at "%DASHBOARD%".
    echo Setup.bat must sit at the delivery root, next to the dashboard and host-tools folders.
    echo.
    pause
    exit /b 1
)
if not exist "%HOSTTOOLS%\encode_watcher.py" (
    echo ERROR: host-tools folder not found at "%HOSTTOOLS%".
    echo Setup.bat must sit at the delivery root, next to the dashboard and host-tools folders.
    echo.
    pause
    exit /b 1
)

echo [1/4] Locating ffmpeg...
set "FFMPEG="
for /f "delims=" %%I in ('where ffmpeg 2^>nul') do if not defined FFMPEG set "FFMPEG=%%~fI"
if defined FFMPEG (
    echo       found on PATH: !FFMPEG!
    goto ffmpeg_done
)
call :find_ffmpeg_local
if defined FFMPEG (
    echo       found from a previous setup: !FFMPEG!
    goto ffmpeg_done
)
echo       ffmpeg was not found.
choice /m "Download ffmpeg now"
if not !errorlevel! EQU 1 goto ffmpeg_skip
if not exist "%FFDIR%" mkdir "%FFDIR%"
set "ZIP=%FFDIR%\ffmpeg.zip"
del "%ZIP%" >nul 2>&1
echo       downloading...
curl.exe -L -o "%ZIP%" "%FFMPEG_URL%"
set "CURLRC=!errorlevel!"
call :zip_ok
if "!CURLRC!"=="0" if defined ZIPOK goto ffmpeg_extract
echo       Standard download failed (likely a corporate-network revocation check); retrying with revocation check disabled...
del "%ZIP%" >nul 2>&1
curl.exe -L --ssl-no-revoke -o "%ZIP%" "%FFMPEG_URL%"
set "CURLRC=!errorlevel!"
call :zip_ok
if "!CURLRC!"=="0" if defined ZIPOK goto ffmpeg_extract
goto ffmpeg_dlfail

:ffmpeg_extract
echo       extracting...
tar -xf "%ZIP%" -C "%FFDIR%"
del "%ZIP%" >nul 2>&1
call :find_ffmpeg_local
if defined FFMPEG (
    echo       installed: !FFMPEG!
    goto ffmpeg_done
)
echo       ERROR: ffmpeg.exe not found after extraction. Continuing without ffmpeg.
goto ffmpeg_done

:ffmpeg_dlfail
echo       ERROR: download failed. Continuing without ffmpeg - captures stay valid; encode later.
goto ffmpeg_done

:ffmpeg_skip
echo       Skipping ffmpeg. Install it and add its bin folder to PATH, then re-run Setup.bat,
echo       or re-run Setup.bat and choose Y to download. The watcher still runs without ffmpeg:
echo       captures stay valid and encode later.

:ffmpeg_done
echo.
echo [2/4] Locating Python...
set "PY="
for /f "delims=" %%I in ('where py 2^>nul') do if not defined PY set "PY=%%~fI"
if not defined PY for /f "delims=" %%I in ('where python 2^>nul') do if not defined PY set "PY=%%~fI"
if not defined PY goto no_python
echo       using: !PY!
goto python_done

:no_python
echo       ERROR: Python 3 was not found on PATH.
echo       Install Python 3 from https://python.org and tick "Add Python to PATH", then re-run Setup.bat.
echo.
pause
exit /b 1

:python_done
echo.
echo [3/4] Captures directory...

:ask_captures
set "CAPTURES_ROOT="
set /p "CAPTURES_ROOT=Enter the folder where captures should be saved (any folder; created if missing): "
if not defined CAPTURES_ROOT (
    echo       Please enter a path.
    goto ask_captures
)
set "CAPTURES_ROOT=!CAPTURES_ROOT:"=!"
for %%P in ("!CAPTURES_ROOT!") do set "PARENT=%%~dpP"
if not exist "!PARENT!" (
    echo       Parent folder "!PARENT!" does not exist - check the path and try again.
    goto ask_captures
)
if exist "!CAPTURES_ROOT!" goto captures_ok
choice /m "That folder does not exist yet. Create it now"
if not !errorlevel! EQU 1 goto ask_captures
mkdir "!CAPTURES_ROOT!"
if errorlevel 1 (
    echo       Could not create it - try again.
    goto ask_captures
)

:captures_ok
echo       captures root: !CAPTURES_ROOT!
echo.
echo [4/4] Installing dashboard dependencies...
pushd "%DASHBOARD%"
call npm.cmd install
set "NPMERR=!errorlevel!"
popd
if not "!NPMERR!"=="0" echo       WARNING: npm install reported an error (exit !NPMERR!). You can re-run Setup.bat.

echo.
echo Writing config...
> "%CONFIG%" echo set "FFMPEG=!FFMPEG!"
>> "%CONFIG%" echo set "CAPTURES_ROOT=!CAPTURES_ROOT!"
>> "%CONFIG%" echo set "PY=!PY!"
set "CR_FWD=!CAPTURES_ROOT:\=/!"
> "%DASHBOARD%\.env.local" echo VITE_CAPTURES_ROOT=!CR_FWD!

echo.
echo ============================================================
echo   Setup complete.  Next: double-click Run.bat
echo   (opens the encoder watcher + the dashboard, and your browser).
echo ============================================================
echo.
pause
endlocal
exit /b 0

:find_ffmpeg_local
for /f "delims=" %%I in ('dir /s /b "%FFDIR%\ffmpeg.exe" 2^>nul') do if not defined FFMPEG set "FFMPEG=%%~fI"
goto :eof

:zip_ok
set "ZIPOK="
if exist "%ZIP%" for %%A in ("%ZIP%") do if %%~zA GTR 0 set "ZIPOK=1"
goto :eof
