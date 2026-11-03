param([string]$Origin, [switch]$RecoverAfterTimeout, [Parameter(ValueFromRemainingArguments=$true)]$BrowserArguments)
$ErrorActionPreference = 'Stop'
if ($Origin -ne 'chrome-extension://dlddgdefgecebmfhjinfamnffjkgohao/') { exit 1 }
if ($RecoverAfterTimeout) { Start-Sleep -Seconds 125 }
$root = [IO.Path]::GetFullPath($PSScriptRoot)
function Checked([string]$name) {
    $path = [IO.Path]::GetFullPath((Join-Path $root $name))
    if (-not $path.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid installation path.' }
    $part = $path
    while ($part) {
        if ((Test-Path -LiteralPath $part) -and ((Get-Item -LiteralPath $part -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Linked installation path.' }
        $part = [IO.Path]::GetDirectoryName($part)
    }
    return $path
}
try {
    $current = Checked 'extension'; $previous = Checked 'previous'; $journal = Checked 'self-update-pending.json'
    if ([IO.File]::Exists($journal)) {
        $pending = [IO.File]::ReadAllText($journal) | ConvertFrom-Json
        $age = ([DateTime]::UtcNow - [DateTime]::Parse($pending.startedAt).ToUniversalTime()).TotalSeconds
        $recover = $pending.phase -ne 'swapped' -or $age -lt 0 -or $age -gt 120 -or -not [IO.Directory]::Exists($current)
        if ($recover) {
        $guard = [IO.File]::Open((Checked 'self-update.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        try {
            $pending = [IO.File]::ReadAllText($journal) | ConvertFrom-Json
            $age = ([DateTime]::UtcNow - [DateTime]::Parse($pending.startedAt).ToUniversalTime()).TotalSeconds
            # The new worker must acknowledge startup before the recovery timeout.
            if ($pending.phase -ne 'swapped' -or $age -lt 0 -or $age -gt 120 -or -not [IO.Directory]::Exists($current)) {
                if ([IO.Directory]::Exists($previous)) {
                    if ([IO.Directory]::Exists($current)) { [IO.Directory]::Move($current, (Checked ('failed-' + [Guid]::NewGuid().ToString('N')))) }
                    [IO.Directory]::Move($previous, $current)
                }
                $result = @{state='rolled-back';version=$pending.version;message='The new version did not finish startup. The previous version was restored.'}
                [IO.File]::WriteAllText((Checked 'self-update-result.json'), ($result | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
                [IO.File]::Delete($journal)
            }
        } finally { $guard.Dispose() }
        }
    }
    if ($RecoverAfterTimeout) { exit 0 }
    $hostScript = Checked 'extension/native-host.ps1'
    & $hostScript $Origin @BrowserArguments
} catch { [Console]::Error.WriteLine('WML updater startup: ' + $_.Exception.Message); exit 1 }
