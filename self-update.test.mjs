import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {writeZip} from './zip-tools.mjs';
import {signRelease,publicKeyOf} from './release.mjs';
const dir=path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(path.join(dir,'test-output'),{recursive:true});
const root=fs.mkdtempSync(path.join(dir,'test-output/self-update-'));
const current=path.join(root,'extension');fs.mkdirSync(current);
const {privateKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
const key=privateKey.export({type:'pkcs8',format:'pem'});
const config={schema:1,repository:'aip97/test-release',publicKey:publicKeyOf(key)};
const files=['manifest.json','worker.mjs','update.html','native-host.ps1','native-defender.ps1','native-self-update.ps1','self-update-config.json','core.mjs','installer.mjs','game-compat.mjs','self-update.mjs','helper-release.mjs'];
const manifest={...JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'))),version:'0.7.0'};
for(const name of files) fs.copyFileSync(path.join(dir,name),path.join(current,name));
fs.writeFileSync(path.join(current,'manifest.json'),JSON.stringify(manifest));
fs.writeFileSync(path.join(current,'self-update-config.json'),JSON.stringify(config));
fs.writeFileSync(path.join(root,'installation.json'),JSON.stringify({schema:1,extensionId:'dlddgdefgecebmfhjinfamnffjkgohao'}));
fs.copyFileSync(path.join(dir,'native-bootstrap.ps1'),path.join(root,'native-bootstrap.ps1'));
const next={...manifest,version:'0.7.1'};
const zip=path.join(root,'Mod-Update-Helper-User-0.7.1.zip');
writeZip(zip,files.map(name=>({name,data:name==='manifest.json'?Buffer.from(JSON.stringify(next)):fs.readFileSync(path.join(current,name))})));
const envelope=signRelease(zip,config,key);
fs.writeFileSync(path.join(root,'release.json'),JSON.stringify(envelope));
const payload=JSON.parse(Buffer.from(envelope.payload,'base64'));
assert.equal(payload.version,'0.7.1');assert.equal(payload.files.length,files.length);
assert.ok(crypto.verify('sha256',Buffer.from(envelope.payload,'base64'),crypto.createPublicKey(key),Buffer.from(envelope.signature,'base64')));
assert.throws(()=>signRelease(zip,{...config,publicKey:{modulus:'invalid',exponent:'AQAB'}},key));
const harness=String.raw`
$ErrorActionPreference='Stop'
$root=$PSScriptRoot
function CheckAncestors([string]$path) {
  $item=[IO.Path]::GetFullPath($path)
  while($item) {
    if ((Test-Path -LiteralPath $item) -and ((Get-Item -LiteralPath $item -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {throw 'Linked path'}
    $item=[IO.Path]::GetDirectoryName($item)
  }
}
function Assert($condition,$message) {if(-not $condition){throw $message}}
function Reject($action) { $failed=$false;try{& $action}catch{$failed=$true};Assert $failed 'Expected rejection' }
function DefenderScanBytes([byte[]]$bytes) { $script:scannedBytes=$bytes.Length }
. (Join-Path $root 'extension/native-self-update.ps1')
$config=Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'extension/self-update-config.json') | ConvertFrom-Json
$bytes=[IO.File]::ReadAllBytes((Join-Path $root 'release.json'))
$release=SelfVerifyRelease $bytes $config
$tampered=Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'release.json') | ConvertFrom-Json
$tampered.signature=[Convert]::ToBase64String((New-Object byte[] 256))
Reject {SelfVerifyRelease ([Text.Encoding]::UTF8.GetBytes(($tampered|ConvertTo-Json))) $config}
Reject {SelfPath $root '../outside'}
Reject {SelfPath $root 'extension/file:stream'}
Reject {SelfPath $root 'extension/con.txt'}
$zip=[IO.File]::ReadAllBytes((Join-Path $root $release.asset))
$fromPost=SelfReadRelease @{envelope=[IO.File]::ReadAllText((Join-Path $root 'release.json'))} $config
Assert ($fromPost.version -eq '0.7.1') 'Envelope passed by the extension was not verified'
Reject {SelfReadRelease @{} $config}
Reject {SelfTakeUpload}
$half=[int]($zip.Length/2)
$first=[Convert]::ToBase64String($zip,0,$half);$second=[Convert]::ToBase64String($zip,$half,$zip.Length-$half)
Reject {SelfUpload @{offset=5;total=$zip.Length;data=$first}}
[void](SelfUpload @{offset=0;total=$zip.Length;data=$first})
Reject {SelfUpload @{offset=1;total=$zip.Length;data=$second}}
Reject {SelfTakeUpload}
[void](SelfUpload @{offset=0;total=$zip.Length;data=$first})
[void](SelfUpload @{offset=$half;total=$zip.Length;data=$second})
Reject {SelfUpload @{offset=$zip.Length;total=$zip.Length;data=$second}}
$received=SelfTakeUpload
Assert ($received.Length -eq $zip.Length -and (SelfHash $received) -eq (SelfHash $zip)) 'Uploaded ZIP differs'
Reject {SelfTakeUpload}
$bad=$zip.Clone();$bad[40]=$bad[40] -bxor 255
Reject {SelfStage $root $bad $release $config}
function DefenderScanBytes([byte[]]$bytes) { throw 'Defender threat or scan failure' }
Reject {SelfStage $root $zip $release $config}
Assert (@(Get-ChildItem -LiteralPath $root -Directory -Filter 'staging-*').Count -eq 0) 'Failed scan staged a release'
function DefenderScanBytes([byte[]]$bytes) { $script:scannedBytes=$bytes.Length }
$stage=SelfStage $root $zip $release $config
Assert ($script:scannedBytes -eq $zip.Length) 'Verified ZIP was not scanned'
Assert ([IO.File]::Exists((Join-Path $root ($stage+'/manifest.json')))) 'Staged files missing'
$script:selfLease=$null
$lease=SelfDispatch @{op='self-lease'}
Assert ($lease.version -eq '0.7.0') 'Lease version mismatch'
Reject {$lock=[IO.File]::Open((Join-Path $root 'self-update.lock'),[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);$lock.Dispose()}
$script:selfLease.Dispose();$script:selfLease=$null
SelfSwap $root $stage '0.7.1'
Assert ([IO.Directory]::Exists((Join-Path $root 'previous'))) 'Previous version missing'
Reject {SelfDispatch @{op='self-confirm';version='0.7.0'}}
$confirmed=SelfDispatch @{op='self-confirm';version='0.7.1'}
Assert (-not [IO.File]::Exists((Join-Path $root 'self-update-pending.json'))) 'Startup acknowledgement missing'
SelfWriteJson (Join-Path $root 'self-update-pending.json') @{phase='swapped';version='0.7.1';startedAt=[DateTime]::UtcNow.AddMinutes(-5).ToString('o')}
$origin='chrome-extension://dlddgdefgecebmfhjinfamnffjkgohao/'
$psi=New-Object Diagnostics.ProcessStartInfo
$psi.FileName=(Join-Path $PSHOME 'powershell.exe');$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true
$psi.RedirectStandardInput=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true
$psi.Arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File '+[char]34+(Join-Path $root 'native-bootstrap.ps1')+[char]34+' '+$origin
$child=[Diagnostics.Process]::Start($psi);$child.StandardInput.Close();$stderr=$child.StandardError.ReadToEnd();$child.WaitForExit()
Assert ($child.ExitCode -eq 0) ('Recovery bootstrap failed: '+$stderr)
$restored=Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'extension/manifest.json') | ConvertFrom-Json
Assert ($restored.version -eq '0.7.0') 'Recovery did not restore the previous version'
$result=Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'self-update-result.json') | ConvertFrom-Json
Assert ($result.state -eq 'rolled-back') 'Recovery result missing'
Write-Output 'Signature, extension-supplied envelope, ordered ZIP upload, tamper rejection, native lease, swap, acknowledgement and failed-start recovery passed.'
`;
fs.writeFileSync(path.join(root,'verify.ps1'),'\ufeff'+harness);
console.log(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'verify.ps1')],{encoding:'utf8',windowsHide:true,timeout:30000}).trim());
