@echo off
REM Clean launcher for FB Marketplace Automation
REM Double-click this or point your desktop shortcut to it.
REM It will run the updated start-debug.ps1 which now properly shows the Startup Configuration dialog first.

cd /d "%~dp0"
powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File "start-debug.ps1"
exit
