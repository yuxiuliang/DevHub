@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   DevHub 正在启动...
echo.
node server/index.js
pause
