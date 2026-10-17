param([switch]$Offline, [string]$DownloadCache)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
. (Join-Path $PSScriptRoot 'runtime-common.ps1')
if (!$DownloadCache) { $DownloadCache = Join-Path $projectRoot 'artifacts\runtime-downloads' }
Initialize-DaymarkRuntime -ProjectRoot $projectRoot -Component Core -Cache $DownloadCache -Offline:$Offline
$node = Join-Path $projectRoot 'runtimes\node\node.exe'
$output = & $node (Join-Path $PSScriptRoot 'release-check.mjs') --export
if ($LASTEXITCODE -ne 0) { throw ($output -join "`n") }
$source = ($output -join "`n") | ConvertFrom-Json
$sourceRoot = [IO.Path]::GetFullPath($source.output)
$releaseParent = [IO.Path]::GetFullPath((Join-Path $projectRoot 'artifacts\releases')) + [IO.Path]::DirectorySeparatorChar
$bundleRoot = $sourceRoot.Replace('-source-', '-windows-x64-')
if (!$sourceRoot.StartsWith($releaseParent, [StringComparison]::OrdinalIgnoreCase) -or !$bundleRoot.StartsWith($releaseParent, [StringComparison]::OrdinalIgnoreCase) -or $bundleRoot -eq $sourceRoot) { throw 'Invalid release directory.' }
if (Test-Path -LiteralPath $bundleRoot) { throw 'Release directory already exists.' }
Move-Item -LiteralPath $sourceRoot -Destination $bundleRoot
# Always extract pristine archives into this NEW directory. Never copy active runtimes,
# virtual environments, client profiles, account settings or the user's data directory.
Initialize-DaymarkRuntime -ProjectRoot $bundleRoot -Component All -Cache $DownloadCache -Offline:$Offline
Assert-DaymarkRuntime -ProjectRoot $bundleRoot
& (Join-Path $PSScriptRoot 'build-desktop.ps1') -OutputPath (Join-Path $bundleRoot 'Daymark.exe') | Out-Null
$entries = @()
Get-ChildItem -LiteralPath (Join-Path $bundleRoot 'runtimes') -File -Recurse | Sort-Object FullName | ForEach-Object {
  $path = $_.FullName.Substring($bundleRoot.Length + 1).Replace('\', '/')
  $entries += [ordered]@{ path=$path; size=$_.Length; sha256=(Get-DaymarkSha256 $_.FullName) }
}
$exe=Get-Item -LiteralPath (Join-Path $bundleRoot 'Daymark.exe')
$entries += [ordered]@{path='Daymark.exe';size=$exe.Length;sha256=(Get-DaymarkSha256 $exe.FullName)}
$lock = Get-Content -Raw -LiteralPath (Join-Path $bundleRoot 'tools\runtime-lock.json') | ConvertFrom-Json
$manifest = [ordered]@{ schema=1; platform='win-x64'; node=$lock.node.version; python=$lock.python.version; napcat=$lock.napcat.version; files=$entries }
[IO.File]::WriteAllText((Join-Path $bundleRoot 'runtime-manifest.json'), ($manifest | ConvertTo-Json -Depth 8))
& $node (Join-Path $bundleRoot 'tools\check-windows-bundle.mjs') $bundleRoot
if ($LASTEXITCODE -ne 0) { throw 'Windows package verification failed.' }
$archive = $bundleRoot + '.zip'
if (Test-Path -LiteralPath $archive) { throw 'Release archive already exists.' }
[IO.Compression.ZipFile]::CreateFromDirectory($bundleRoot, $archive, [IO.Compression.CompressionLevel]::Optimal, $true)
$digest = Get-DaymarkSha256 $archive
[IO.File]::WriteAllText($archive + '.sha256', $digest + '  ' + [IO.Path]::GetFileName($archive) + "`n")
[pscustomobject]@{ archive=$archive; sha256=$digest; source=$bundleRoot; sourceFiles=$source.fileCount; runtimeFiles=$entries.Count; bytes=(Get-Item -LiteralPath $archive).Length } | ConvertTo-Json
