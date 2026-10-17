param([switch]$NoBrowser, [switch]$Offline)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'runtime-common.ps1')
$browserJob = $null
try {
  Set-Location -LiteralPath $projectRoot
  $completePackage = Test-Path -LiteralPath (Join-Path $projectRoot 'runtime-manifest.json') -PathType Leaf
  if ($completePackage) { Write-Host 'Daymark - checking bundled components. No dependency downloads are required.' }
  else { Write-Host 'Daymark - preparing local components. First source launch needs Internet access.' }
  try {
    if (!$completePackage) { Initialize-DaymarkRuntime -ProjectRoot $projectRoot -Component All -Offline:$Offline }
    Assert-DaymarkRuntime -ProjectRoot $projectRoot
  } catch {
    if ($completePackage) { throw ('The complete Windows package is incomplete or cannot run. Extract the entire ZIP again. Details: ' + $_.Exception.Message) }
    throw
  }
  $env:STUDENT_INBOX_PYTHON_PATH = Join-Path $projectRoot 'runtimes\python\python.exe'
  $env:STUDENT_INBOX_MODE = 'local'
  $env:HOST = '127.0.0.1'
  if (!$env:PORT) { $env:PORT = '4317' }
  $url = 'http://127.0.0.1:' + $env:PORT
  $probe = New-Object Net.Sockets.TcpClient
  try {
    $connected = $probe.ConnectAsync('127.0.0.1', [int]$env:PORT)
    $null = $connected.Wait(500)
    if ($probe.Connected) { throw "Port $($env:PORT) is already in use. Close the earlier Daymark window, or set PORT to another port." }
  } catch [System.AggregateException] {
    # A refused connection means this local port is free.
  } finally { $probe.Dispose() }
  if (!$NoBrowser) {
    $browserJob = Start-Job -ArgumentList $url -ScriptBlock {
      param($Address)
      for ($attempt=0; $attempt -lt 30; $attempt++) {
        try {
          $null = Invoke-WebRequest -UseBasicParsing -Uri $Address -TimeoutSec 1
          Start-Process $Address
          break
        } catch { Start-Sleep -Milliseconds 500 }
      }
    }
  }
  Write-Host "Open $url and enter the access code printed below. Keep this window open."
  & (Join-Path $projectRoot 'runtimes\node\node.exe') (Join-Path $projectRoot 'server.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'The Daymark service exited with an error.' }
} catch {
  Write-Host ('Startup failed: ' + $_.Exception.Message) -ForegroundColor Red
  exit 1
} finally {
  if ($browserJob) { Stop-Job $browserJob -ErrorAction SilentlyContinue; Remove-Job $browserJob -Force -ErrorAction SilentlyContinue }
}
