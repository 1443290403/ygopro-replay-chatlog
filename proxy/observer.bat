@echo off
chcp 65001 >nul
title YGOPro observer
cd /d "%~dp0"

rem Prefer the packaged form: if yrp.exe sits next to this file, use it.
rem WARNING: the role must be exact and must not be omitted -- the default
rem role is the GUI, so a missing role would launch the web UI instead of
rem the observer.
if exist "yrp.exe" goto useexe

where node >nul 2>nul
if errorlevel 1 goto nonode

node observer.js
goto done

:useexe
yrp.exe --role=observer
goto done

:nonode
echo.
echo   [!] Node.js was not found on this computer.
echo.
echo   The observer needs Node.js to run. Download the LTS version from
echo   https://nodejs.org (click Next through the installer), then run
echo   this file again.
echo.
pause
exit /b 1

:done
echo.
pause
exit /b 0
