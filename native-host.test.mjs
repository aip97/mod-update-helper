import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn, execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {connectNativeGameFolder} from './native-filesystem.mjs';
import {applyUpdate, inspectGameDirectory, inspectGameRoot, listBackups, restoreBackup,writeFile,fingerprint} from './installer.mjs';
import {inspectGamePackage,applyGameUpdate} from './game-installer.mjs';
import {createHash} from 'node:crypto';
import {writeZip} from './zip-tools.mjs';
import {installNewMod} from './wiki-install.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(dir, 'test-output'); fs.mkdirSync(output, {recursive:true});
const temporary = fs.mkdtempSync(path.join(output, 'native-'));
const origin = 'chrome-extension://dlddgdefgecebmfhjinfamnffjkgohao/';
const children = new Set();
let latestPort;
let useLauncher = false;
function nativePort() {
  const executable = useLauncher ? 'cmd.exe' : 'powershell.exe';
  const args = useLauncher ? ['/d','/c',path.join(dir,'native-host.cmd'),origin,'--parent-window=0'] : ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(dir,'native-host.ps1'),origin];
  const process = spawn(executable, args, {windowsHide:true,stdio:['pipe','pipe','pipe']});
  children.add(process);
  const listeners = [], disconnects = [], pending = new Map();
  let buffer = Buffer.alloc(0), stderr = '', sequence = 100000;
  process.stderr.on('data', bytes => { stderr += bytes; });
  process.stdout.on('data', bytes => {
    buffer = Buffer.concat([buffer, bytes]);
    while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
      const length = buffer.readUInt32LE(0); assert.ok(length <= 1048576);
      const message = JSON.parse(buffer.subarray(4, length+4)); buffer = buffer.subarray(length+4);
      if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
      else for (const listener of listeners) listener(message);
    }
  });
  process.on('exit', () => { children.delete(process); for (const listener of disconnects) listener(); });
  const port = {
    closed:new Promise(resolve=>process.once('exit',resolve)),
    onMessage:{addListener(fn){listeners.push(fn);}},onDisconnect:{addListener(fn){disconnects.push(fn);}},
    postMessage(message) { const body=Buffer.from(JSON.stringify(message)); const size=Buffer.alloc(4);size.writeUInt32LE(body.length);process.stdin.write(Buffer.concat([size,body])); },
    disconnect() { process.stdin.end(); },
    raw(message) { const id=++sequence;return new Promise(resolve=>{pending.set(id,resolve);port.postMessage({id,...message});}); },
    get stderr(){return stderr;},
  };
  latestPort = port; return port;
}
globalThis.chrome = {runtime:{connectNative(name){assert.equal(name,'org.wml.mod_updater');return nativePort();}}};
try {
  fs.mkdirSync(path.join(temporary,'wml/runtime'),{recursive:true});
  fs.mkdirSync(path.join(temporary,'wml/mods/test-mod'),{recursive:true});
  fs.writeFileSync(path.join(temporary,'wml/runtime/wml-core.js'),"const VERSION = '0.9.5';");
  fs.writeFileSync(path.join(temporary,'Wayward test.html'),'<script src="wml/runtime/wml-core.js"></script>/* WML_BRIDGE_BEGIN 2026-11-01 lang=ko */');
  const contents = Buffer.alloc(700000, 65);contents[400000] = 66;
  fs.writeFileSync(path.join(temporary,'wml/mods/test-mod/mod.js'),contents);
  const root = await connectNativeGameFolder(pathToFileURL(path.join(temporary,'Wayward test.html')).href);
  assert.equal(root.native,true);assert.equal(root.gameFile,'Wayward test.html');assert.equal(await root.queryPermission(),'granted');
  const racePath = 'wml/mods/test-mod/race.txt';
  const race = await latestPort.raw({op:'begin-new',path:racePath}); assert.equal(race.ok,true);
  assert.equal((await latestPort.raw({op:'chunk',token:race.result.token,data:Buffer.from('ours').toString('base64')})).ok,true);
  fs.writeFileSync(path.join(temporary,racePath),'user data');
  assert.equal((await latestPort.raw({op:'commit',token:race.result.token})).ok,false);
  assert.equal(fs.readFileSync(path.join(temporary,racePath),'utf8'),'user data');
  assert.equal((await latestPort.raw({op:'abort',token:race.result.token})).ok,true);
  fs.unlinkSync(path.join(temporary,racePath));
  const stage = await root.beginNewMod('wiki-race');
  await root.createNewFile(stage.stage + '/mod.js', new TextEncoder().encode('our mod'));
  const userDir=path.join(temporary,'wml/mods/wiki-race');fs.mkdirSync(userDir);fs.writeFileSync(path.join(userDir,'user.txt'),'user data');
  await assert.rejects(stage.publish());
  assert.equal(fs.readFileSync(path.join(userDir,'user.txt'),'utf8'),'user data');
  const stageDir=await (await (await root.getDirectoryHandle('.wml-mod-updater-backups')).getDirectoryHandle('wiki-race')).getDirectoryHandle(stage.stage.split('/').at(-1));
  await stageDir.removeEntry('mod.js');await stage.abort();
  assert.equal(fs.existsSync(path.join(temporary,stage.stage)),false);
  fs.unlinkSync(path.join(userDir,'user.txt'));fs.rmdirSync(userDir);
  const published = await root.beginNewMod('wiki-new');
  await root.createNewFile(published.stage + '/mod.js', new TextEncoder().encode('our mod'));
  await published.publish();
  assert.equal(fs.readFileSync(path.join(temporary,'wml/mods/wiki-new/mod.js'),'utf8'),'our mod');
  fs.unlinkSync(path.join(temporary,'wml/mods/wiki-new/mod.js'));fs.rmdirSync(path.join(temporary,'wml/mods/wiki-new'));
  const wikiArchive=path.join(temporary,'wiki.zip');
  writeZip(wikiArchive,[{name:'mod.js',data:Buffer.from("WML.define({id:'wiki-new',version:'1.0.0',game:'>=2026-10-04',wml:'0.9.5',setup(){}});")}]);
  const wikiResult=await installNewMod(root,fs.readFileSync(wikiArchive),{modId:'wiki-new',expectedVersion:'1.0.0',gameFile:root.gameFile,expectedGame:{gameVersion:'2026-11-01',wmlVersion:'0.9.5'}});
  assert.equal(wikiResult.needsModListRefresh,true);
  assert.equal((await inspectGameDirectory(root,'wiki-new',{gameFile:root.gameFile})).modVersion,'1.0.0');
  fs.unlinkSync(path.join(temporary,'wml/mods/wiki-new/mod.js'));fs.rmdirSync(path.join(temporary,'wml/mods/wiki-new'));
  const wml=await root.getDirectoryHandle('wml',{create:true}),mods=await wml.getDirectoryHandle('mods',{create:true}),mod=await mods.getDirectoryHandle('test-mod');
  const file=await mod.getFileHandle('mod.js'),data=await file.getFile();
  assert.equal(data.size,700000);assert.equal(await data.slice(399999,400002).text(),'ABA');
  assert.deepEqual(Buffer.from(await data.arrayBuffer()),contents);
  assert.deepEqual((await Array.fromAsync(mod.values())).map(entry=>entry.name),['mod.js']);
  const writer=await file.createWritable();await writer.write('new contents');await writer.close();
  assert.equal(fs.readFileSync(path.join(temporary,'wml/mods/test-mod/mod.js'),'utf8'),'new contents');
  await assert.rejects(data.slice(0,3).text(),/changed/);
  const aborted=await file.createWritable();await aborted.write('must not persist');await aborted.abort();
  assert.equal(fs.readFileSync(path.join(temporary,'wml/mods/test-mod/mod.js'),'utf8'),'new contents');
  assert.equal(fs.readdirSync(path.join(temporary,'wml/mods/test-mod')).length,1);
  const backup=await (await root.getDirectoryHandle('.wml-mod-updater-backups',{create:true})).getDirectoryHandle('test-mod',{create:true});
  const manifest=await backup.getFileHandle('manifest.json',{create:true});const saved=await manifest.createWritable();await saved.write('{}');await saved.close();
  assert.equal(await (await manifest.getFile()).text(),'{}');await backup.removeEntry('manifest.json');
  await assert.rejects(backup.getFileHandle('manifest.json'),error=>error.name==='NotFoundError');
  await assert.rejects(root.removeEntry('wml',{recursive:true}),/재귀/);
  const port=latestPort;
  for (const request of [
    {op:'read',path:'../outside.txt',offset:0,length:0},
    {op:'stat',path:'wml/../secret.txt',kind:'file'},
    {op:'begin',path:'Wayward test.html'},
    {op:'begin',path:'wml/runtime/wml-core.js'},
    {op:'begin',path:'wml/mods/mods.js'},
    {op:'begin',path:'image-packs/test/run.cmd'},
    {op:'begin',path:'image-packs/test/other.js'},
    {op:'remove',path:'wml/mods/test-mod'},
    {op:'stat',path:'wml/mods/test-mod/a:stream',kind:'file',create:true},
  ]) assert.equal((await port.raw(request)).ok,false,JSON.stringify(request));
  const external=path.join(temporary,'outside');fs.mkdirSync(external);fs.writeFileSync(path.join(external,'secret.txt'),'secret');
  let junction = false;
  try { fs.symlinkSync(external,path.join(temporary,'wml/mods/test-mod/link'),'junction'); junction = true; }
  catch(error) { if (error.code !== 'EPERM') throw error; console.log('Junction execution check skipped: this environment does not permit creating junctions.'); }
  if (junction) {
    assert.equal((await port.raw({op:'stat',path:'wml/mods/test-mod/link/secret.txt',kind:'file'})).ok,false);
    fs.unlinkSync(path.join(temporary,'wml/mods/test-mod/link'));
  }
  const header = version => `WML.define({id:'test-mod',version:'${version}',game:'>=2026-10-04',wml:'0.9.5',setup(){}});`;
  fs.writeFileSync(path.join(temporary,'wml/mods/test-mod/mod.js'),header('1.0.0'));
  fs.writeFileSync(path.join(temporary,'wml/mods/test-mod/settings.json'),'preserve settings');
  const archive = path.join(temporary,'test-mod.zip');
  const picture='image-packs/character/mods/test-mod/images/existing.webp';
  fs.mkdirSync(path.dirname(path.join(temporary,picture)),{recursive:true});fs.writeFileSync(path.join(temporary,picture),'original picture');
  writeZip(archive,[{name:'mod.js',data:Buffer.from(header('1.1.0').replace('setup()','async setup()'))},{name:'assets/note.txt',data:Buffer.from('new asset')},{name:picture,data:Buffer.from('new picture')},{name:'image-packs/character/mods/test-mod/pack.js',data:Buffer.from('const pack={};')}]);
  const updated = await applyUpdate(root,fs.readFileSync(archive),{modId:'test-mod',expectedVersion:'1.1.0',expectedInstalledVersion:'1.0.0',gameFile:root.gameFile});
  assert.equal((await inspectGameDirectory(root,'test-mod',{gameFile:root.gameFile})).modVersion,'1.1.0');
  assert.equal((await listBackups(root,'test-mod')).length,1);
  assert.equal(fs.readFileSync(path.join(temporary,picture),'utf8'),'new picture');
  await restoreBackup(root,updated.backupPath,{modId:'test-mod',expectedInstalledVersion:'1.1.0',gameFile:root.gameFile});
  assert.equal(fs.readFileSync(path.join(temporary,'wml/mods/test-mod/mod.js'),'utf8'),header('1.0.0'));
  assert.equal(fs.existsSync(path.join(temporary,'wml/mods/test-mod/assets/note.txt')),false);
  assert.equal(fs.readFileSync(path.join(temporary,picture),'utf8'),'original picture');
  assert.equal(fs.existsSync(path.join(temporary,'image-packs/character/mods/test-mod/pack.js')),false);
  assert.equal(fs.readFileSync(path.join(temporary,'wml/mods/test-mod/settings.json'),'utf8'),'preserve settings');
  assert.equal((await listBackups(root,'test-mod')).length,2);
  root.disconnect();
  const gameURL=pathToFileURL(path.join(temporary,'Wayward test.html')).href;
  const gameRoot=await connectNativeGameFolder(gameURL),gamePort=latestPort;
  for(const bad of ['../outside.js','saves/game.json','saves/game.js','server/cache/state.js','server/src/cache/state.json','server/src/userdata/save.js','wml/mods/test-mod/mod.js','server/images/private.png','server/game.config.json','CON.txt','run.exe']) {
    assert.equal((await gamePort.raw({op:'game-authorize',backupPath:'.wml-game-updater-backups/'+crypto.randomUUID(),paths:[gameRoot.gameFile,'wml/runtime/wml-core.js',bad]})).ok,false,bad);
  }
  const gameBefore=fs.readFileSync(path.join(temporary,gameRoot.gameFile));
  const gameArchive=path.join(temporary,'game.zip');
  writeZip(gameArchive,[{name:'Release/Game-2026-11-02.html',data:Buffer.from('<script src="wml/runtime/wml-core.js"></script>/* WML_BRIDGE_BEGIN 2026-11-02 */')},{name:'Release/wml/runtime/wml-core.js',data:Buffer.from("const VERSION = '0.9.5';")},{name:'Release/wml/symbols/2026-11-02.js',data:Buffer.from('const symbols={};')},{name:'Release/server/src/cache/cacheStore.ts',data:Buffer.from('export const program = true;')},{name:'Release/wml/mods/test-mod/mod.js',data:Buffer.from('do not replace')}]);
  const gameCurrent=await inspectGameRoot(gameRoot,{gameFile:gameRoot.gameFile});
  const gamePkg=await inspectGamePackage(fs.readFileSync(gameArchive),{gameVersion:'2026-11-02',html:'Game-2026-11-02.html'},gameCurrent);
  const gameResult=await applyGameUpdate(gameRoot,gamePkg,{current:gameCurrent,checkClosed:async()=>{}});
  assert.equal((await inspectGameRoot(gameRoot,{gameFile:gameRoot.gameFile})).gameVersion,'2026-11-02');
  assert.equal(fs.readFileSync(path.join(temporary,'server/src/cache/cacheStore.ts'),'utf8'),'export const program = true;');
  assert.deepEqual(fs.readFileSync(path.join(temporary,gameResult.backupPath,gameRoot.gameFile)),gameBefore);
  assert.equal(fs.readFileSync(path.join(temporary,'wml/mods/test-mod/mod.js'),'utf8'),header('1.0.0'));
  assert.equal((await gamePort.raw({op:'begin',path:'unapproved.js'})).ok,false);
  gameRoot.disconnect();await gamePort.closed;
  assert.equal(fs.readFileSync(path.join(temporary,'Wayward test.html'),'utf8').includes('2026-11-02'),true,'committed game survives host shutdown');
  const interrupted=await connectNativeGameFolder(gameURL),interruptedPort=latestPort;
  const gamePaths=['Wayward test.html','wml/runtime/wml-core.js'],protective='.wml-game-updater-backups/'+crypto.randomUUID();
  await interrupted.authorizeGameUpdate(gamePaths,protective);
  assert.equal((await interruptedPort.raw({op:'begin',path:'Wayward test.html'})).ok,false,'unarmed game writes blocked');
  const recoveryEntries=[];
  for(const file of gamePaths){const old=fs.readFileSync(path.join(temporary,file));await writeFile(interrupted,protective+'/'+file,old);recoveryEntries.push({path:file,original:{...fingerprint(old),sha256:createHash('sha256').update(old).digest('hex')}});}
  await writeFile(interrupted,protective+'/manifest.json',new TextEncoder().encode(JSON.stringify({schema:1,gameFile:interrupted.gameFile,files:recoveryEntries})));
  await interrupted.armGameUpdate();
  await writeFile(interrupted,'Wayward test.html',new TextEncoder().encode('interrupted incomplete game'));
  interrupted.disconnect();await interruptedPort.closed;
  assert.equal(interruptedPort.stderr,'');
  assert.equal(fs.readFileSync(path.join(temporary,'Wayward test.html'),'utf8').includes('2026-11-02'),true,'pipe close restores armed game transaction');
  useLauncher = true;
  const launched = await connectNativeGameFolder(pathToFileURL(path.join(temporary,'Wayward test.html')).href);
  assert.equal(launched.gameFile,'Wayward test.html'); launched.disconnect();
  await assert.rejects(connectNativeGameFolder('https://example.com/game.html'),/Windows/);
  await assert.rejects(connectNativeGameFolder('file://server/share/game.html'),/Windows/);
  const installer=path.join(temporary,'extension');fs.mkdirSync(installer);
  for(const name of ['native-host.cmd','native-host.ps1','manifest.json']) fs.copyFileSync(path.join(dir,name),path.join(installer,name));
  execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(dir,'native-install.ps1'),'-ExtensionDirectory',installer,'-NoRegister'],{windowsHide:true});
  const registered=JSON.parse(fs.readFileSync(path.join(installer,'org.wml.mod_updater.json')));
  assert.deepEqual(registered.allowed_origins,[origin]);assert.equal(registered.path,path.join(installer,'native-host.cmd'));
  console.log('Native Windows bridge: framed/chunked reads, exact game binding, atomic writes/abort, real fixture update/rollback with settings preservation, traversal/metadata guards, and registry-free manifest generation passed.');
} finally {
  for(const child of children) child.kill();
  assert.equal(path.dirname(path.resolve(temporary)),path.resolve(output));
  // Keep only this test's own temporary fixture available for failure inspection.
}
