@echo off
setlocal
cd /d "%~dp0"
title Daymark
set "DAYMARK_POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if exist "%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe" set "DAYMARK_POWERSHELL=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
"%DAYMARK_POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start-daymark.ps1" %*
if errorlevel 1 (
  echo.
  echo Daymark could not start. Read the error above, then try again.
  pause
)
endlocal
