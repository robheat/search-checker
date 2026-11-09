@echo off
setlocal
title Search Checker
cd /d "%~dp0"

echo.
echo   Search Checker
echo   ==============
echo.

rem --- 1. Node.js -------------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js is not installed.
  echo   Install the LTS version from https://nodejs.org - opening it for you now -
  echo   then double-click start.bat again.
  echo.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)
for /f "tokens=1 delims=v." %%v in ('node -v') do set "NODE_MAJOR=%%v"
if %NODE_MAJOR% LSS 18 (
  echo   Your Node.js is too old. Search Checker needs version 18 or newer.
  echo   Install the LTS version from https://nodejs.org and try again.
  echo.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)

rem --- 2. Dependencies + Chromium: first run, or after an update -------------
rem The installed package-lock.json is remembered; if it changes, reinstall.
set "NEEDS_INSTALL="
if not exist "node_modules\" set "NEEDS_INSTALL=1"
if not exist "node_modules\.installed-lock.json" set "NEEDS_INSTALL=1"
if not defined NEEDS_INSTALL (
  fc /b "package-lock.json" "node_modules\.installed-lock.json" >nul 2>nul
  if errorlevel 1 set "NEEDS_INSTALL=1"
)

if defined NEEDS_INSTALL (
  echo   Installing dependencies - first run only, this takes a minute...
  echo.
  call npm install --no-audit --no-fund
  if errorlevel 1 goto :install_failed
  echo.
  echo   Downloading the Chromium browser - first run only, about 150 MB...
  echo.
  call node "node_modules\playwright\cli.js" install chromium
  if errorlevel 1 goto :install_failed
  copy /y "package-lock.json" "node_modules\.installed-lock.json" >nul
  echo.
)

rem --- 3. Run -----------------------------------------------------------------
echo   Starting... your browser will open automatically.
echo   Keep this window open while you use the app. Close it to stop.
node "src\server.js" --open
set "EXIT_CODE=%errorlevel%"

if "%EXIT_CODE%"=="2" (
  rem Already running: the server opened the existing app in the browser.
  timeout /t 6 >nul
  exit /b 0
)
if not "%EXIT_CODE%"=="0" (
  echo.
  echo   Search Checker stopped with an error - see the messages above.
  pause
)
exit /b %EXIT_CODE%

:install_failed
echo.
echo   Installation failed - see the messages above.
echo   Check your internet connection, then double-click start.bat again.
echo.
pause
exit /b 1
