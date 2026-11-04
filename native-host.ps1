param([string]$Origin, [Parameter(ValueFromRemainingArguments=$true)]$BrowserArguments)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($Origin -ne 'chrome-extension://dlddgdefgecebmfhjinfamnffjkgohao/') { exit 1 }
$inputStream = [Console]::OpenStandardInput()
$outputStream = [Console]::OpenStandardOutput()
$utf8 = New-Object Text.UTF8Encoding($false, $true)
$gameRoot = $null
$gameName = $null
$writers = @{}
$newModStages = @{}
$selfLease = $null
$defenderScan = $null
$gameFiles = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
$gamePaths = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
$gameDirectories = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
$gameBackup = $null
$gameRollback = $null

function Need($condition, [string]$message, [string]$name = 'NotAllowedError') {
    if (-not $condition) { $error = New-Object System.Exception($message); $error.Data['name'] = $name; throw $error }
}
function ExactRead([int]$length) {
    $buffer = New-Object byte[] $length
    $offset = 0
    while ($offset -lt $length) {
        $count = $inputStream.Read($buffer, $offset, $length - $offset)
        if (-not $count) { if (-not $offset) { return $null }; throw 'Truncated native message.' }
        $offset += $count
    }
    return ,$buffer
}
function Reply($value) {
    $bytes = $utf8.GetBytes(($value | ConvertTo-Json -Compress -Depth 8))
    Need ($bytes.Length -le 1048576) 'Native response is too large.'
    $size = [BitConverter]::GetBytes([uint32]$bytes.Length)
    $outputStream.Write($size, 0, 4); $outputStream.Write($bytes, 0, $bytes.Length); $outputStream.Flush()
}
function CheckAncestors([string]$path) {
    $current = [IO.Path]::GetFullPath($path)
    while ($current) {
        if ([IO.File]::Exists($current) -or [IO.Directory]::Exists($current)) {
            Need (([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'Linked game paths are not supported.'
        }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current) { break }; $current = $parent
    }
}
function ResolveRelative([string]$relative, [switch]$Write) {
    Need ($null -ne $gameRoot) 'Connect a game first.'
    Need ($relative.Length -le 1000 -and $relative -notmatch '[\\:\x00-\x1f<>"|?*]' -and $relative -notmatch '^/|/$|//') 'Invalid relative path.'
    if ($relative) {
        foreach ($part in $relative.Split('/')) {
            Need ($part -notin @('.', '..') -and $part -notmatch '[. ]$' -and $part -notmatch '^(?i:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)') 'Invalid path component.'
        }
    }
    if ($Write) {
        Need ($gamePaths.Contains($relative) -or $gameDirectories.Contains($relative) -or $relative -eq 'wml' -or $relative -match '^image-packs(?:/|$)' -or $relative -match '^(?:wml/mods|\.wml-mod-updater-backups)/[a-z0-9][a-z0-9._-]*/.+$' -or $relative -match '^(?:wml/mods|\.wml-mod-updater-backups)(?:/[a-z0-9][a-z0-9._-]*)?$') 'Writes are limited to approved update paths.'
    } else {
        Need ($gamePaths.Contains($relative) -or $gameDirectories.Contains($relative) -or $relative -eq '' -or $relative -eq $gameName -or $relative -in @('wml', 'wml/runtime', 'wml/runtime/wml-core.js', 'wml/mods', '.wml-mod-updater-backups') -or $relative -match '^image-packs(?:/|$)' -or $relative -match '^(?:wml/mods|\.wml-mod-updater-backups)/') 'Read path is outside approved update paths.'
    }
    $full = if ($relative) { [IO.Path]::GetFullPath((Join-Path $gameRoot $relative)) } else { $gameRoot }
    Need ($full -eq $gameRoot -or $full.StartsWith($gameRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) 'Path leaves the game folder.'
    CheckAncestors $full
    return $full
}
function Attributes([string]$path) {
    try { return [IO.File]::GetAttributes($path) }
    catch {
        $cause = $_.Exception.GetBaseException()
        if ($cause -is [IO.FileNotFoundException] -or $cause -is [IO.DirectoryNotFoundException]) { Need $false 'Entry not found.' 'NotFoundError' }
        throw
    }
}
function FileInfo([string]$path) {
    Need (((Attributes $path) -band [IO.FileAttributes]::Directory) -eq 0) 'Expected a file, found a directory.' 'TypeMismatchError'
    $info = New-Object IO.FileInfo($path)
    Need ($info.Length -le 67108864) 'File is larger than 64 MiB.'
    return @{size=$info.Length; stamp=$info.LastWriteTimeUtc.Ticks.ToString()}
}
function DropWriter([string]$token) {
    if ($writers.ContainsKey($token)) {
        $writer = $writers[$token]; $writer.stream.Dispose()
        CheckAncestors $writer.temp
        if ([IO.File]::Exists($writer.temp)) { [IO.File]::Delete($writer.temp) }
        $writers.Remove($token)
    }
}
function DropEmptyModStage([string]$token) {
    if (-not $newModStages.ContainsKey($token)) { return }
    $stage = ResolveRelative $newModStages[$token].stage -Write
    if ([IO.Directory]::Exists($stage)) {
        $dirs = New-Object 'Collections.Generic.List[string]'; $dirs.Add($stage)
        for ($i = 0; $i -lt $dirs.Count; $i++) {
            CheckAncestors $dirs[$i]
            foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($dirs[$i])) {
                $attributes = [IO.File]::GetAttributes($entry)
                Need (($attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0 -and ($attributes -band [IO.FileAttributes]::Directory) -ne 0) 'The staging folder is not empty.'
                $dirs.Add($entry)
            }
        }
        for ($i = $dirs.Count - 1; $i -ge 0; $i--) { [IO.Directory]::Delete($dirs[$i], $false) }
    }
    $newModStages.Remove($token)
}
. (Join-Path $PSScriptRoot 'native-defender.ps1')
function Dispatch($request) {
    if ($request.op -is [string] -and $request.op.StartsWith('scan-')) {
        return (DefenderDispatch $request)
    }
    if ($request.op -is [string] -and $request.op.StartsWith('self-')) {
        if (-not (Get-Command SelfDispatch -ErrorAction SilentlyContinue)) { . (Join-Path $PSScriptRoot 'native-self-update.ps1') }
        return (SelfDispatch $request)
    }
    if ($request.op -in @('game-authorize','game-arm','game-finish')) {
        if (-not (Get-Command GameDispatch -ErrorAction SilentlyContinue)) { . (Join-Path $PSScriptRoot 'native-game-update.ps1') }
        return (GameDispatch $request)
    }
    if ($request.op -eq 'connect') {
        Need ($null -eq $gameRoot) 'This connection is already bound to a game.'
        Need ($request.url -is [string] -and $request.url.Length -lt 4096 -and $request.url -match '^file:///[A-Za-z]:/') 'Use a local Windows drive game URL.'
        $url = New-Object Uri($request.url)
        Need ($url.IsFile -and -not $url.IsUnc -and -not $url.UserInfo -and $url.LocalPath -match '\.html?$') 'Use a local game HTML file.'
        $file = [IO.Path]::GetFullPath($url.LocalPath)
        CheckAncestors $file
        Need ([IO.File]::Exists($file)) 'The detected game HTML does not exist.' 'NotFoundError'
        $candidateRoot = [IO.Path]::GetDirectoryName($file)
        $runtime = Join-Path $candidateRoot 'wml/runtime/wml-core.js'
        CheckAncestors $runtime
        Need ([IO.File]::Exists($runtime)) 'The detected folder does not contain WML.' 'NotFoundError'
        $script:gameRoot = $candidateRoot
        $script:gameName = [IO.Path]::GetFileName($file)
        return @{name=(New-Object IO.DirectoryInfo($gameRoot)).Name; gameFile=$gameName; path=$gameRoot}
    }
    if ($request.op -eq 'new-mod-begin') {
        Need ($newModStages.Count -lt 8) 'Too many pending mod installations.'
        Need ($request.modId -is [string] -and $request.modId.Length -le 64 -and $request.modId -cmatch '^[a-z0-9][a-z0-9._-]*$' -and -not $request.modId.EndsWith('.')) 'Invalid mod ID.'
        $target = 'wml/mods/' + $request.modId
        $targetPath = ResolveRelative $target -Write
        Need (-not [IO.File]::Exists($targetPath) -and -not [IO.Directory]::Exists($targetPath)) 'The mod folder already exists.' 'InvalidModificationError'
        Need ([IO.Directory]::Exists([IO.Path]::GetDirectoryName($targetPath))) 'Mod parent folder not found.' 'NotFoundError'
        $backup = ResolveRelative ('.wml-mod-updater-backups/' + $request.modId) -Write
        [void][IO.Directory]::CreateDirectory($backup)
        $stage = '.wml-mod-updater-backups/' + $request.modId + '/.wiki-stage-' + [Guid]::NewGuid().ToString('N')
        $stagePath = ResolveRelative $stage -Write
        Need (-not [IO.File]::Exists($stagePath) -and -not [IO.Directory]::Exists($stagePath)) 'Staging folder already exists.'
        [void][IO.Directory]::CreateDirectory($stagePath)
        $token = [Guid]::NewGuid().ToString('N'); $newModStages[$token] = @{stage=$stage;target=$target}
        return @{token=$token;stage=$stage}
    }
    if ($request.op -in @('new-mod-publish','new-mod-abort')) {
        Need ($request.token -is [string] -and $newModStages.ContainsKey($request.token)) 'Unknown mod installation.'
        if ($request.op -eq 'new-mod-abort') { DropEmptyModStage $request.token; return @{} }
        $stage = ResolveRelative $newModStages[$request.token].stage -Write
        $target = ResolveRelative $newModStages[$request.token].target -Write
        Need ([IO.File]::Exists((Join-Path $stage 'mod.js'))) 'Staged mod entry point is missing.'
        [IO.Directory]::Move($stage,$target)
        $newModStages.Remove($request.token)
        return @{}
    }
    if ($request.op -in @('chunk', 'commit', 'abort')) {
        Need ($request.token -is [string] -and $writers.ContainsKey($request.token)) 'Unknown write transaction.'
        $writer = $writers[$request.token]
        $target = ResolveRelative $writer.path -Write
        if ($request.op -eq 'abort') { DropWriter $request.token; return @{} }
        if ($request.op -eq 'chunk') {
            Need ($request.data -is [string] -and $request.data.Length -le 349528) 'Write chunk is too large.'
            $bytes = [Convert]::FromBase64String($request.data)
            $limit = if ($gamePaths.Contains($writer.path)) { 67108864 } else { 16777216 }
            Need ($bytes.Length -le 262144 -and $writer.stream.Length + $bytes.Length -le $limit) 'Write exceeds the file size limit.'
            $writer.stream.Write($bytes, 0, $bytes.Length)
            return @{}
        }
        $writer.stream.Flush($true); $writer.stream.Dispose()
        CheckAncestors $writer.temp
        if ($writer.exclusive) { [IO.File]::Move($writer.temp, $target) }
        elseif ([IO.File]::Exists($target)) { [IO.File]::Replace($writer.temp, $target, [NullString]::Value) } else { [IO.File]::Move($writer.temp, $target) }
        $writers.Remove($request.token)
        return @{}
    }
    $path = ResolveRelative $request.path -Write:($request.op -in @('mkdir','begin','begin-new','remove') -or ($request.op -eq 'stat' -and $request.create))
    if ($request.op -in @('begin', 'begin-new', 'remove') -or ($request.op -eq 'stat' -and $request.kind -eq 'file' -and $request.create)) {
        Need ($gamePaths.Contains($request.path) -or $request.path -match '^(?:wml/mods|\.wml-mod-updater-backups)/[a-z0-9][a-z0-9._-]*/.+$' -or $request.path -match '^image-packs/.+/(?:pack\.js|[^/]+\.(?:json|png|jpe?g|webp|gif|avif))$') 'Only approved update files can be changed.'
        if ($gameFiles.Contains($request.path)) { Need ($null -ne $gameRollback) 'Game backup must be verified before writes.' }
    }
    switch ($request.op) {
        'stat' {
            Need ($request.kind -in @('file','directory')) 'Invalid entry kind.'
            if ($request.kind -eq 'directory') {
                try { $attributes = Attributes $path }
                catch {
                    if (-not $request.create -or $_.Exception.Data['name'] -ne 'NotFoundError') { throw }
                    [void][IO.Directory]::CreateDirectory($path); $attributes = Attributes $path
                }
                Need (($attributes -band [IO.FileAttributes]::Directory) -ne 0) 'Expected a directory, found a file.' 'TypeMismatchError'
                return @{}
            }
            try { return (FileInfo $path) }
            catch {
                if (-not $request.create -or $_.Exception.Data['name'] -ne 'NotFoundError') { throw }
                Need ([IO.Directory]::Exists([IO.Path]::GetDirectoryName($path))) 'Parent folder not found.' 'NotFoundError'
                $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew); $stream.Dispose()
            }
            return (FileInfo $path)
        }
        'list' {
            Need ([IO.Directory]::Exists($path)) 'Directory not found.' 'NotFoundError'
            $entries = @([IO.Directory]::EnumerateFileSystemEntries($path) | Select-Object -First 4097)
            Need ($entries.Count -le 4096) 'Directory contains too many entries.'
            $items = @(); foreach ($entry in $entries) {
                $attrs = [IO.File]::GetAttributes($entry)
                if ($attrs -band [IO.FileAttributes]::ReparsePoint) { continue }
                $items += @{name=[IO.Path]::GetFileName($entry);kind=$(if ($attrs -band [IO.FileAttributes]::Directory) { 'directory' } else { 'file' })}
            }
            return @{entries=$items}
        }
        'read' {
            $info = FileInfo $path
            Need ($request.offset -is [ValueType] -and $request.length -is [ValueType] -and $request.offset -ge 0 -and $request.length -ge 0 -and $request.length -le 262144 -and $request.offset + $request.length -le $info.size -and [Math]::Floor($request.offset) -eq $request.offset -and [Math]::Floor($request.length) -eq $request.length) 'Invalid read range.'
            Need ($request.size -eq $info.size -and $request.stamp -eq $info.stamp) 'File changed during inspection.' 'InvalidStateError'
            $bytes = New-Object byte[] ([int]$request.length)
            $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
            try {
                [void]$stream.Seek([long]$request.offset, [IO.SeekOrigin]::Begin); $offset = 0
                while ($offset -lt $bytes.Length) { $n = $stream.Read($bytes, $offset, $bytes.Length-$offset); Need ($n -gt 0) 'File changed during inspection.'; $offset += $n }
            } finally { $stream.Dispose() }
            return @{data=[Convert]::ToBase64String($bytes)}
        }
        { $_ -in @('begin','begin-new') } {
            Need ($writers.Count -lt 8) 'Too many pending writes.'
            Need ([IO.Directory]::Exists([IO.Path]::GetDirectoryName($path))) 'Parent folder not found.' 'NotFoundError'
            if ($request.op -eq 'begin-new') { Need (-not [IO.File]::Exists($path) -and -not [IO.Directory]::Exists($path)) 'The target file already exists.' 'InvalidModificationError' }
            $token = [Guid]::NewGuid().ToString('N')
            $temp = Join-Path ([IO.Path]::GetDirectoryName($path)) ('.wml-updater-write-' + $token + '.tmp')
            $stream = [IO.File]::Open($temp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            $writers[$token] = @{path=$request.path;temp=$temp;stream=$stream;exclusive=($request.op -eq 'begin-new')}
            return @{token=$token}
        }
        'remove' { Need ([IO.File]::Exists($path)) 'File not found.' 'NotFoundError'; [IO.File]::Delete($path); return @{} }
        default { throw 'Unsupported native operation.' }
    }
}
try {
    while ($true) {
        $prefix = ExactRead 4
        if ($null -eq $prefix) { break }
        $length = [BitConverter]::ToUInt32($prefix, 0)
        Need ($length -gt 0 -and $length -le 524288) 'Native request is too large.'
        $bytes = ExactRead $length
        Need ($null -ne $bytes) 'Missing native request.'
        $request = $utf8.GetString($bytes) | ConvertFrom-Json
        Need ($request.id -is [ValueType] -and $request.id -gt 0 -and $request.id -le 2147483647) 'Invalid native request id.'
        try { $result = Dispatch $request; Reply @{id=$request.id;ok=$true;result=$result} }
        catch { Reply @{id=$request.id;ok=$false;error=$_.Exception.Message;name=$(if ($_.Exception.Data['name']) { $_.Exception.Data['name'] } else { 'Error' })} }
    }
} catch { [Console]::Error.WriteLine('WML native helper stopped: ' + $_.Exception.Message) }
finally {
    if ($defenderScan) { try { DropDefenderScan } catch {} }
    foreach ($token in @($writers.Keys)) { try { DropWriter $token } catch {} }
    if ($gameRollback) { try { RestoreGameTransaction } catch { [Console]::Error.WriteLine('Game recovery failed. Backup: ' + $gameBackup) } }
    if ($selfLease) { $selfLease.Dispose() }
}
