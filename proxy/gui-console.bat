@echo off
rem Same thing as START.vbs, except this one KEEPS the console window:
rem node's log output and the launch arguments stay visible. Use it when
rem something is wrong and you need to read the error.
rem For everyday use, double-click START.vbs instead (no window at all).
chcp 65001 >nul
cd /d "%~dp0"

rem Prefer the packaged form: if yrp.exe sits next to this file, use it.
if exist "yrp.exe" goto useexe

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js was not found.
  echo Install it from https://nodejs.org/ and run this file again.
  echo.
  pause
  exit /b 1
)

title YGO Chat Recorder - UI (console)
node gui.js
goto done

:useexe
title YGO Chat Recorder - UI (console)
yrp.exe --role=gui
goto done

:done
echo.
echo The UI has stopped. You can close this window.
pause
