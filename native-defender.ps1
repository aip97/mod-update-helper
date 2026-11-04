function NewDefenderFile {
    $directory = Join-Path ([IO.Path]::GetTempPath()) ('wml-updater-scan-' + [Guid]::NewGuid().ToString('N'))
    CheckAncestors ([IO.Path]::GetDirectoryName($directory))
    [void][IO.Directory]::CreateDirectory($directory)
    try {
        CheckAncestors $directory
        $path = Join-Path $directory 'download.zip'
        $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
        return @{directory=$directory;path=$path;stream=$stream}
    } catch { [IO.Directory]::Delete($directory); throw }
}
function RemoveDefenderFile($scan) {
    if ($scan.stream) { $scan.stream.Dispose() }
    CheckAncestors $scan.directory
    if ([IO.File]::Exists($scan.path)) { [IO.File]::Delete($scan.path) }
    if ([IO.Directory]::Exists($scan.directory)) { [IO.Directory]::Delete($scan.directory) }
}
function DefenderScanFile([string]$path) {
    try { $status = Get-MpComputerStatus -ErrorAction Stop }
    catch { throw 'Microsoft Defender status could not be checked; update blocked.' }
    if (-not $status.AMServiceEnabled -or -not $status.AntivirusEnabled -or $status.AMRunningMode -ne 'Normal') { throw 'Microsoft Defender antivirus is not active; update blocked.' }
    $platform = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'Microsoft/Windows Defender/Platform'
    $tools = @()
    if ([IO.Directory]::Exists($platform)) {
        $tools = @(Get-ChildItem -LiteralPath $platform -Directory | Where-Object { $_.Name -match '^\d+(?:\.\d+){3}(?:-\d+)?$' } | Sort-Object { [version]($_.Name.Split('-')[0]) } -Descending | ForEach-Object { Join-Path $_.FullName 'MpCmdRun.exe' })
    }
    $tools += Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'Windows Defender/MpCmdRun.exe'
    $tool = $tools | Where-Object { [IO.File]::Exists($_) } | Select-Object -First 1
    if (-not $tool) { throw 'Microsoft Defender scanner is unavailable; update blocked.' }
    CheckAncestors $tool
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $tool; $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    $start.Arguments = '-Scan -ScanType 3 -File "' + $path + '" -DisableRemediation'
    $process = [Diagnostics.Process]::Start($start)
    if (-not $process) { throw 'Microsoft Defender scanner could not start; update blocked.' }
    try {
        $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(300000)) { $process.Kill(); $process.WaitForExit(); throw 'Microsoft Defender scan timed out; update blocked.' }
        if ($process.ExitCode -ne 0) { throw 'Microsoft Defender detected a threat or could not complete the scan; update blocked.' }
    } finally { $process.Dispose() }
}
function DefenderScanBytes([byte[]]$bytes) {
    $file = NewDefenderFile
    try {
        $file.stream.Write($bytes, 0, $bytes.Length); $file.stream.Flush($true)
        DefenderScanFile $file.path
    } finally { RemoveDefenderFile $file }
}
function DropDefenderScan {
    if ($script:defenderScan) {
        $scan = $script:defenderScan; $script:defenderScan = $null
        RemoveDefenderFile $scan
    }
}
function DefenderDispatch($request) {
    switch ($request.op) {
        'scan-begin' {
            Need ($null -eq $script:defenderScan) 'A scan is already in progress.'
            Need ($request.size -is [ValueType] -and $request.size -gt 0 -and $request.size -le 536870912 -and [Math]::Floor($request.size) -eq $request.size) 'Invalid scan size.'
            Need ($request.sha256 -is [string] -and $request.sha256 -cmatch '^[a-f0-9]{64}$') 'Invalid scan hash.'
            $scan = NewDefenderFile
            $scan.token = [Guid]::NewGuid().ToString('N'); $scan.size = [long]$request.size; $scan.sha256 = $request.sha256
            $script:defenderScan = $scan
            return @{token=$scan.token}
        }
        { $_ -in @('scan-chunk','scan-finish','scan-abort') } {
            Need ($script:defenderScan -and $request.token -is [string] -and $request.token -ceq $script:defenderScan.token) 'Unknown scan transaction.'
            $scan = $script:defenderScan
            if ($request.op -eq 'scan-abort') { DropDefenderScan; return @{} }
            if ($request.op -eq 'scan-chunk') {
                Need ($request.data -is [string] -and $request.data.Length -le 349528) 'Invalid scan chunk.'
                $bytes = [Convert]::FromBase64String($request.data)
                Need ($bytes.Length -gt 0 -and $bytes.Length -le 262144 -and $scan.stream.Length + $bytes.Length -le $scan.size) 'Scan chunk exceeds declared size.'
                $scan.stream.Write($bytes, 0, $bytes.Length)
                return @{}
            }
            try {
                Need ($scan.stream.Length -eq $scan.size) 'Scan data is incomplete.'
                $scan.stream.Flush($true); $scan.stream.Position = 0
                $sha = [Security.Cryptography.SHA256]::Create()
                try { $hash = -join ($sha.ComputeHash($scan.stream) | ForEach-Object { $_.ToString('x2') }) } finally { $sha.Dispose() }
                Need ($hash -ceq $scan.sha256) 'Scan data hash mismatch.'
                DefenderScanFile $scan.path
                return @{state='clean'}
            } finally { DropDefenderScan }
        }
        default { throw 'Unsupported scan operation.' }
    }
}
