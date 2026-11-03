import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {writeZip} from './zip-tools.mjs';
import {validateGameUpdateAPI,validateSnapshot} from './core.mjs';
import {gameSource,gameReleaseFromFiles} from './game-release.mjs';
import {inspectGamePackage,applyGameUpdate} from './game-installer.mjs';
import {compareGameVersions} from './game-compat.mjs';
import {sameGameFolder} from './game-update-ui.mjs';

const current={gameFamily:'harbor',gameVersion:'harbor-1.0.0',wmlVersion:'0.9.5',gameFile:'Game.html'};
const html=version=>`<meta name="wml-game" content="${version}"><script src="wml/runtime/wml-core.js"></script>`;
const source={protocol:1,postURL:'https://kone.gg/s/wayward-wml/ctRTv4mPI2NMv8JcYdlQeb',packages:[{id:'full',label:'전체판',file:'Harbor_v{version}.zip',html:'Harbor_v{version}.html'}],preserve:['custom-data']};
const url='https://kio.ac/c/aC4q-xj6OjUx51pIypLAeb';
const files=['Harbor_v1.9.0.zip','Harbor_v1.10.0.zip','Other_v2.0.0.zip'].map(name=>({name,size:123,url}));
const release=gameReleaseFromFiles(files,current,source,'full');
assert.equal(release.gameVersion,'harbor-1.10.0');
assert.throws(()=>gameReleaseFromFiles([...files,files[1]],current,source,'full'),/중복/);
assert.throws(()=>validateGameUpdateAPI({...source,packages:[{...source.packages[0],file:'../bad{version}.zip'}]}));
assert.throws(()=>validateGameUpdateAPI({...source,packages:[{...source.packages[0],file:'bad{version}{version}.zip'}]}));
assert.equal(gameSource({...current,gameFamily:'faith'}).packages.length,2);
assert.equal(gameSource(current),null);
assert.equal(validateSnapshot({...current,mods:[],gameUpdate:source}).gameUpdate.postURL,source.postURL);
assert.ok(validateSnapshot({...current,mods:[],gameUpdate:{}}).gameUpdateError);
assert.equal(compareGameVersions('2026-11-01-pre10','2026-11-01-pre9'),1);
assert.equal(sameGameFolder('file:///E:/Game/other.html','file:///e:/game/Game.html'),true);
assert.equal(sameGameFolder('file:///E:/Game2/other.html','file:///e:/game/Game.html'),false);
assert.equal(sameGameFolder('https://example.com/Game.html','file:///e:/game/Game.html'),false);

