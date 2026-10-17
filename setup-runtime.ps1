param([ValidateSet('All','Core','QQ','WeChat')][string]$Component = 'All', [switch]$Offline, [string]$DownloadCache)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime-common.ps1')
try {
  Initialize-DaymarkRuntime -ProjectRoot (Split-Path -Parent $PSScriptRoot) -Component $Component -Cache $DownloadCache -Offline:$Offline
  Write-Host 'Daymark components are ready. Official Windows WeChat/QQ clients are installed separately.'
} catch {
  Write-Host ('Setup failed: ' + $_.Exception.Message) -ForegroundColor Red
  exit 1
}
