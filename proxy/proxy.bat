@echo off
chcp 65001 >nul
title YGOPro proxy
cd /d "%~dp0"

rem Prefer the packaged form: if yrp.exe sits next to this file, use it.
rem (A released copy has no .js files, and that machine may not have Node.)
rem WARNING: the arguments below must stay in sync with the other launchers,
rem and the role must be exact -- the default role is the GUI, so writing
rem --role=gui here would launch the web UI instead of the proxy.
if exist "yrp.exe" goto useexe

where node >nul 2>nul
if errorlevel 1 goto nonode

node proxy.js
goto done

:useexe
yrp.exe --role=proxy
goto done

:nonode
echo.
echo   [!] Node.js was not found on this computer.
echo.
echo   This proxy needs Node.js to run. Download the LTS version from
echo   https://nodejs.org (click Next through the installer), then run
echo   this file again.
echo.
pause
exit /b 1

:done
echo.
pause
exit /b 0
