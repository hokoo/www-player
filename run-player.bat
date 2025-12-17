@echo off
setlocal enableextensions enabledelayedexpansion

rem Включаем UTF-8, чтобы корректно показывать кириллицу
chcp 65001 >nul

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
