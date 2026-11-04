[CmdletBinding()]
param(
    [switch]$ValidateOnly,
    [string]$DestinationRoot,
    [switch]$NoLaunch
)
$ErrorActionPreference = 'Stop'
function FileHash([string]$Path) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try { [Convert]::ToBase64String($algorithm.ComputeHash($stream)) }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}

# Copy only the user distribution: extension, user guide, and launcher.
$files = @(
    'manifest.json', 'worker.mjs', 'core.mjs', 'game-compat.mjs', 'mod-names-ko.mjs', 'game-bridge.js', 'wml-reader.js',
    'installer.mjs', 'folder-store.mjs', 'kio.js', 'kio-api.mjs', 'update.html', 'update.css', 'update.mjs',
    'vendor/cbor-x-1.6.4.mjs', 'vendor/cbor-x-LICENSE', 'THIRD_PARTY_NOTICES.md',
    'native-filesystem.mjs', 'native-host.ps1', 'native-host.cmd', 'native-install.ps1', 'defender-scan.mjs', 'native-defender.ps1',
    'self-update.mjs', 'self-update-config.json', 'native-self-update.ps1', 'native-bootstrap.ps1', 'native-bootstrap.cmd',
  'game-release.mjs','game-installer.mjs','game-update-ui.mjs','native-game-update.ps1',
    'GUIDE.html', 'Install.cmd', 'install.ps1'
)
foreach ($relative in $files) {
    $source = Join-Path $PSScriptRoot $relative
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "필수 파일이 없습니다: $relative. ZIP 전체를 먼저 압축 해제해 주세요." }
    $item = Get-Item -LiteralPath $source
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "연결된 파일은 설치할 수 없습니다. 원본 파일이 필요합니다: $relative" }
}
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.manifest_version -ne 3 -or $manifest.version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw '올바른 모드 업데이트 도우미 배포 파일이 아닙니다.' }
if ($ValidateOnly) {
    Write-Output "배포 파일 $($files.Count)개를 확인했습니다. 파일 복사와 창 열기는 실행하지 않았습니다."
    return
}

$browser = $null
if (-not $NoLaunch) {
    Write-Host ('모드 업데이트 도우미 ' + $manifest.version + ' 설치')
    Write-Host '게임을 실행하는 브라우저를 선택해 주세요.'
    Write-Host '1. 구글 크롬 (Google Chrome)'
    Write-Host '2. 마이크로소프트 엣지 (Microsoft Edge)'
    $choice = Read-Host '브라우저 번호 입력 (1 또는 2)'
    if ($choice -notin @('1', '2')) { throw '1 또는 2를 입력해 주세요. 설치는 진행하지 않았습니다.' }
    $browser = if ($choice -eq '1') { 'chrome' } else { 'msedge' }
}
if (-not $DestinationRoot) {
    if (-not $env:LOCALAPPDATA) { throw 'Windows 사용자 앱 데이터 폴더(LOCALAPPDATA)를 찾을 수 없습니다.' }
    $DestinationRoot = Join-Path $env:LOCALAPPDATA 'ModUpdateHelper'
}
if (-not [IO.Path]::IsPathRooted($DestinationRoot)) { throw '설치 위치(DestinationRoot)는 드라이브를 포함한 전체 경로여야 합니다.' }
$root = [IO.Path]::GetFullPath($DestinationRoot).TrimEnd('\', '/')
$ancestor = $root
while ($ancestor) {
    if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '연결된 설치 경로는 사용할 수 없습니다.' }
    $ancestor = [IO.Path]::GetDirectoryName($ancestor)
}

$name = 'extension'
$target = [IO.Path]::GetFullPath((Join-Path $root $name))
if (-not $target.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw '대상 경로가 지정한 설치 폴더를 벗어났습니다.' }
if (Test-Path -LiteralPath $target) { throw '대상 폴더가 이미 있습니다. 기존 설치를 덮어쓰지 않고 중단합니다.' }
if (Test-Path -LiteralPath $root) {
    $rootItem = Get-Item -LiteralPath $root
    if (-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '설치 위치는 바로가기나 연결 폴더가 아닌 일반 폴더여야 합니다.' }
} else { New-Item -ItemType Directory -Path $root | Out-Null }
New-Item -ItemType Directory -Path $target | Out-Null
foreach ($relative in $files) {
    $destination = [IO.Path]::GetFullPath((Join-Path $target $relative))
    if (-not $destination.StartsWith($target + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw '파일을 복사할 대상 경로가 올바르지 않습니다.' }
    $parent = Split-Path -Parent $destination
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $relative) -Destination $destination -ErrorAction Stop
    if ((FileHash (Join-Path $PSScriptRoot $relative)) -ne (FileHash $destination)) { throw "복사한 파일이 원본과 다릅니다. 설치를 중단합니다: $relative" }
}
foreach ($name in @('native-bootstrap.cmd',
  'game-release.mjs','game-installer.mjs','game-update-ui.mjs','native-game-update.ps1','native-bootstrap.ps1')) {
    Copy-Item -LiteralPath (Join-Path $target $name) -Destination (Join-Path $root $name)
}
$marker = @{schema=1;extensionId='dlddgdefgecebmfhjinfamnffjkgohao'}
[IO.File]::WriteAllText((Join-Path $root 'installation.json'), ($marker | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
# Isolated -NoLaunch checks create the host manifest without changing browser registration.
& (Join-Path $target 'native-install.ps1') -ExtensionDirectory $target -NoRegister:$NoLaunch
Write-Host ''
Write-Host '파일 복사를 마쳤습니다. 브라우저에서 아래 순서대로 설치를 완료해 주세요.'
Write-Host '1. 확장 프로그램 관리 화면에서 [개발자 모드]를 켭니다.'
Write-Host '2. [압축해제된 확장 프로그램을 로드합니다]를 누르고 아래 폴더를 선택합니다.'
Write-Output $target
Write-Host '3. [모드 업데이트 도우미]의 [세부정보]를 엽니다.'
Write-Host '4. [파일 URL에 대한 액세스 허용]을 켭니다.'
Write-Host '5. 게임 탭을 열어 둔 채 확장 프로그램 아이콘을 누릅니다.'
Write-Host '로컬 드라이브의 게임 폴더는 자동 연결됩니다. 다른 폴더를 쓰려면 도우미의 경로 변경을 선택하세요.'
Write-Host '최초 로드와 권한 허용 후에는 서명된 새 버전을 자동으로 적용합니다. 업데이트 창을 닫으면 도우미만 다시 시작합니다.'
Write-Host '자세한 사용법은 복사된 폴더의 GUIDE.html을 열어 확인할 수 있습니다.'
if (-not $NoLaunch) {
    Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $target + '"')
    $extensionsURL = if ($browser -eq 'chrome') { 'chrome://extensions' } else { 'edge://extensions' }
    $candidates = if ($browser -eq 'chrome') {
        @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe", "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe")
    } else {
        @("$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe", "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe")
    }
    $executable = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (-not $executable) {
        $command = Get-Command ($browser + '.exe') -ErrorAction SilentlyContinue
        if ($command) { $executable = $command.Source }
    }
    if ($executable) {
        try { Start-Process -FilePath $executable -ArgumentList $extensionsURL }
        catch { Write-Warning "브라우저를 자동으로 열지 못했습니다. 주소창에 $extensionsURL 을 직접 입력해 주세요. 오류: $($_.Exception.Message)" }
    } else { Write-Warning "브라우저 실행 파일을 찾지 못했습니다. 브라우저 주소창에 $extensionsURL 을 직접 입력해 주세요." }
}
