param([string]$OutputPath)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
if (!$OutputPath) { $OutputPath=Join-Path $projectRoot 'Daymark.exe' }
$output=[IO.Path]::GetFullPath($OutputPath)
$compiler=Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework C# compiler was not found.' }
$work=Join-Path $projectRoot 'artifacts\desktop-build'
$null=New-Item -ItemType Directory -Force -Path $work
Add-Type -AssemblyName System.Drawing
$bitmap=New-Object Drawing.Bitmap(64,64)
$graphics=[Drawing.Graphics]::FromImage($bitmap)
$graphics.Clear([Drawing.ColorTranslator]::FromHtml('#153d35'))
$brush=New-Object Drawing.SolidBrush([Drawing.ColorTranslator]::FromHtml('#f7f6ef'))
foreach ($y in @(18,30,42)) { $graphics.FillRectangle($brush,15,$y,34,6) }
$iconPath=Join-Path $work 'daymark.ico'
$handle=$bitmap.GetHicon()
$icon=[Drawing.Icon]::FromHandle($handle)
$stream=[IO.File]::Create($iconPath)
try { $icon.Save($stream) } finally { $stream.Dispose(); $icon.Dispose(); $graphics.Dispose(); $brush.Dispose(); $bitmap.Dispose() }
& $compiler /nologo /target:winexe /platform:x64 /optimize+ /codepage:65001 "/win32icon:$iconPath" "/win32manifest:$PSScriptRoot\desktop\app.manifest" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll "/out:$output" (Join-Path $PSScriptRoot 'desktop\Launcher.cs')
if ($LASTEXITCODE -ne 0) { throw 'Desktop executable compilation failed.' }
[pscustomobject]@{executable=$output;bytes=(Get-Item -LiteralPath $output).Length} | ConvertTo-Json
