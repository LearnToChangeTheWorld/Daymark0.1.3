param([ValidateSet('All','QQ','WeChat')][string]$Component = 'All', [switch]$Offline, [string]$DownloadCache)
# Compatibility entry point; private Python is installed without a system Python.
& (Join-Path $PSScriptRoot 'setup-runtime.ps1') -Component $Component -Offline:$Offline -DownloadCache $DownloadCache
exit $LASTEXITCODE
