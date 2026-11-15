@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-platform.ps1"
if errorlevel 1 (
  echo.
  echo Update failed. Review the message above.
  pause
  exit /b 1
)
echo.
echo Platform update completed.
pause
