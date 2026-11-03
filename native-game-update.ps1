function script:GameHash([string]$path) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($path)
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}
function script:GameDispatch($request) {
    Need ($null -ne $gameRoot) 'Connect a game first.'
    if ($request.op -eq 'game-authorize') {
        Need (-not $gameBackup -and $request.paths -is [array] -and $request.paths.Count -gt 0 -and $request.paths.Count -le 8192) 'Invalid game file list or repeated authorization.'
        Need ($request.backupPath -is [string] -and $request.backupPath -cmatch '^\.wml-game-updater-backups/[0-9a-f-]{36}$') 'Invalid game backup path.'
        $paths = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        foreach ($relative in $request.paths) {
            Need ($relative -is [string] -and $relative.Length -le 1000 -and $relative -notmatch '[\\:\x00-\x1f<>"|?*]' -and $relative -notmatch '^/|/$|//') 'Invalid game path.'
            foreach ($part in $relative.Split('/')) { Need ($part -notmatch '^\.|[. ]$|^(?i:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)') 'Invalid game path component.' }
            Need ($relative -notmatch '^(?:wml/(?:mods|presets)|image-packs)(?:/|$)' -and $relative -notmatch '(?:^|/)(?:saves?|savedata|userdata|user-data|profiles?|cache|caches|backups?|logs?|node_modules)(?:/|$)' -and $relative -notmatch '(?:^|/)(?:[^/]+\.)?(?:config|settings)\.json$' -and $relative -notmatch '(?:^|/)[^/]*(?:server|imagegen)[^/]*/images(?:/|$)') 'Game user data cannot be replaced.'
            Need ($relative -match '\.(?:html?|[cm]?js|ts|json|css|md|txt|png|jpe?g|webp|gif|avif|svg|ico|woff2?|ttf|otf|mp3|ogg|wav|m4a|mp4|webm|lock|cmd|bat|ps1)$' -or $relative -match '(?:^|/)LICENSE(?:\.[\w-]+)?$') 'Unsupported game file type.'
            Need ($paths.Add($relative)) 'Duplicate game path.'
        }
        Need ($paths.Contains($gameName) -and $paths.Contains('wml/runtime/wml-core.js')) 'Game HTML and runtime are required.'
        foreach ($relative in $paths) { $parts = $relative.Split('/'); for ($i=1; $i -lt $parts.Count; $i++) { Need (-not $paths.Contains(($parts[0..($i-1)] -join '/'))) 'Game file and directory collision.' } }
        $script:gameBackup = $request.backupPath
        $script:gameFiles = $paths
        foreach ($relative in @($paths) + @($paths | ForEach-Object { $gameBackup + '/' + $_ }) + @($gameBackup + '/manifest.json')) {
            [void]$gamePaths.Add($relative)
            $parts = $relative.Split('/')
            for ($i=1; $i -lt $parts.Count; $i++) { [void]$gameDirectories.Add(($parts[0..($i-1)] -join '/')) }
        }
        foreach ($relative in $gamePaths) { [void](ResolveRelative $relative) }
        return @{}
    }
    Need ($null -ne $gameBackup) 'Game paths have not been approved.'
    if ($request.op -eq 'game-finish') { $script:gameRollback = $null; return @{} }
    Need ($null -eq $gameRollback) 'Game transaction is already active.'
    $manifestPath = ResolveRelative ($gameBackup + '/manifest.json')
    Need ((FileInfo $manifestPath).size -le 4194304) 'Game backup manifest is too large.'
    $manifest = [IO.File]::ReadAllText($manifestPath, $utf8) | ConvertFrom-Json
    Need ($manifest.schema -eq 1 -and $manifest.gameFile -ceq $gameName -and $manifest.files.Count -eq $gameFiles.Count) 'Invalid game backup manifest.'
    $seen = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $total = 0L
    foreach ($entry in $manifest.files) {
        Need ($entry.path -is [string] -and $gameFiles.Contains($entry.path) -and $seen.Add($entry.path)) 'Invalid game backup entry.'
        if ($null -ne $entry.original) {
            Need ($entry.original.length -is [ValueType] -and $entry.original.length -ge 0 -and $entry.original.length -le 67108864 -and $entry.original.sha256 -cmatch '^[0-9a-f]{64}$') 'Invalid backup hash.'
            $backup = ResolveRelative ($gameBackup + '/' + $entry.path)
            $total += $entry.original.length
            Need ($total -le 1073741824 -and (FileInfo $backup).size -eq $entry.original.length -and (GameHash $backup) -eq $entry.original.sha256) 'Game backup is missing or corrupt.'
        }
    }
    $script:gameRollback = $manifest.files
    return @{}
}
function script:RestoreGameTransaction {
    # A closed updater window disconnects the pipe; restore before this host exits.
    foreach ($entry in ($gameRollback | Sort-Object { $_.path -ceq $gameName })) {
        $target = ResolveRelative $entry.path -Write
        if ($null -eq $entry.original) { if ([IO.File]::Exists($target)) { [IO.File]::Delete($target) }; continue }
        $backup = ResolveRelative ($gameBackup + '/' + $entry.path)
        Need ((FileInfo $backup).size -eq $entry.original.length -and (GameHash $backup) -eq $entry.original.sha256) 'Recovery backup is corrupt.'
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
        $temp = $target + '.restore-' + [Guid]::NewGuid().ToString('N')
        [IO.File]::Copy($backup, $temp, $false)
        if ([IO.File]::Exists($target)) { [IO.File]::Replace($temp, $target, [NullString]::Value) } else { [IO.File]::Move($temp, $target) }
    }
    $script:gameRollback = $null
}
