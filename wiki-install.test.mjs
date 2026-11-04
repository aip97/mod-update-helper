import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {writeZip} from './zip-tools.mjs';
import {ensureNewFolder,installNewMod} from './wiki-install.mjs';
import {wikiGameFields,wikiGameSpec,wikiInstallCompatibility,wikiRow} from './wiki-ui.mjs';

const current={wmlVersion:'0.9.5',gameVersion:'2026-11-01'};
const unknownPackage={supportedWml:null,gameSpec:'*'};
const unknownWiki={wml_versions:[],game_spec:''};
assert.equal(wikiInstallCompatibility(unknownWiki,unknownPackage,current).state,'unknown');
assert.throws(()=>wikiInstallCompatibility(unknownWiki,unknownPackage,{...current,gameVersion:'faith-3.3.2'}),/위키에 등록된 게임/);
assert.equal(wikiGameSpec('wayward','',[]),'');
assert.equal(wikiGameSpec('wayward','',['2026-10-04','2026-11-01']),'2026-10-04 || 2026-11-01');
assert.equal(wikiGameSpec('faith','',['3.3.2','3.4.0']),'faith-3.3.2 || faith-3.4.0');
assert.equal(wikiGameSpec('overtime','',['1.0.0']),'overtime-1.0.0');
assert.equal(wikiGameSpec('any','',[]),'*');
assert.throws(()=>wikiGameSpec('wayward','',['faith-3.3.2']),/버전만/);
assert.throws(()=>wikiGameSpec('faith','',['3.3.2','3.3.2']),/중복/);
assert.deepEqual(wikiGameFields('faith>=3.0.0 <faith-4.0.0'),{family:'faith',other:'',versions:[],complex:true});
assert.deepEqual(wikiGameFields('faith-3.3.2 || faith-3.4.0'),{family:'faith',other:'',versions:['3.3.2','3.4.0'],complex:false});
const catalogRow={mod_id:'test-mod',name:'Test',post_url:'https://kone.gg/s/fixture/aaaaaaaaaaaaaaaaaaaaaa',version:'1.0.0',wml_versions:[],game_spec:'faith-3.3.2',game_family:'faith'};
assert.equal(wikiRow(catalogRow).valid,true);
assert.equal(wikiRow({...catalogRow,game_family:'overtime'}).valid,false,'catalog family must match its game declaration');
assert.throws(()=>wikiInstallCompatibility({...unknownWiki,wml_versions:['0.9.4']},unknownPackage,current),/위키에 등록된 WML/);
assert.throws(()=>wikiInstallCompatibility({...unknownWiki,game_spec:'faith>=3.0.0'},unknownPackage,current),/위키에 등록된 게임/);
assert.throws(()=>wikiInstallCompatibility({...unknownWiki,wml_versions:['0.9.5']},{...unknownPackage,supportedWml:['0.9.4']},current),/호환되지 않습니다/);
assert.equal(wikiInstallCompatibility({...unknownWiki,wml_versions:['0.9.5'],game_spec:'>=2026-10-04'},unknownPackage,current).state,'unknown');
for(const [spec,compatible,incompatible] of [
  ['faith>=3.3.2','faith-3.3.2','overtime-1.0.0'],
  ['overtime>=1.0.0','overtime-1.0.0','faith-3.3.2']
]) {
  assert.equal(wikiInstallCompatibility({...unknownWiki,game_spec:spec},unknownPackage,{...current,gameVersion:compatible}).state,'unknown');
  assert.throws(()=>wikiInstallCompatibility({...unknownWiki,game_spec:spec},unknownPackage,{...current,gameVersion:incompatible}),/위키에 등록된 게임/);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(),'wml-wiki-install-'));
