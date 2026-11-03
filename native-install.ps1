[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ExtensionDirectory, [switch]$NoRegister)
$ErrorActionPreference = 'Stop'
$directory = [IO.Path]::GetFullPath($ExtensionDirectory)
foreach ($name in @('native-host.cmd', 'native-host.ps1', 'manifest.json')) {
    $item = Get-Item -LiteralPath (Join-Path $directory $name)
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Invalid native helper file: $name" }
}
$extension = Get-Content -LiteralPath (Join-Path $directory 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$sha = [Security.Cryptography.SHA256]::Create()
try { $digest = $sha.ComputeHash([Convert]::FromBase64String($extension.key)) } finally { $sha.Dispose() }
$extensionId = -join ($digest[0..15] | ForEach-Object { [char](97 + ($_ -shr 4)); [char](97 + ($_ -band 15)) })
if ($extensionId -ne 'dlddgdefgecebmfhjinfamnffjkgohao') { throw 'The extension key does not match this native helper.' }
$hostRoot = $directory; $launcher = Join-Path $directory 'native-host.cmd'
$parent = [IO.Path]::GetDirectoryName($directory)
if ([IO.Path]::GetFileName($directory) -eq 'extension' -and [IO.File]::Exists((Join-Path $parent 'installation.json'))) {
    $hostRoot = $parent; $launcher = Join-Path $parent 'native-bootstrap.cmd'
}
$hostManifest = Join-Path $hostRoot 'org.wml.mod_updater.json'
$data = @{ name='org.wml.mod_updater'; description='Mod Update Helper'; path=$launcher; type='stdio'; allowed_origins=@("chrome-extension://$extensionId/") }
[IO.File]::WriteAllText($hostManifest, ($data | ConvertTo-Json -Depth 3), (New-Object Text.UTF8Encoding($false)))
if (-not $NoRegister) {
    foreach ($browser in @('Google\Chrome', 'Microsoft\Edge')) {
        $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Software\$browser\NativeMessagingHosts\org.wml.mod_updater")
        try { $key.SetValue('', $hostManifest, [Microsoft.Win32.RegistryValueKind]::String) } finally { $key.Dispose() }
    }
}
Write-Output $(if ($NoRegister) { 'Native helper manifest prepared; registry unchanged.' } else { 'Native helper registered for Chrome and Edge (current Windows user).' })
