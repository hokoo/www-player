@echo off
setlocal enableextensions enabledelayedexpansion

rem Use UTF-8 to display messages correctly
chcp 65001 >nul

rem Change to repository directory
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install Node.js v18 or newer: https://nodejs.org/
  pause
  exit /b 1
)

echo Starting CHGK player...
start "" "http://localhost:3000/"

rem Start server
npm start

endlocal
