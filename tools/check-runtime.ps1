$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime-common.ps1')
try {
  Assert-DaymarkRuntime -ProjectRoot (Split-Path -Parent $PSScriptRoot)
  . (Join-Path $PSScriptRoot 'windows-client.ps1')
  foreach ($clientName in @('WeChat', 'QQ')) {
    $detected = Get-DaymarkClient $clientName
    if ($detected.found) {
      Write-Host ($clientName + ': ' + $detected.client.version + ' / ' + $detected.client.architecture + ' / ' + $detected.client.path)
    } else { Write-Host ($clientName + ': installation location not detected (' + $detected.reason + '). Start the official client and check again.') }
  }
  Write-Host 'All bundled components are ready. No downloads or installations were performed.'
  Write-Host 'Official Windows WeChat/QQ clients and your own login are needed for their connections.'
} catch {
  Write-Host ('Component check failed: ' + $_.Exception.Message) -ForegroundColor Red
  exit 1
}