const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'game-updater-'));
const zip=entries=>{const file=path.join(temporary,crypto.randomUUID()+'.zip');writeZip(file,entries.map(([name,data])=>({name,data:Buffer.from(data)})));return fs.readFileSync(file);};
const entries=[
 ['Wrapper/Harbor_v1.10.0.html',html(release.gameVersion)],['Wrapper/wml/runtime/wml-core.js',"const VERSION = '0.9.6';"],
 ['Wrapper/wml/symbols/harbor-1.10.0.js','const symbols={};'],['Wrapper/images/background.png','new static'],
 ['Wrapper/wml/mods/user-mod/mod.js','must preserve mod'],['Wrapper/wml/presets/presets.js','must preserve presets'],
 ['Wrapper/saves/data.json','must preserve save'],['Wrapper/server/images/private.png','must preserve generated image'],
 ['Wrapper/server/game.config.json','must preserve config'],['Wrapper/custom-data/important.txt','must preserve custom data'],
 ['Wrapper/image-packs/character/pack.js','must preserve pack'],['Wrapper/server/src/config.ts','new program source'],['Wrapper/start.cmd','echo start'],
];
const bytes=zip(entries),pkg=await inspectGamePackage(bytes,release,current);
assert.equal(pkg.files.length,6);assert.equal(pkg.skipped.length,7);
assert.ok(pkg.files.some(file=>file.path===current.gameFile));
await assert.rejects(inspectGamePackage(zip([...entries,['Wrapper/run.exe','bad']]),release,current),/지원하지/);
await assert.rejects(inspectGamePackage(zip([...entries,['Elsewhere/file.txt','bad']]),release,current),/포장 폴더/);
await assert.rejects(inspectGamePackage(bytes,{...release,gameVersion:'harbor-1.11.0'},current),/버전이 다릅니다/);
await assert.rejects(inspectGamePackage(bytes,{...release,gameVersion:'overtime-1.10.0'},current),/서로 다른/);
await assert.rejects(inspectGamePackage(bytes,{...release,gameVersion:'harbor-1.0.0'},current),/이전/);
await assert.rejects(inspectGamePackage(zip([...entries,['Wrapper/game.HTML',html(release.gameVersion)]]),release,current),/여러 게임/);
function fixture() {
 const data=new Map([['Game.html',html(current.gameVersion)],['wml/runtime/wml-core.js',"const VERSION = '0.9.5';"],['wml/mods/user-mod/mod.js','original mod'],['images/background.png','original static'],['server/images/private.png','private image'],['saves/data.json','my save']].map(([key,text])=>[key,new TextEncoder().encode(text)]));
 const config={writes:[],fail:null,corruptBackup:false};
 const missing=()=>Object.assign(new Error('missing'),{name:'NotFoundError'});
 const directory=(prefix='')=>({kind:'directory',
  async getDirectoryHandle(name){return directory(prefix+name+'/');},
  async getFileHandle(name,{create=false}={}){const key=prefix+name;if(!data.has(key)){if(!create)throw missing();data.set(key,new Uint8Array());}return {async getFile(){return new Blob([data.get(key)]);},async createWritable(){return {async write(bytes){data.set(key,new Uint8Array(bytes));},async close(){config.writes.push(key);if(config.corruptBackup && key.includes('.wml-game-updater-backups/'))data.set(key,new Uint8Array([0]));if(key===config.fail){config.fail=null;throw new Error('Injected write failure');}},async abort(){}};}};},
  async removeEntry(name){data.delete(prefix+name);},
 });
 return {root:directory(),data,config};
}
const a=fixture(),before=new Map(a.data);
const result=await applyGameUpdate(a.root,pkg,{current,checkClosed:async()=>{}});
assert.equal(result.version,release.gameVersion);
assert.equal(a.config.writes.filter(path=>!path.startsWith('.wml-game-updater-backups/')).at(-1),'Game.html');
for(const name of ['wml/mods/user-mod/mod.js','server/images/private.png','saves/data.json'])assert.deepEqual(a.data.get(name),before.get(name));
assert.ok(!a.data.has('Harbor_v1.10.0.html'));
assert.deepEqual(a.data.get(result.backupPath+'/Game.html'),before.get('Game.html'));
const b=fixture();b.config.fail='images/background.png';
await assert.rejects(applyGameUpdate(b.root,pkg,{current,checkClosed:async()=>{}}),/이전 상태로 복원/);
assert.deepEqual(new Map([...b.data].filter(([key])=>!key.startsWith('.wml-game-updater-backups/'))),before);
const c=fixture();c.config.corruptBackup=true;
await assert.rejects(applyGameUpdate(c.root,pkg,{current,checkClosed:async()=>{}}),/백업 무결성/);
assert.ok(c.config.writes.every(path=>path.startsWith('.wml-game-updater-backups/')));
const d=fixture();await assert.rejects(applyGameUpdate(d.root,pkg,{current,checkClosed:async()=>{throw new Error('Game still open');}}),/still open/);assert.equal(d.config.writes.length,0);
let checks=0;const e=fixture();await assert.rejects(applyGameUpdate(e.root,pkg,{current,checkClosed:async()=>{if(++checks===4)throw new Error('Reopened game');}}),/이전 상태로 복원/);
assert.deepEqual(new Map([...e.data].filter(([key])=>!key.startsWith('.wml-game-updater-backups/'))),before);
const live=new URL('./test-output/game-nosound-live.zip',import.meta.url);
if(fs.existsSync(live)) {
 const liveSource=gameSource({gameFamily:'faith'}),liveGame={...current,wmlVersion:'0.9.3',gameFamily:'faith',gameVersion:'faith-3.3.1'};
 const liveRelease=gameReleaseFromFiles([{name:'Wayward_Faith_NoSound_v3.3.2.zip',size:fs.statSync(live).size,url}],liveGame,liveSource,'nosound');
 const inspected=await inspectGamePackage(fs.readFileSync(live),liveRelease,liveGame);
 assert.ok(inspected.files.find(file=>file.path==='Game.html').data.length>16*1024*1024);
 assert.ok(!inspected.files.some(file=>file.path.startsWith('wml/mods/')));
 console.log(`Live lightweight game archive: ${inspected.files.length} program files, ${inspected.skipped.length} preserved files; inspected only.`);
}
console.log('Game update API, collection/edition matching, ZIP/HTML verification, preserved data, backup/recovery and closed-game guards passed.');