const id='wiki-test', mod=`wml/mods/${id}/`, image='image-packs/shared/icon.png';
const stage=`.wml-mod-updater-backups/${id}/.wiki-stage-0123456789abcdef0123456789abcdef`;
const zipPath=path.join(temp,'release.zip');
const zip=(declaration,game='>=2026-10-04')=>{
  writeZip(zipPath,[
    {name:mod+'mod.js',data:Buffer.from(`WML.define({id:'${id}',version:'1.2.0',game:'${game}',${declaration}setup(){}});`)},
    {name:mod+'lib/a.js',data:Buffer.from('new code')},
    {name:image,data:Buffer.from('image')},
  ]);
  return fs.readFileSync(zipPath);
};
const archive=zip("wml:'0.9.5',");
const options={modId:id,expectedVersion:'1.2.0',gameFile:'game.html',expectedGame:{gameVersion:'2026-11-01',wmlVersion:'0.9.5',htmlVersion:'2026-11-01'}};
const missing = error => { if (error.code === 'ENOENT') error.name = 'NotFoundError'; throw error; };
function game(name) {
  const base=path.join(temp,name); fs.mkdirSync(path.join(base,'wml/runtime'),{recursive:true});
  fs.writeFileSync(path.join(base,'wml/runtime/wml-core.js'),"const VERSION = '0.9.5';");
  fs.writeFileSync(path.join(base,'game.html'),'<script src="wml/runtime/wml-core.js"></script><script src="wml/symbols/2026-11-01.js"></script>/* WML_BRIDGE_BEGIN 2026-11-01 */');
  const state={fail:null,race:null,change:null,folderRace:false,lostReply:false,writes:[],removes:[]};
  function dir(relative='') {
    const absolute=path.join(base,relative);
    return {kind:'directory',native:true,
      async getDirectoryHandle(name,{create=false}={}) {
        const child=path.join(relative,name), full=path.join(base,child);
        try { if(create) fs.mkdirSync(full,{recursive:true}); if(!fs.statSync(full).isDirectory()) throw new Error('not directory'); }
        catch(e) { missing(e); } return dir(child);
      },
      async getFileHandle(name) {
        const full=path.join(absolute,name);
        try {if(!fs.statSync(full).isFile()) throw new Error('not file');} catch(e){missing(e);}
        return {kind:'file',async getFile(){return new Blob([fs.readFileSync(full)]);}};
      },
      async removeEntry(name){state.removes.push(path.join(relative,name));try{fs.unlinkSync(path.join(absolute,name));}catch(e){missing(e);}},
      async *values(){for(const item of fs.readdirSync(absolute,{withFileTypes:true})) yield item.isDirectory() ? dir(path.join(relative,item.name)) : await this.getFileHandle(item.name);},
    };
  }
  return {base,state,root:{...dir(),async beginNewMod(){
    fs.mkdirSync(path.join(base,stage),{recursive:true});
    return {stage,async publish(){
      const target=path.join(base,'wml/mods',id);
      if(state.folderRace){fs.mkdirSync(target);fs.writeFileSync(path.join(target,'user.txt'),'user data');}
      if(fs.existsSync(target)) throw new Error('mod folder collision');
      fs.cpSync(path.join(base,stage),target,{recursive:true,errorOnExist:true,force:false});
      fs.rmSync(path.join(base,stage),{recursive:true});
      if(state.lostReply) throw new Error('publish response lost');
    },async abort(){
      const removeEmpty=folder=>{for(const item of fs.readdirSync(folder,{withFileTypes:true})) {if(!item.isDirectory()) throw new Error('stage not empty');removeEmpty(path.join(folder,item.name));}fs.rmdirSync(folder);};
      removeEmpty(path.join(base,stage));
    }};
  },async createNewFile(name,data){
    if (state.change) { const [target,value]=state.change; fs.writeFileSync(path.join(base,target),value); state.change=null; }
    if (name===state.race) fs.writeFileSync(path.join(base,name),'concurrent user file');
    if (name===state.fail) throw new Error('injected failure');
    fs.writeFileSync(path.join(base,name),data,{flag:'wx'});state.writes.push(name);
  }}};
}
try {
  const fresh=game('fresh');
  assert.deepEqual(await installNewMod(fresh.root,archive,options),{version:'1.2.0',filesWritten:3,filesReused:0,needsModListRefresh:true});
  assert.equal(fresh.state.writes.at(-1),stage+'/mod.js');
  assert.equal(fs.readFileSync(path.join(fresh.base,image),'utf8'),'image');
  assert.equal(fs.existsSync(path.join(fresh.base,'wml/mods/mods.js')),false);
  await assert.rejects(ensureNewFolder(fresh.root,id),/이미 있습니다.*비활성 모드/);
  await assert.rejects(ensureNewFolder(fresh.root,'../invalid'),/모드 ID/);
  await assert.rejects(installNewMod(fresh.root,archive,options),/이미 있습니다.*비활성 모드.*활성화한 뒤 모드 업데이트 탭/);
  assert.match(fs.readFileSync(path.join(fresh.base,mod+'mod.js'),'utf8'),/version:'1\.2\.0'/);

  const reuse=game('reuse');fs.mkdirSync(path.join(reuse.base,'image-packs/shared'),{recursive:true});fs.writeFileSync(path.join(reuse.base,image),'image');
  assert.equal((await installNewMod(reuse.root,archive,options)).filesReused,1);
  assert.equal(fs.readFileSync(path.join(reuse.base,image),'utf8'),'image');

  const reuseRace=game('reuse-race');fs.mkdirSync(path.join(reuseRace.base,'image-packs/shared'),{recursive:true});fs.writeFileSync(path.join(reuseRace.base,image),'image');
  reuseRace.state.change=[image,'changed elsewhere'];
  await assert.rejects(installNewMod(reuseRace.root,archive,options),/이미지팩이 설치 중 변경/);
  assert.equal(fs.readFileSync(path.join(reuseRace.base,image),'utf8'),'changed elsewhere');
  assert.equal(fs.existsSync(path.join(reuseRace.base,mod+'mod.js')),false);

  const collision=game('collision');fs.mkdirSync(path.join(collision.base,'image-packs/shared'),{recursive:true});fs.writeFileSync(path.join(collision.base,image),'user image');
  await assert.rejects(installNewMod(collision.root,archive,options),/충돌/);assert.deepEqual(collision.state.writes,[]);
  assert.equal(fs.readFileSync(path.join(collision.base,image),'utf8'),'user image');

  const race=game('race');race.state.race=image;
  await assert.rejects(installNewMod(race.root,archive,options),/이미지팩을 삭제하지 않았습니다/);
  assert.equal(fs.readFileSync(path.join(race.base,image),'utf8'),'concurrent user file');
  assert.equal(fs.existsSync(path.join(race.base,mod+'lib/a.js')),false);
  assert.equal(fs.existsSync(path.join(race.base,mod+'mod.js')),false);
  assert.deepEqual(race.state.removes,[],'failure must not delete a concurrent user file');
  assert.equal(fs.readFileSync(path.join(race.base,stage+'/lib/a.js'),'utf8'),'new code');

  const folderRace=game('folder-race');folderRace.state.folderRace=true;
  await assert.rejects(installNewMod(folderRace.root,archive,options),/mod folder collision/);
  assert.equal(fs.readFileSync(path.join(folderRace.base,mod+'user.txt'),'utf8'),'user data');
  assert.equal(fs.existsSync(path.join(folderRace.base,mod+'mod.js')),false);
  assert.equal(fs.readFileSync(path.join(folderRace.base,image),'utf8'),'image');
  assert.deepEqual(folderRace.state.removes,[]);

  const lost=game('lost-publish-reply');lost.state.lostReply=true;
  await assert.rejects(installNewMod(lost.root,archive,options),/설치 결과가 불확실합니다/);
  assert.equal(fs.existsSync(path.join(lost.base,mod+'mod.js')),true,'published mod survives a lost reply');
  assert.equal(fs.readFileSync(path.join(lost.base,image),'utf8'),'image','its image pack survives a lost reply');
  assert.deepEqual(lost.state.removes,[]);

  const changed=game('changed');changed.state.fail=image;changed.state.change=[stage+'/lib/a.js','user changed file'];
  // Change a file only after it has been created, immediately before the next write.
  const original=changed.root.createNewFile;changed.root.createNewFile=async(name,data)=>{if(name!==image) {const saved=changed.state.change;changed.state.change=null;await original(name,data);changed.state.change=saved;return;}return original(name,data);};
  await assert.rejects(installNewMod(changed.root,archive,options),/임시 폴더가 남았을 수 있습니다/);
  assert.equal(fs.readFileSync(path.join(changed.base,stage+'/lib/a.js'),'utf8'),'user changed file');

  const mismatch=game('mismatch');
  await assert.rejects(installNewMod(mismatch.root,archive,{...options,expectedGame:{...options.expectedGame,wmlVersion:'0.9.4'}}),/다릅니다/);
  assert.deepEqual(mismatch.state.writes,[]);
  await assert.rejects(installNewMod(mismatch.root,zip(''),options),{code:'WML_COMPAT_UNKNOWN'});
  await assert.rejects(installNewMod(mismatch.root,zip("wml:'0.9.4',"),options),{code:'WML_INCOMPATIBLE'});
  await assert.rejects(installNewMod(mismatch.root,zip("wml:'0.9.5',",'faith>=3.0.0'),options),{code:'GAME_INCOMPATIBLE'});
  assert.deepEqual(mismatch.state.writes,[]);
  const unknownApproved=game('unknown-approved');
  assert.equal((await installNewMod(unknownApproved.root,zip(''),{...options,allowUnknownWml:true})).version,'1.2.0');
  await assert.rejects(installNewMod({...mismatch.root,native:false},archive,options),/Windows/);
  console.log('Wiki install: atomic publish, image reuse/conflicts, failure preservation and compatibility passed.');
} finally {fs.rmSync(temp,{recursive:true,force:true});}
