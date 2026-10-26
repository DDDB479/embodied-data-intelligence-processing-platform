@echo off
chcp 65001 >nul
set "RULE_NAME=Embodied Data Quality Platform LAN 4173"

fltmc >nul 2>&1
if errorlevel 1 (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

netsh advfirewall firewall delete rule name="%RULE_NAME%"
echo LAN access rule has been removed.
pause
