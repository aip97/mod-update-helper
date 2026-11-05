# This file is loaded only by our registered native host, never by game content.
$SelfExtensionId = 'dlddgdefgecebmfhjinfamnffjkgohao'
function SelfNeed($condition, [string]$message) { if (-not $condition) { throw $message } }
function SelfPath([string]$root, [string]$relative) {
    SelfNeed ($relative -and $relative -notmatch '[\\:\x00-\x1f<>"|?*]' -and $relative -notmatch '^/|/$|//') 'Invalid update path.'
    foreach ($part in $relative.Split('/')) {
        SelfNeed ($part -notin @('.', '..') -and $part -notmatch '[. ]$|^(?i:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)') 'Invalid update path component.'
    }
    $full = [IO.Path]::GetFullPath((Join-Path $root $relative))
    SelfNeed ($full.StartsWith($root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) 'Update path leaves installation.'
    CheckAncestors $full
    return $full
}
function SelfRoot {
    $root = [IO.Path]::GetDirectoryName($PSScriptRoot)
    SelfNeed ([IO.Path]::GetFileName($PSScriptRoot) -eq 'extension') 'SELF_SETUP_REQUIRED: Install.cmd 0.7.0 or later is required once.'
    $marker = SelfPath $root 'installation.json'
    SelfNeed ([IO.File]::Exists($marker)) 'SELF_SETUP_REQUIRED: The fixed installation is not registered.'
    $info = [IO.File]::ReadAllText($marker) | ConvertFrom-Json
    SelfNeed ($info.schema -eq 1 -and $info.extensionId -ceq $SelfExtensionId) 'Invalid installation marker.'
    return $root
}
function SelfWriteJson([string]$path, $value) {
    CheckAncestors $path
    $temp = $path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::WriteAllText($temp, ($value | ConvertTo-Json -Compress -Depth 8), (New-Object Text.UTF8Encoding($false)))
    if ([IO.File]::Exists($path)) { [IO.File]::Replace($temp, $path, [NullString]::Value) } else { [IO.File]::Move($temp, $path) }
}
function SelfRemoveTree([string]$root, [string]$relative) {
    $path = SelfPath $root $relative
    if (-not [IO.Directory]::Exists($path)) { return }
    # Never follow junctions while deleting an old updater backup or staging directory.
    $scan = New-Object 'Collections.Generic.Queue[string]'; $scan.Enqueue($path)
    while ($scan.Count) {
        foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($scan.Dequeue())) {
            $attr = [IO.File]::GetAttributes($entry)
            SelfNeed (($attr -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'Linked update directory cannot be removed.'
            if ($attr -band [IO.FileAttributes]::Directory) { $scan.Enqueue($entry) }
        }
    }
    [IO.Directory]::Delete($path, $true)
}
function SelfHash([byte[]]$bytes) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() } finally { $hash.Dispose() }
}
function SelfVersion([string]$value) {
    SelfNeed ($value -cmatch '^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$') 'Invalid extension version.'
    SelfNeed (@($value.Split('.') | Where-Object { [int]$_ -gt 65535 }).Count -eq 0) 'Extension version exceeds browser limits.'
    return [Version]$value
}
function SelfConfig([string]$root) {
    $config = [IO.File]::ReadAllText((SelfPath $root 'extension/self-update-config.json')) | ConvertFrom-Json
    SelfNeed ($config.schema -eq 1) 'Unsupported updater configuration.'
    if (-not $config.repository -and $null -eq $config.publicKey) { return $null }
    SelfNeed ($config.repository -is [string] -and $config.repository -cmatch '^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$' -and $config.repository -notmatch '\.git$') 'Invalid GitHub repository.'
    SelfNeed ($config.publicKey.modulus -is [string] -and $config.publicKey.exponent -is [string]) 'Missing release verification key.'
    return $config
}
function SelfVerifyRelease([byte[]]$envelopeBytes, $config) {
    SelfNeed ($envelopeBytes.Length -le 131072) 'Release metadata is too large.'
    $encoding = New-Object Text.UTF8Encoding($false, $true)
    $envelope = $encoding.GetString($envelopeBytes) | ConvertFrom-Json
    SelfNeed ($envelope.payload -is [string] -and $envelope.signature -is [string]) 'Missing release signature.'
    $payload = [Convert]::FromBase64String($envelope.payload); $signature = [Convert]::FromBase64String($envelope.signature)
    $rsa = New-Object Security.Cryptography.RSACryptoServiceProvider
    try {
        $rsa.PersistKeyInCsp = $false
        $parameters = New-Object Security.Cryptography.RSAParameters
        $parameters.Modulus = [Convert]::FromBase64String($config.publicKey.modulus); $parameters.Exponent = [Convert]::FromBase64String($config.publicKey.exponent)
        SelfNeed ($parameters.Modulus.Length -ge 256 -and $parameters.Modulus.Length -le 512) 'Unsupported release signing key.'
        $rsa.ImportParameters($parameters)
        SelfNeed ($rsa.VerifyData($payload, [Security.Cryptography.CryptoConfig]::MapNameToOID('SHA256'), $signature)) 'Release signature does not match the installed publisher key.'
    } finally { $rsa.Dispose() }
    $release = $encoding.GetString($payload) | ConvertFrom-Json
    SelfNeed ($release.schema -eq 1 -and $release.repository -ceq $config.repository -and $release.extensionId -ceq $SelfExtensionId) 'Release identity mismatch.'
    [void](SelfVersion $release.version)
    SelfNeed ($release.asset -ceq ('Mod-Update-Helper-User-' + $release.version + '.zip')) 'Unexpected release ZIP name.'
    SelfNeed ($release.size -is [ValueType] -and $release.size -gt 0 -and $release.size -le 16777216 -and $release.sha256 -cmatch '^[a-f0-9]{64}$') 'Invalid release size or hash.'
    SelfNeed ($release.files -is [Array] -and $release.files.Count -ge 10 -and $release.files.Count -le 100) 'Invalid release file list.'
    $paths = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($file in $release.files) {
        SelfNeed ($file.path -is [string] -and $file.path.Length -le 180 -and $paths.Add($file.path)) 'Duplicate or invalid release file.'
        [void](SelfPath ([IO.Path]::GetTempPath().TrimEnd('\')) $file.path)
        SelfNeed ($file.size -is [ValueType] -and $file.size -ge 0 -and $file.size -le 16777216 -and $file.sha256 -cmatch '^[a-f0-9]{64}$') 'Invalid release file size or hash.'
    }
    foreach ($name in @('manifest.json','worker.mjs','update.html','native-host.ps1','native-self-update.ps1','self-update-config.json')) { SelfNeed ($paths.Contains($name)) ('Missing release file: ' + $name) }
    return $release
}
function SelfReadRelease($request, $config) {
    # The extension reads the Kone release post and Kio collection; only the signed metadata is trusted here.
    SelfNeed ($request.envelope -is [string] -and $request.envelope.Length -gt 0 -and $request.envelope.Length -le 131072) 'Signed release metadata is missing.'
    return (SelfVerifyRelease ((New-Object Text.UTF8Encoding($false)).GetBytes($request.envelope)) $config)
}
function SelfUpload($request) {
    SelfNeed ($request.offset -is [ValueType] -and $request.total -is [ValueType] -and $request.total -gt 0 -and $request.total -le 16777216 -and [Math]::Floor($request.offset) -eq $request.offset -and $request.data -is [string] -and $request.data.Length -gt 0 -and $request.data.Length -le 262144) 'Invalid update upload.'
    if ($request.offset -eq 0) {
        if ($script:selfUpload) { $script:selfUpload.Dispose() }
        $script:selfUpload = New-Object IO.MemoryStream; $script:selfUploadTotal = [int64]$request.total
    }
    SelfNeed ($null -ne $script:selfUpload -and $request.offset -eq $script:selfUpload.Length -and $request.total -eq $script:selfUploadTotal) 'Update upload is out of order.'
    $bytes = [Convert]::FromBase64String($request.data)
    SelfNeed ($script:selfUpload.Length + $bytes.Length -le $script:selfUploadTotal) 'Update upload exceeds its declared size.'
    $script:selfUpload.Write($bytes, 0, $bytes.Length)
    return @{received=$script:selfUpload.Length}
}
function SelfTakeUpload {
    SelfNeed ($null -ne $script:selfUpload -and $script:selfUpload.Length -eq $script:selfUploadTotal) 'The update ZIP was not received.'
    try { return ,$script:selfUpload.ToArray() } finally { $script:selfUpload.Dispose(); $script:selfUpload = $null }
}
function SelfStage([string]$root, [byte[]]$zipBytes, $release, $config) {
    SelfNeed ($zipBytes.Length -eq $release.size -and (SelfHash $zipBytes) -ceq $release.sha256) 'Release ZIP hash or size mismatch.'
    if (-not (Get-Command DefenderScanBytes -ErrorAction SilentlyContinue)) { . (Join-Path $PSScriptRoot 'native-defender.ps1') }
    DefenderScanBytes $zipBytes
    Add-Type -AssemblyName System.IO.Compression
    $name = 'staging-' + [Guid]::NewGuid().ToString('N'); $stage = SelfPath $root $name
    [void][IO.Directory]::CreateDirectory($stage)
    $memory = New-Object IO.MemoryStream(,$zipBytes)
    $archive = New-Object IO.Compression.ZipArchive($memory, [IO.Compression.ZipArchiveMode]::Read)
    try {
        SelfNeed ($archive.Entries.Count -eq $release.files.Count) 'Release ZIP file list mismatch.'
        $expected = @{}; foreach ($file in $release.files) { $expected[$file.path] = $file }
        $seen = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase); $total = 0
        foreach ($entry in $archive.Entries) {
            $file = $expected[$entry.FullName]
            SelfNeed ($null -ne $file -and $file.path -ceq $entry.FullName -and $seen.Add($entry.FullName)) 'Unexpected or duplicate ZIP entry.'
            $target = SelfPath $stage $entry.FullName
            SelfNeed ((($entry.ExternalAttributes -shr 16) -band 0xF000) -ne 0xA000 -and $entry.Length -eq $file.size) 'Linked ZIP entry or wrong file size.'
            $total += $entry.Length; SelfNeed ($total -le 33554432) 'Expanded release is too large.'
            $source = $entry.Open(); $data = New-Object IO.MemoryStream
            try {
                $buffer = New-Object byte[] 65536
                while (($count = $source.Read($buffer,0,$buffer.Length)) -gt 0) {
                    SelfNeed ($data.Length + $count -le $file.size) 'ZIP file exceeds its declared size.'
                    $data.Write($buffer,0,$count)
                }
                $bytes = $data.ToArray()
                SelfNeed ($bytes.Length -eq $file.size -and (SelfHash $bytes) -ceq $file.sha256) 'Release file hash mismatch.'
                [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)); [IO.File]::WriteAllBytes($target,$bytes)
            } finally { $source.Dispose(); $data.Dispose() }
        }
        $manifest = [IO.File]::ReadAllText((SelfPath $stage 'manifest.json')) | ConvertFrom-Json
        $keyHash = SelfHash ([Convert]::FromBase64String($manifest.key))
        $id = -join ($keyHash.Substring(0,32).ToCharArray() | ForEach-Object { [char](97 + [Convert]::ToInt32($_.ToString(),16)) })
        SelfNeed ($manifest.manifest_version -eq 3 -and $manifest.version -ceq $release.version -and $id -ceq $SelfExtensionId) 'Extension manifest identity mismatch.'
        $nextConfig = [IO.File]::ReadAllText((SelfPath $stage 'self-update-config.json')) | ConvertFrom-Json
        SelfNeed ($nextConfig.schema -eq 1 -and $nextConfig.repository -ceq $config.repository -and $nextConfig.publicKey.modulus -ceq $config.publicKey.modulus -and $nextConfig.publicKey.exponent -ceq $config.publicKey.exponent) 'Publisher identity changed; manual migration is required.'
        return $name
    } catch { SelfRemoveTree $root $name; throw }
    finally { $archive.Dispose(); $memory.Dispose() }
}
function SelfSwap([string]$root, [string]$stageName, [string]$version) {
    SelfNeed ($stageName -cmatch '^staging-[a-f0-9]{32}$') 'Invalid staged update.'
    $stage = SelfPath $root $stageName; $current = SelfPath $root 'extension'; $previous = SelfPath $root 'previous'
    $journal = SelfPath $root 'self-update-pending.json'
    SelfNeed (-not [IO.File]::Exists($journal)) 'A previous update is waiting for startup confirmation.'
    SelfRemoveTree $root 'previous'
    $pending = @{phase='prepared';version=$version;startedAt=[DateTime]::UtcNow.ToString('o')}
    SelfWriteJson $journal $pending
    try {
        [IO.Directory]::Move($current,$previous)
        [IO.Directory]::Move($stage,$current)
        $pending.phase = 'swapped'; SelfWriteJson $journal $pending
    } catch {
        if ([IO.Directory]::Exists($previous)) {
            if ([IO.Directory]::Exists($current)) { [IO.Directory]::Move($current,(SelfPath $root ('failed-' + [Guid]::NewGuid().ToString('N')))) }
            [IO.Directory]::Move($previous,$current)
        }
        if ([IO.File]::Exists($journal)) { [IO.File]::Delete($journal) }
        throw
    }
}
function SelfDispatch($request) {
    $root = SelfRoot
    $manifest = [IO.File]::ReadAllText((SelfPath $root 'extension/manifest.json')) | ConvertFrom-Json
    $current = $manifest.version; [void](SelfVersion $current)
    if ($request.op -eq 'self-lease') {
        SelfNeed ($null -eq $script:selfLease) 'An updater window lease already exists.'
        try { $script:selfLease = [IO.File]::Open((SelfPath $root 'self-update.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::Read,[IO.FileShare]::Read) }
        catch { throw 'SELF_BUSY: The updater is being replaced.' }
        return @{state='idle';version=$current}
    }
    if ($request.op -eq 'self-confirm') {
        SelfNeed ($request.version -ceq $current) 'SELF_RESTART: The running extension version differs from the installed files.'
        $journal = SelfPath $root 'self-update-pending.json'
        if ([IO.File]::Exists($journal)) {
            $pending = [IO.File]::ReadAllText($journal) | ConvertFrom-Json
            SelfNeed ($pending.phase -eq 'swapped' -and $pending.version -ceq $current) 'Invalid update acknowledgement.'
            [IO.File]::Delete($journal)
            SelfWriteJson (SelfPath $root 'self-update-result.json') @{state='updated';version=$current}
        }
        return @{state='current';version=$current}
    }
    if ($request.op -eq 'self-upload') { return (SelfUpload $request) }
    $config = SelfConfig $root
    if ($null -eq $config) { return @{state='unconfigured';version=$current} }
    SelfNeed ($request.op -in @('self-check','self-apply')) 'Unsupported updater operation.'
    $guard = $null; $stage = $null
    try {
        if ($request.op -eq 'self-apply') {
            try { $guard = [IO.File]::Open((SelfPath $root 'self-update.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) }
            catch { return @{state='waiting';version=$current} }
            SelfNeed (-not [IO.File]::Exists((SelfPath $root 'self-update-pending.json'))) 'The last update is waiting for startup confirmation.'
        }
        $release = SelfReadRelease $request $config
        if ((SelfVersion $release.version) -le (SelfVersion $current)) { return @{state='current';version=$current} }
        $resultFile = SelfPath $root 'self-update-result.json'
        if ([IO.File]::Exists($resultFile)) {
            $result = [IO.File]::ReadAllText($resultFile) | ConvertFrom-Json
            if ($result.state -eq 'rolled-back' -and $result.version -ceq $release.version) { return @{state='blocked';version=$current;latest=$release.version} }
        }
        if ($request.op -eq 'self-check') { return @{state='available';version=$current;latest=$release.version} }
        $zip = SelfTakeUpload
        $stage = SelfStage $root $zip $release $config
        $bootstrap = SelfPath $root 'native-bootstrap.ps1'
        Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WindowStyle Hidden -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"' + $bootstrap + '"'),('chrome-extension://' + $SelfExtensionId + '/'),'-RecoverAfterTimeout') | Out-Null
        SelfSwap $root $stage $release.version; $stage = $null
        return @{state='updated';version=$release.version}
    } finally {
        if ($stage) { SelfRemoveTree $root $stage }
        if ($guard) { $guard.Dispose() }
    }
}
