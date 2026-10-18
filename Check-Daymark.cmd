@echo off
setlocal
cd /d "%~dp0"
title Daymark - component check
set "DAYMARK_POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if exist "%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe" set "DAYMARK_POWERSHELL=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
"%DAYMARK_POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\check-runtime.ps1"
if errorlevel 1 (
  echo Component check FAILED. Extract the complete Windows ZIP again.
) else (
  echo Component check PASSED. Double-click Start-Daymark.cmd to start.
)
echo.
pause
endlocal
