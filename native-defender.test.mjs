import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const dir=path.dirname(fileURLToPath(import.meta.url));
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'wml-scan-test-'));
const script=path.join(temporary,'test.ps1');
fs.writeFileSync(script,String.raw`
param([string]$Source)
$ErrorActionPreference='Stop'
function Need($condition,[string]$message) { if(-not $condition) { throw $message } }
function CheckAncestors([string]$path) {}
function Assert($condition,[string]$message) { if(-not $condition) {throw $message} }
function Reject($action) { $failed=$false;try {& $action}catch {$failed=$true};Assert $failed 'Expected rejection' }
. $Source
$script:defenderScan=$null
$script:scanCalled=$false
function Get-MpComputerStatus { throw 'Status unavailable' }
Reject {DefenderScanFile 'unused.zip'}
function Get-MpComputerStatus { return @{AMServiceEnabled=$false;AntivirusEnabled=$false;AMRunningMode='Passive'} }
Reject {DefenderScanFile 'unused.zip'}
function DefenderScanFile([string]$path) {
  $script:scanCalled=$true
  $reader=New-Object IO.StreamReader([IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite))
  try { Assert ($reader.ReadToEnd() -eq 'abc') 'Wrong scan bytes' } finally { $reader.Dispose() }
  try { $writer=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite);$writer.Dispose();throw 'Mutable scan data' }
  catch [IO.IOException] {}
}
$digest='ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
Reject {DefenderDispatch @{op='scan-begin';size=536870913;sha256=$digest}}
$start=DefenderDispatch @{op='scan-begin';size=3;sha256=$digest}
$location=$script:defenderScan.directory
Reject {DefenderDispatch @{op='scan-chunk';token='other';data='YWJj'}}
DefenderDispatch @{op='scan-chunk';token=$start.token;data='YWJj'} | Out-Null
$result=DefenderDispatch @{op='scan-finish';token=$start.token}
Assert ($result.state -eq 'clean' -and $script:scanCalled) 'Clean result missing'
Assert (-not [IO.Directory]::Exists($location)) 'Scan directory was not removed'
$script:scanCalled=$false
$start=DefenderDispatch @{op='scan-begin';size=3;sha256=('0'*64)}
$location=$script:defenderScan.directory
DefenderDispatch @{op='scan-chunk';token=$start.token;data='YWJj'} | Out-Null
Reject {DefenderDispatch @{op='scan-finish';token=$start.token}}
Assert (-not $script:scanCalled -and -not [IO.Directory]::Exists($location)) 'Changed data was scanned or left behind'
$start=DefenderDispatch @{op='scan-begin';size=3;sha256=$digest}
$location=$script:defenderScan.directory
DefenderDispatch @{op='scan-abort';token=$start.token} | Out-Null
Assert (-not [IO.Directory]::Exists($location)) 'Aborted scan was not removed'
$start=DefenderDispatch @{op='scan-begin';size=3;sha256=$digest}
$location=$script:defenderScan.directory
DefenderDispatch @{op='scan-chunk';token=$start.token;data='YWJj'} | Out-Null
function DefenderScanFile([string]$path) {throw 'Threat or scan error'}
Reject {DefenderDispatch @{op='scan-finish';token=$start.token}}
Assert (-not [IO.Directory]::Exists($location)) 'Failed scan was not removed'
Write-Output 'Defender upload: bounded bytes, hash, write lock, failure and cleanup passed.'
`);
try {
  const output=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,path.join(dir,'native-defender.ps1')],{encoding:'utf8',windowsHide:true,timeout:30000});
  assert.match(output,/cleanup passed/);
  console.log(output.trim());
} finally { fs.rmSync(temporary,{recursive:true,force:true}); }
