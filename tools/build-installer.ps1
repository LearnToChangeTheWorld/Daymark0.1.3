param([Parameter(Mandatory=$true)][string]$BundleZip,[string]$OutputPath)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'runtime-common.ps1')
$bundle=[IO.Path]::GetFullPath($BundleZip)
if (!$OutputPath) { $OutputPath=Join-Path $projectRoot 'artifacts\releases\Daymark-0.1.3-Setup.exe' }
$output=[IO.Path]::GetFullPath($OutputPath)
if (Test-Path -LiteralPath $output) { throw 'Installer output already exists.' }
$compiler=Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$stub=Join-Path $projectRoot 'artifacts\desktop-build\Setup-stub.exe'
$icon=Join-Path $projectRoot 'artifacts\desktop-build\daymark.ico'
& $compiler /nologo /target:winexe /platform:x64 /optimize+ /codepage:65001 "/win32icon:$icon" "/win32manifest:$PSScriptRoot\desktop\app.manifest" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll "/out:$stub" (Join-Path $PSScriptRoot 'desktop\Installer.cs')
if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed.' }
$target=[IO.File]::Create($output)
try {
  foreach ($path in @($stub,$bundle)) { $inputStream=[IO.File]::OpenRead($path); try { $inputStream.CopyTo($target) } finally { $inputStream.Dispose() } }
  $writer=New-Object IO.BinaryWriter($target)
  $writer.Write([long](Get-Item -LiteralPath $bundle).Length)
  $zipStream=[IO.File]::OpenRead($bundle); $algorithm=[Security.Cryptography.SHA256]::Create()
  try { $writer.Write([byte[]]$algorithm.ComputeHash($zipStream)) } finally { $zipStream.Dispose(); $algorithm.Dispose() }
  $writer.Write([Text.Encoding]::ASCII.GetBytes('DAYMARK-SETUP-V1')); $writer.Flush()
} finally { $target.Dispose() }
$digest=Get-DaymarkSha256 $output
[IO.File]::WriteAllText($output+'.sha256',$digest+'  '+[IO.Path]::GetFileName($output)+"`n")
[pscustomobject]@{installer=$output;sha256=$digest;bytes=(Get-Item -LiteralPath $output).Length} | ConvertTo-Json
