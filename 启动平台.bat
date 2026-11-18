@echo off
cd /d "%~dp0"
wscript.exe //B //Nologo "%~dp0启动平台自动启动.vbs" open
exit /b 0
