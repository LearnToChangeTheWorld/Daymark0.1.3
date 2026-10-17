$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-DaymarkSha256 {
  param([string]$Path)
  $stream = [IO.File]::OpenRead($Path)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $algorithm.Dispose() }
}

function Get-DaymarkDownload {
  param($Asset, [string]$Cache, [switch]$Offline)
  $null = New-Item -ItemType Directory -Force -Path $Cache
  $file = Join-Path $Cache $Asset.file
  if (!(Test-Path -LiteralPath $file)) {
    if ($Offline) { throw "Offline dependency is missing: $($Asset.file)" }
    Write-Host "Downloading $($Asset.file) ..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $partial = $file + '.partial'
    Invoke-WebRequest -UseBasicParsing -Uri $Asset.url -OutFile $partial -TimeoutSec 300
    if ((Get-DaymarkSha256 $partial) -ne $Asset.sha256) { throw "Download checksum mismatch: $($Asset.file). The file was not installed." }
    Move-Item -LiteralPath $partial -Destination $file -Force
  }
  if ((Get-DaymarkSha256 $file) -ne $Asset.sha256) { throw "Cached dependency checksum mismatch: $($Asset.file). The file was not installed." }
  return $file
}

function Expand-DaymarkArchive {
  param([string]$Archive, [string]$Destination, [switch]$StripTopDirectory)
  $target = [IO.Path]::GetFullPath($Destination)
  $prefix = $target.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
  try {
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName.Replace('\', '/')
      if ($StripTopDirectory) {
        $slash = $name.IndexOf('/')
        if ($slash -lt 0) { throw 'Runtime archive has an unexpected layout.' }
        $name = $name.Substring($slash + 1)
      }
      if (!$name -or $name.EndsWith('/')) { continue }
      $path = [IO.Path]::GetFullPath((Join-Path $target $name))
      if (!$path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive entry escapes its destination.' }
      $null = New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($path))
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $path, $true)
    }
  } finally { $zip.Dispose() }
}

function Test-DaymarkReady {
  param([string]$Directory, [string]$Fingerprint, [string[]]$Required)
  try {
    $marker = Get-Content -Raw -LiteralPath (Join-Path $Directory '.daymark-ready.json') | ConvertFrom-Json
    if ($marker.fingerprint -ne $Fingerprint) { return $false }
    foreach ($file in $Required) { if (!(Test-Path -LiteralPath (Join-Path $Directory $file) -PathType Leaf)) { return $false } }
    return $true
  } catch { return $false }
}

function Set-DaymarkReady {
  param([string]$Directory, [string]$Fingerprint)
  [IO.File]::WriteAllText((Join-Path $Directory '.daymark-ready.json'), (@{ fingerprint=$Fingerprint } | ConvertTo-Json))
}

