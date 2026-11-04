import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import puppeteer,{testChrome} from './browser-test-deps.mjs';

const dir=path.dirname(fileURLToPath(import.meta.url));
const post='https://kone.gg/s/fixture/aaaaaaaaaaaaaaaaaaaaaa',share='https://kio.ac/c/abcdefghijklmnopqrstuv';
const stubs={
  'wiki-client.mjs':`export async function listWikiMods(){return [{mod_id:'wiki-new',name:'새 모드',version:'1.2.3',category:'편의',description:'<img src=x onerror=alert(1)>',post_url:${JSON.stringify(post)},wml_versions:['0.9.4'],game_spec:'>=2026-11-01',package_sha256:globalThis.__wikiHash || null},...(globalThis.__catalogExtra||[]),{mod_id:'bad',name:'bad',version:'1.0.0',post_url:'javascript:alert(1)'}]} export async function submitWikiMod(kind,payload,source){__submissions.push({kind,payload,source});return {ok:true,status:'pending',id:'ticket'}}`,
  'wiki-install.mjs':`export async function ensureNewFolder(){if(globalThis.__existingFolder)throw Error('같은 이름의 모드 폴더가 이미 있습니다. 비활성 모드일 수 있습니다.')} export async function installNewMod(root,bytes,options){if(!__scans)throw Error('ZIP was not scanned');__installs.push(options);return {version:options.expectedVersion}}`,
  'defender-scan.mjs':`export async function scanDownloadedZip(){__scans++}`,
  'native-filesystem.mjs':`export async function connectNativeGameFolder(){return {path:'E:/fixture',gameFile:'game.html',disconnect(){__disconnects++}}}`,
  'kio.js':`export async function downloadRelease(options){__downloads.push(options);return new ArrayBuffer(1)}`,
  'installer.mjs':`export async function inspectPackage(bytes,version){if(globalThis.__zipError)throw new Error('ZIP 모드 ID 불일치');return {version,gameSpec:globalThis.__pkgGameSpec||'>=2026-11-01',supportedWml:['0.9.4']}} export function evaluateCompatibility(){return {state:'supported',gameState:'supported'}}`,
};
const fixture=`import {initWikiUI} from './wiki-ui.mjs';
globalThis.__submissions=[];globalThis.__installs=[];globalThis.__downloads=[];globalThis.__scans=0;globalThis.__disconnects=0;globalThis.__diagnosePass=false;globalThis.__autoScans=0;globalThis.__latestVersion='1.2.3';
globalThis.__game={tabId:7,documentId:'doc',url:'file:///E:/fixture/game.html',gameVersion:'2026-11-01',wmlVersion:'0.9.4',mods:[],api:{}};
const store={};globalThis.chrome={storage:{local:{async get(keys){return Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,store[key]]))},async set(value){Object.assign(store,value)}},onChanged:{addListener(){}}}};
const message=async request=>{
 if(request.type==='GET_GAME')return {game:__game};
 if(request.type==='SCAN_WIKI_CANDIDATES'){__autoScans++;return {ok:true}}
 if(request.type==='DIAGNOSE_POST')return {diagnostic:{ok:true,modId:request.modId,postURL:request.postURL,checks:[{id:'collection_files',status:__diagnosePass?'pass':'warning',feedback:'Kio 확인 필요'}],release:{modId:request.modId,postURL:request.postURL,version:__latestVersion,fileName:request.modId+' '+__latestVersion+'.zip',url:${JSON.stringify(share)}}}};
 throw Error('Unexpected message '+request.type);
};
let busy=false;const ui=initWikiUI({message,askPassword:async()=>true,getPassword:()=> 'test-password',getGame:()=>__game,isBusy:()=>busy,setBusy:value=>busy=value});
globalThis.__ui=ui;ui.setGame(__game);document.querySelector('#panel-wiki').hidden=false;await ui.load();globalThis.__ready=true;`;
const server=http.createServer((req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname.slice(1)||'update.html';
  if(name==='fixture.mjs'){res.setHeader('Content-Type','text/javascript');res.end(fixture);return;}
  if(!['update.html','update.css','wiki-ui.mjs','core.mjs','game-compat.mjs',...Object.keys(stubs)].includes(name))return void res.writeHead(404).end();
  res.setHeader('Content-Type',name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.css')?'text/css':'text/javascript');
  res.end(stubs[name] || (name==='update.html'?fs.readFileSync(path.join(dir,name),'utf8').replace('src="update.mjs"','src="fixture.mjs"'):fs.readFileSync(path.join(dir,name))));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await puppeteer.launch({executablePath:testChrome,headless:true,args:['--no-sandbox']});
try {
 const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(`http://127.0.0.1:${server.address().port}/update.html`);await page.waitForFunction(()=>globalThis.__ready);
 assert.equal(await page.$$eval('#wiki-list li',items=>items.length),2,'invalid catalog entries remain visible for correction');
 await page.evaluate(post=>{globalThis.__catalogExtra=[
   ['same-mod','Faith 모드','faith>=3.0.0 <faith-4.0.0'],['same-mod','Overtime 모드','overtime-1.0.0'],
   ['common-mod','공용 모드','*'],['other-mod','다른 게임','other>=1.0.0'],['unknown-mod','미확인 모드','']
 ].map(([mod_id,name,game_spec])=>({mod_id,name,game_spec,version:'1.0.0',category:'편의',description:'테스트',wml_versions:[],post_url:post}));},post);
 await page.click('#wiki-refresh');await page.waitForFunction(()=>document.querySelector('#wiki-list-status').textContent.includes('7개'));
 for(const [filter,expected] of [['faith','same-mod'],['overtime','same-mod'],['any','common-mod'],['__other','other-mod']]){
   await page.select('#wiki-game-filter',filter);
   assert.deepEqual(await page.$$eval('#wiki-list .ready-detail',items=>items.map(item=>item.textContent.split(' · ')[0])),[expected],filter);
 }
 await page.select('#wiki-game-filter','wayward');
 assert.deepEqual(await page.$$eval('#wiki-list .ready-detail',items=>items.map(item=>item.textContent.split(' · ')[0])),['wiki-new','unknown-mod','bad']);
 await page.select('#wiki-game-filter','__unknown');
 assert.match(await page.$eval('#wiki-list-status',el=>el.textContent),/해당 조건/);
 await page.select('#wiki-game-filter','');
 await page.type('#wiki-search','overtime');
 assert.deepEqual(await page.$$eval('#wiki-list .ready-detail',items=>items.map(item=>item.textContent.split(' · ')[0])),['same-mod']);
 await page.click('#wiki-list button');assert.match(await page.$eval('#wiki-detail-meta',el=>el.textContent),/Overtime/);
 await page.click('#wiki-refresh');await page.waitForFunction(()=>document.querySelector('#wiki-list-status').textContent.includes('1개'));
 assert.match(await page.$eval('#wiki-detail-meta',el=>el.textContent),/Overtime/,'same IDs in different games must remain distinct after refresh');
 await page.click('#wiki-revise');assert.equal(await page.$eval('#wiki-form-family',el=>el.value),'overtime');
 assert.match(await page.$eval('#wiki-game-versions',el=>el.textContent),/1.0.0/);
 await page.select('#wiki-form-family','faith');await page.click('#wiki-diagnose');
 assert.match(await page.$eval('#wiki-diagnostic-status',el=>el.textContent),/게임 계열과 ID를 유지/,'revisions must not switch to a different game with the same mod ID');
 await page.$eval('#wiki-search',el=>{el.value='';el.dispatchEvent(new Event('input',{bubbles:true}))});
 await page.select('#wiki-game-filter','faith');await page.click('#wiki-list button');await page.click('#wiki-revise');
 assert.equal(await page.$eval('#wiki-form-family',el=>el.value),'faith');
 assert.match(await page.$eval('#wiki-form-game-existing',el=>el.textContent),/faith>=3.0.0 <faith-4.0.0/);
 await page.evaluate(()=>{__diagnosePass=true;__pkgGameSpec='faith>=3.0.0 <faith-4.0.0'});await page.click('#wiki-diagnose');await page.waitForFunction(()=>!document.querySelector('#wiki-submit').disabled);
 await page.click('#wiki-submit');await page.waitForFunction(()=>__submissions.length===1);
 assert.equal(await page.evaluate(()=>__submissions[0].payload.game_spec),'faith>=3.0.0 <faith-4.0.0','existing complex ranges must survive an unrelated revision');
 await page.evaluate(()=>{__submissions=[];__diagnosePass=false;__pkgGameSpec=''});
 await page.select('#wiki-game-filter','');
 await page.evaluate(()=>{globalThis.__catalogExtra=[]});await page.click('#wiki-refresh');await page.waitForFunction(()=>document.querySelector('#wiki-list-status').textContent.includes('2개'));
 await page.click('#wiki-list li:last-child button');
 assert.equal(await page.$eval('#wiki-post',el=>el.hasAttribute('href')),false,'invalid links must not become navigable');
 assert.equal(await page.$eval('#wiki-install',el=>el.disabled),true,'invalid catalog entries cannot be installed');
 await page.click('#wiki-list button');
 assert.equal(await page.$eval('#wiki-detail-description',el=>el.querySelectorAll('img').length),0,'wiki text must not become HTML');
 assert.equal(await page.$eval('#wiki-post',el=>el.href),post);
 await page.click('#wiki-revise');
 assert.equal(await page.$eval('#wiki-form-kind',el=>el.value),'revision');
 assert.deepEqual(await page.$$eval('#wiki-form-category option',options=>options.map(option=>option.value).filter(Boolean)),['유틸','콘텐츠','H 장면','그림','프롬프트','미분류','기타']);
 assert.equal(await page.$eval('#wiki-form-category-custom',el=>el.value),'편의','an existing custom category must be preserved');
 await page.click('#wiki-diagnose');await page.waitForFunction(()=>document.querySelector('#wiki-diagnostic-status').textContent.includes('진단 실패'));
 assert.equal(await page.$eval('#wiki-submit',el=>el.disabled),true,'warning-only Kio diagnosis must not allow application');
 await page.evaluate(()=>{globalThis.__diagnosePass=true;globalThis.__zipError=true});await page.click('#wiki-diagnose');await page.waitForFunction(()=>document.querySelector('#wiki-diagnostic-status').textContent.includes('ZIP 모드 ID 불일치'));
 assert.equal(await page.$eval('#wiki-submit',el=>el.disabled),true,'invalid ZIP must not pass even when the post is valid');
 await page.evaluate(()=>globalThis.__zipError=false);await page.click('#wiki-diagnose');await page.waitForFunction(()=>!document.querySelector('#wiki-submit').disabled);
 await page.$eval('#wiki-form-description',el=>{el.value='변경한 설명';el.dispatchEvent(new Event('input',{bubbles:true}))});
 assert.equal(await page.$eval('#wiki-submit',el=>el.disabled),true,'changing inputs invalidates diagnosis');
 await page.click('#wiki-diagnose');await page.waitForFunction(()=>!document.querySelector('#wiki-submit').disabled);await page.click('#wiki-submit');
 await page.waitForFunction(()=>__submissions.length===1);
 assert.equal(await page.evaluate(()=>__submissions[0].kind),'revision');
 assert.equal(await page.evaluate(()=>__submissions[0].source),'manual');
 assert.ok(!(await page.evaluate(()=>JSON.stringify(__submissions))).includes('test-password'),'Kio password must not be submitted');
 const downloadsBefore=await page.evaluate(()=>__downloads.length);
 await page.evaluate(()=>globalThis.__existingFolder=true);await page.click('#wiki-install');await page.waitForFunction(()=>document.querySelector('#wiki-install-status').textContent.includes('비활성 모드'));
 assert.equal(await page.evaluate(()=>__downloads.length),downloadsBefore,'existing inactive mod must be identified before downloading');
 await page.evaluate(()=>globalThis.__existingFolder=false);
 await page.evaluate(()=>globalThis.__wikiHash='0'.repeat(64));await page.click('#wiki-refresh');await page.waitForFunction(()=>document.querySelector('#wiki-list-status').textContent.includes('2개'));
 await page.click('#wiki-install');await page.waitForFunction(()=>document.querySelector('#wiki-install-status').textContent.includes('SHA-256과 다릅니다'));
 assert.equal(await page.evaluate(()=>__installs.length),0,'a changed approved ZIP must not install');
 await page.evaluate(()=>globalThis.__wikiHash=null);await page.click('#wiki-refresh');await page.waitForFunction(()=>document.querySelector('#wiki-list-status').textContent.includes('2개'));
 let consent='';page.on('dialog',dialog=>{consent=dialog.message();dialog.accept()});
 await page.click('#wiki-install');await page.waitForFunction(()=>__installs.length===1);
 assert.match(consent,/서버 ZIP 해시가 없어/,'missing approval hash must be disclosed before installation');
 assert.match(await page.$eval('#wiki-install-status',el=>el.textContent),/모드목록_자동갱신\.cmd/);
 assert.equal(await page.evaluate(()=>__disconnects),3);
 await page.evaluate(()=>globalThis.__wikiHash='6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d');await page.click('#wiki-refresh');await page.waitForFunction(()=>document.querySelector('#wiki-list-status').textContent.includes('2개'));
 await page.click('#wiki-install');await page.waitForFunction(()=>__installs.length===2);
 assert.match(consent,/SHA-256이 일치/,'the reviewed ZIP hash should be confirmed');
 await page.evaluate(()=>globalThis.__latestVersion='1.3.0');await page.click('#wiki-install');await page.waitForFunction(()=>__installs.length===3);
 assert.match(consent,/위키.*검토되지 않았습니다/,'a newer, unreviewed ZIP must be disclosed before installation');
 await page.click('#wiki-auto-consent');await page.waitForFunction(()=>__autoScans===1);
 await page.select('#wiki-form-kind','create');
 await page.$eval('#wiki-form-id',el=>{el.value='new-faith';el.dispatchEvent(new Event('input',{bubbles:true}))});
 await page.$eval('#wiki-form-name',el=>{el.value='Faith 모드';el.dispatchEvent(new Event('input',{bubbles:true}))});
 await page.select('#wiki-form-family','wayward');await page.$eval('#wiki-form-game',el=>{el.value='';el.dispatchEvent(new Event('input',{bubbles:true}))});
 await page.evaluate(()=>{__pkgGameSpec='faith>=3.3.2 <faith-4.0.0';__diagnosePass=true});await page.click('#wiki-diagnose');
 await page.waitForFunction(()=>document.querySelector('#wiki-diagnostic-status').textContent.includes('게임 계열'));
 assert.equal(await page.$eval('#wiki-submit',el=>el.disabled),true,'Wayward default cannot accept a Faith package');
 await page.select('#wiki-form-family','faith');
 await page.$eval('#wiki-form-game',el=>{el.value='3.3.2';el.dispatchEvent(new Event('input',{bubbles:true}))});
 await page.click('#wiki-game-add');
 await page.$eval('#wiki-form-game',el=>{el.value='3.4.0';el.dispatchEvent(new Event('input',{bubbles:true}))});
 await page.click('#wiki-game-add');
 await page.click('#wiki-diagnose');await page.waitForFunction(()=>!document.querySelector('#wiki-submit').disabled);
 await page.click('#wiki-submit');await page.waitForFunction(()=>__submissions.length===2);
 assert.equal(await page.evaluate(()=>__submissions[1].payload.game_spec),'faith-3.3.2 || faith-3.4.0');
 assert.equal(await page.evaluate(()=>__submissions[1].payload.game_family),'faith');
 await page.select('#wiki-form-family','overtime');
 await page.$eval('#wiki-form-game',el=>{el.value='0.9.0';el.dispatchEvent(new Event('input',{bubbles:true}))});
 await page.click('#wiki-game-add');await page.evaluate(()=>{__pkgGameSpec='overtime>=1.0.0'});await page.click('#wiki-diagnose');
 await page.waitForFunction(()=>document.querySelector('#wiki-diagnostic-status').textContent.includes('호환되지 않습니다'));
 assert.equal(await page.$eval('#wiki-submit',el=>el.disabled),true,'an explicitly unsupported game version cannot be submitted');
 await page.click('#wiki-game-versions button');
 await page.$eval('#wiki-form-game',el=>{el.value='1.0.0';el.dispatchEvent(new Event('input',{bubbles:true}))});
 await page.click('#wiki-game-add');
 await page.click('#wiki-diagnose');await page.waitForFunction(()=>!document.querySelector('#wiki-submit').disabled);
 await page.evaluate(()=>{__game.gameVersion='faith-3.3.2';__game.mods=[{modId:'installed-faith',modName:'Faith 설치 모드'}];__ui.setGame(__game)});
 await page.select('#wiki-form-mod','installed-faith');
 assert.equal(await page.$eval('#wiki-form-family',el=>el.value),'faith','selecting an installed mod starts with the connected game family');
 fs.mkdirSync(path.join(dir,'test-output'),{recursive:true});
 await page.evaluate(()=>{document.querySelector('#panel-updates').hidden=true;document.querySelector('#tab-updates').setAttribute('aria-selected','false');document.querySelector('#tab-wiki').setAttribute('aria-selected','true')});
 for(const width of [1280,390]){await page.setViewport({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(dir,'test-output',`wiki-${width}.png`),fullPage:true});}
 assert.deepEqual(errors,[]);
 console.log('Wiki UI: safe browsing, diagnostic gate, revision, credential separation, install and consent passed with mock services.');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
