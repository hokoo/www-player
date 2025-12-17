@echo off
setlocal enableextensions enabledelayedexpansion

rem Change to repository directory
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js не найден. Установите Node.js версии 18 или новее: https://nodejs.org/
  pause
  exit /b 1
)

echo Запускаем ЧГК плеер...
start "" "http://localhost:3000/"

rem Стартуем сервер
npm start

endlocal
