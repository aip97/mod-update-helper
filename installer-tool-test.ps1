$ErrorActionPreference = 'Stop'
$testRoot = Join-Path $PSScriptRoot ('test-output/install-tool-' + [Guid]::NewGuid().ToString('N'))
$fixture = Join-Path $testRoot 'distribution'
$destination = Join-Path $testRoot 'installed'
New-Item -ItemType Directory -Path $fixture, $destination | Out-Null
$files = @(
    'manifest.json', 'worker.mjs', 'core.mjs', 'game-compat.mjs', 'mod-names-ko.mjs', 'game-bridge.js', 'wml-reader.js', 'installer.mjs',
    'folder-store.mjs', 'kio.js', 'kio-api.mjs', 'update.html', 'update.css', 'update.mjs',
    'vendor/cbor-x-1.6.4.mjs', 'vendor/cbor-x-LICENSE', 'THIRD_PARTY_NOTICES.md',
    'native-filesystem.mjs', 'native-host.ps1', 'native-host.cmd', 'native-install.ps1', 'defender-scan.mjs', 'native-defender.ps1',
    'self-update.mjs','self-update-config.json','native-self-update.ps1','native-bootstrap.ps1','native-bootstrap.cmd',
  'game-release.mjs','game-installer.mjs','game-update-ui.mjs','native-game-update.ps1',
    'GUIDE.html', 'Install.cmd', 'install.ps1'
)
foreach ($relative in $files) {
    $file = Join-Path $fixture $relative
    $parent = Split-Path -Parent $file
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent | Out-Null }
    if ($relative -in @('Install.cmd', 'install.ps1', 'native-install.ps1', 'native-host.cmd', 'native-host.ps1', 'manifest.json')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $relative) -Destination $file }
    elseif ($relative -eq 'GUIDE.html') { Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'USER_GUIDE.html') -Destination $file }
    else { Set-Content -LiteralPath $file -Value ('Fixture ' + $relative) -Encoding UTF8 }
}
Set-Content -LiteralPath (Join-Path $fixture 'private.txt') -Value 'MUST NOT COPY'
Set-Content -LiteralPath (Join-Path $fixture 'AI_MOD_INTEGRATION.md') -Value 'MUST NOT COPY'
Set-Content -LiteralPath (Join-Path $destination 'existing.txt') -Value 'PRESERVE'
$script = Join-Path $fixture 'install.ps1'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -ValidateOnly
if ($LASTEXITCODE -ne 0) { throw 'ValidateOnly failed.' }
if (@(Get-ChildItem -LiteralPath $destination).Count -ne 1) { throw 'Validation copied files.' }
1..1 | ForEach-Object {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -DestinationRoot $destination -NoLaunch
    if ($LASTEXITCODE -ne 0) { throw 'Isolated installation failed.' }
}
$installs = @(Get-ChildItem -LiteralPath $destination -Directory)
if ($installs.Count -ne 1) { throw 'Installation folders were not unique.' }
foreach ($install in $installs) {
    if (@(Get-ChildItem -LiteralPath $install.FullName -File -Recurse).Count -ne $files.Count) { throw 'Unexpected copied file count.' }
    if (-not (Test-Path -LiteralPath (Join-Path $destination 'org.wml.mod_updater.json'))) { throw 'Native host manifest missing.' }
    if (Test-Path -LiteralPath (Join-Path $install.FullName 'private.txt')) { throw 'Unlisted file was copied.' }
    if (Test-Path -LiteralPath (Join-Path $install.FullName 'AI_MOD_INTEGRATION.md')) { throw 'Developer documentation was copied.' }
    $copiedGuide = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $install.FullName 'GUIDE.html')))
    $sourceGuide = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $PSScriptRoot 'USER_GUIDE.html')))
    if ($copiedGuide -ne $sourceGuide) { throw 'User guide mapping changed.' }
}
if ((Get-Content -LiteralPath (Join-Path $destination 'existing.txt')) -ne 'PRESERVE') { throw 'Existing files changed.' }
Rename-Item -LiteralPath (Join-Path $fixture 'worker.mjs') -NewName 'worker.missing'
$ErrorActionPreference = 'Continue'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -ValidateOnly 2>&1 | Out-Null
$ErrorActionPreference = 'Stop'
if ($LASTEXITCODE -eq 0) { throw 'Missing required file accepted.' }
Write-Host "Installer tool tests passed. Isolated artifacts: $testRoot"
