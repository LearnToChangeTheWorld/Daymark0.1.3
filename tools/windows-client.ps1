param([ValidateSet('WeChat', 'QQ')][string]$Platform)
# Read-only discovery. No client launch, registry writes, or disk-wide search.
$ErrorActionPreference = 'Stop'
function Get-DaymarkExecutableInfo([string]$Path, [string]$Platform) {
    $allowed = if ($Platform -eq 'WeChat') { @('Weixin.exe', 'WeChat.exe') } else { @('QQ.exe') }
    $stream = $null
    try {
        if (!$Path) { return }
        $Path = [Environment]::ExpandEnvironmentVariables($Path.Trim().Trim('"'))
        if ([IO.Path]::GetFileName($Path) -notin $allowed -or !(Test-Path -LiteralPath $Path -PathType Leaf -ErrorAction SilentlyContinue)) { return }
        $stream = [IO.File]::OpenRead($Path)
        $reader = New-Object IO.BinaryReader($stream)
        if ($reader.ReadUInt16() -ne 0x5a4d) { return }
        $stream.Position = 0x3c; $offset = $reader.ReadInt32()
        if ($offset -lt 64 -or $offset + 6 -gt $stream.Length) { return }
        $stream.Position = $offset
        if ($reader.ReadUInt32() -ne 0x4550) { return }
        $machine = $reader.ReadUInt16()
        $arch = switch ($machine) { 0x8664 { 'x64' } 0x14c { 'x86' } 0xaa64 { 'arm64' } default { 'unknown' } }
        $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($Path).FileVersion
        $kind = if ($Platform -eq 'WeChat') { if ([IO.Path]::GetFileName($Path) -ieq 'WeChat.exe') { 'wechat3' } else { 'wechat4' } } else { 'qqnt' }
        return [pscustomobject]@{ path=[IO.Path]::GetFullPath($Path); version=$version; architecture=$arch; kind=$kind }
    } catch { return } finally { if ($stream) { $stream.Dispose() } }
}
function Get-DaymarkClient([string]$Platform) {
    $override = if ($Platform -eq 'WeChat') { $env:STUDENT_INBOX_WECHAT_PATH } else { $env:STUDENT_INBOX_QQ_PATH }
    if ($override) {
        $info = Get-DaymarkExecutableInfo $override $Platform
        return [pscustomobject]@{ found=[bool]$info; client=$info; reason=$(if ($info) { '' } else { 'override_invalid' }) }
    }
    $paths = New-Object 'Collections.Generic.List[string]'
    $names = if ($Platform -eq 'WeChat') { @('Weixin', 'WeChat') } else { @('QQ') }
    # A running client's real image path takes precedence over stale uninstall entries.
    foreach ($name in $names) {
        Get-Process -Name $name -ErrorAction SilentlyContinue | ForEach-Object { try { if ($_.Path) { $paths.Add($_.Path) } } catch {} }
    }
    $leaves = if ($Platform -eq 'WeChat') { @('Weixin.exe', 'WeChat.exe') } else { @('QQ.exe') }
    foreach ($hive in @('HKCU:', 'HKLM:')) {
        foreach ($view in @('Software', 'Software\WOW6432Node')) {
            $products = if ($Platform -eq 'WeChat') { @('Weixin', 'WeChat') } else { @('QQ', 'QQNT') }
            foreach ($product in $products) {
                $key = Get-Item -LiteralPath "$hive\$view\Tencent\$product" -ErrorAction SilentlyContinue
                if ($key) {
                    foreach ($field in @('InstallPath', 'InstallDir', 'Path')) {
                        $location = $key.GetValue($field)
                        if ($location) {
                            $location = ([string]$location).Trim('" ')
                            $paths.Add($location)
                            foreach ($leaf in $leaves) { try { $paths.Add([IO.Path]::Combine($location, $leaf)) } catch {} }
                            if ($Platform -eq 'QQ') { try { $paths.Add([IO.Path]::Combine($location, 'Bin\QQ.exe')) } catch {} }
                        }
                    }
                }
            }
            foreach ($leaf in $leaves) {
                $key = Get-Item -LiteralPath "$hive\$view\Microsoft\Windows\CurrentVersion\App Paths\$leaf" -ErrorAction SilentlyContinue
                if ($key) { $value = $key.GetValue(''); if ($value) { $paths.Add(([string]$value).Trim('"')) } }
            }
            $uninstall = "$hive\$view\Microsoft\Windows\CurrentVersion\Uninstall"
            Get-ChildItem -LiteralPath $uninstall -ErrorAction SilentlyContinue | ForEach-Object {
                $item = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
                $pattern = if ($Platform -eq 'WeChat') { 'WeChat|Weixin|\u5fae\u4fe1' } else { '^(\u817e\u8baf)?QQ(NT)?(\s|$)|Tencent.*QQ' }
                if ($item -and $item.DisplayName -match $pattern) {
                    if ($item.DisplayIcon -match '^"([^"]+\.exe)"|^(.+?\.exe)(?:,|$)') { $paths.Add(($Matches[1] + $Matches[2])) }
                    if ($item.InstallLocation) { foreach ($leaf in $leaves) { try { $paths.Add([IO.Path]::Combine(([string]$item.InstallLocation).Trim('" '), $leaf)) } catch {} } }
                    if ($Platform -eq 'QQ' -and $item.InstallLocation) { try { $paths.Add([IO.Path]::Combine(([string]$item.InstallLocation).Trim('" '), 'Bin\QQ.exe')) } catch {} }
                }
            }
        }
    }
    foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
        if (!$base) { continue }
        $relative = if ($Platform -eq 'WeChat') { @('Tencent\Weixin\Weixin.exe', 'Tencent\WeChat\WeChat.exe', 'Programs\Tencent\Weixin\Weixin.exe', 'Programs\Weixin\Weixin.exe') } else { @('Tencent\QQNT\QQ.exe', 'Tencent\QQ\Bin\QQ.exe', 'Programs\Tencent\QQNT\QQ.exe', 'Programs\QQ\QQ.exe') }
        foreach ($part in $relative) { $paths.Add((Join-Path $base $part)) }
    }
    foreach ($path in ($paths | Select-Object -Unique)) {
        $info = Get-DaymarkExecutableInfo $path $Platform
        if ($info) { return [pscustomobject]@{ found=$true; client=$info; reason='' } }
    }
    return [pscustomobject]@{ found=$false; client=$null; reason='not_found' }
}
if ($Platform) {
    [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
    Get-DaymarkClient $Platform | ConvertTo-Json -Compress -Depth 4
}
