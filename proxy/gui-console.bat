@echo off
rem Development launcher: starts the app WITH a console attached, so Electron's
rem own warnings and anything printed by the main process stay visible.
rem Use it when something is wrong and you need to read the error.
rem
rem For everyday use there is nothing to launch: double-click the packaged
rem yrp-tools.exe (built by `npm run dist`). No console, no browser.
chcp 65001 >nul
cd /d "%~dp0.."

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
call npx electron .
echo.
echo The UI has stopped. You can close this window.
pause
