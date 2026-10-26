@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0platform-launcher.ps1" -OpenBrowser
if errorlevel 1 pause