function Assert-DaymarkRuntime {
  param([string]$ProjectRoot)
  $lock = Get-Content -Raw -LiteralPath (Join-Path $ProjectRoot 'tools\runtime-lock.json') | ConvertFrom-Json
  $node = Join-Path $ProjectRoot 'runtimes\node\node.exe'
  if (!(Test-Path -LiteralPath $node -PathType Leaf)) { throw 'Bundled Node.js is missing.' }
  $version = & $node --version
  if ($LASTEXITCODE -ne 0 -or $version -ne $lock.node.version) { throw 'Bundled Node.js cannot run or has the wrong version.' }
  Write-Host ('Node.js ' + $version + ' OK')
  $python = Join-Path $ProjectRoot 'runtimes\python\python.exe'
  if (!(Test-Path -LiteralPath $python -PathType Leaf)) { throw 'Bundled Python is missing.' }
  & $python -I -B -c "import sys,site,struct,sqlite3,ctypes,win32api,win32crypt,win32gui,win32ui,win32process,pywinauto,comtypes,six,PIL,frida,zstandard,typing_extensions; from Crypto.Cipher import AES; assert sys.version_info[:2]==(3,10) and struct.calcsize('P')==8 and sys.flags.isolated and not site.ENABLE_USER_SITE; print('Python 3.10 x64 and all WeChat dependencies OK')"
  if ($LASTEXITCODE -ne 0) { throw 'Bundled Python or a WeChat dependency cannot load.' }
  foreach ($file in @('NapCatWinBootMain.exe','NapCatWinBootHook.dll','napcat.mjs','loadNapCat.js','qqnt.json','LICENSE','DAYMARK-SOURCE.txt')) {
    if (!(Test-Path -LiteralPath (Join-Path $ProjectRoot ('runtimes\napcat\' + $file)) -PathType Leaf)) { throw ('Bundled NapCatQQ file is missing: ' + $file) }
  }
  Write-Host ('NapCatQQ ' + $lock.napcat.version + ' files OK (client login is checked when connecting).')
}

function Initialize-DaymarkRuntime {
  param([string]$ProjectRoot, [ValidateSet('All','Core','QQ','WeChat')][string]$Component = 'All', [string]$Cache, [switch]$Offline)
  if (![Environment]::Is64BitOperatingSystem -or ![Environment]::Is64BitProcess) { throw 'Daymark requires 64-bit Windows and 64-bit PowerShell.' }
  $ProjectRoot = [IO.Path]::GetFullPath($ProjectRoot)
  if (!$Cache) { $Cache = Join-Path $ProjectRoot 'artifacts\runtime-downloads' }
  $lockPath = Join-Path $ProjectRoot 'tools\runtime-lock.json'
  $lock = Get-Content -Raw -LiteralPath $lockPath | ConvertFrom-Json
  $fingerprint = Get-DaymarkSha256 $lockPath
  if ($Component -in @('All','Core')) {
    $directory = Join-Path $ProjectRoot 'runtimes\node'
    if (!(Test-DaymarkReady $directory $fingerprint @('node.exe','LICENSE'))) {
      $archive = Get-DaymarkDownload $lock.node $Cache -Offline:$Offline
      Expand-DaymarkArchive $archive $directory -StripTopDirectory
      $version = & (Join-Path $directory 'node.exe') --version
      if ($LASTEXITCODE -ne 0 -or $version -ne $lock.node.version) { throw 'Bundled Node.js verification failed.' }
      Set-DaymarkReady $directory $fingerprint
    }
  }
  if ($Component -in @('All','WeChat')) {
    $directory = Join-Path $ProjectRoot 'runtimes\python'
    if (!(Test-DaymarkReady $directory $fingerprint @('python.exe','LICENSE.txt','Lib\site-packages\frida\__init__.py','Lib\site-packages\typing_extensions.py','Lib\site-packages\win32\win32api.pyd'))) {
      $archive = Get-DaymarkDownload $lock.python $Cache -Offline:$Offline
      Expand-DaymarkArchive $archive $directory
      foreach ($wheel in $lock.wheels) {
        $archive = Get-DaymarkDownload $wheel $Cache -Offline:$Offline
        Expand-DaymarkArchive $archive (Join-Path $directory 'Lib\site-packages')
      }
      # Private Python: no PATH/registry changes, no dependency on a system installation.
      $paths = "python310.zip`n.`nLib\site-packages`n..\..\collector`nimport site`n"
      [IO.File]::WriteAllText((Join-Path $directory 'python310._pth'), $paths)
      $python = Join-Path $directory 'python.exe'
      & $python -I -c "import sys,site,struct,sqlite3,ctypes,win32api,win32crypt,pywinauto,comtypes,six,PIL,frida,zstandard,typing_extensions; from Crypto.Cipher import AES; assert sys.version_info[:2]==(3,10) and struct.calcsize('P')==8 and not site.ENABLE_USER_SITE; print('Private Python 3.10 and WeChat dependencies are ready.')"
      if ($LASTEXITCODE -ne 0) { throw 'Private Python dependency check failed. No success marker was saved.' }
      Set-DaymarkReady $directory $fingerprint
    }
  }
  if ($Component -in @('All','QQ')) {
    $directory = Join-Path $ProjectRoot 'runtimes\napcat'
    if (!(Test-DaymarkReady $directory $fingerprint @('NapCatWinBootMain.exe','NapCatWinBootHook.dll','napcat.mjs','loadNapCat.js','LICENSE'))) {
      $archive = Get-DaymarkDownload $lock.napcat $Cache -Offline:$Offline
      Expand-DaymarkArchive $archive $directory
      Copy-Item -LiteralPath (Join-Path $ProjectRoot 'vendor\NapCat.LICENSE') -Destination (Join-Path $directory 'LICENSE')
      [IO.File]::WriteAllText((Join-Path $directory 'DAYMARK-SOURCE.txt'), "NapNeko/NapCatQQ v$($lock.napcat.version)`nhttps://github.com/NapNeko/NapCatQQ`nCopyright 2024 Mlikiowa`nUnmodified upstream runtime. Limited Redistribution License; non-commercial use.`nSHA-256: $($lock.napcat.sha256)`n")
      Set-DaymarkReady $directory $fingerprint
    }
  }
}
