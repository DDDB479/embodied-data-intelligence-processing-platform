@echo off
chcp 65001 >nul
set "RULE_NAME=Embodied Data Quality Platform LAN 4173"

fltmc >nul 2>&1
if errorlevel 1 (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

netsh advfirewall firewall delete rule name="%RULE_NAME%" >nul 2>&1
netsh advfirewall firewall add rule name="%RULE_NAME%" dir=in action=allow protocol=TCP localport=4173 remoteip=localsubnet profile=any

if errorlevel 1 (
  echo Failed to enable LAN access.
) else (
  echo LAN access is enabled for TCP port 4173 on the local subnet only.
)
pause
