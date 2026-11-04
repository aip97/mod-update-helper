import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import puppeteer,{testChrome} from './browser-test-deps.mjs';
const dir=path.dirname(fileURLToPath(import.meta.url));
const stubs={
 'defender-scan.mjs':`export async function scanDownloadedZip(){if(globalThis.__scanFailure)throw new Error('Defender scan failed')}`,
 'native-filesystem.mjs':`export async function connectNativeGameFolder(){__connections++;return {gameFile:'game.html',path:'E:/fixture/game',disconnect(){__disconnects++;}}}`,
 'installer.mjs':`export async function readModMetadata(){return {}} export function evaluateCompatibility(){return {state:'unsupported',gameState:'supported'}} export async function inspectGameRoot(){return {...__game,gameFile:'game.html'}}`,
 'kio-api.mjs':`export async function downloadKioFile(){__downloads++;return new ArrayBuffer(1)}`,
 'game-installer.mjs':`export async function inspectGamePackage(){if(__invalidZip)throw new Error('Invalid game ZIP');return {gameVersion:'harbor-2.0.0',wmlVersion:'0.9.5',files:[{path:'game.html'}],skipped:['saves/test.json']}} export async function applyGameUpdate(root,pkg,options){await options.checkClosed();__writes++;return {version:pkg.gameVersion,backupPath:'.wml-game-updater-backups/fixture'}}`,
};
const fixture=`import {initGameUpdater} from './game-update-ui.mjs';
globalThis.__invalidZip=false;globalThis.__changed=false;globalThis.__keepOpen=false;globalThis.__downloads=0;globalThis.__writes=0;globalThis.__closed=[];globalThis.__connections=0;globalThis.__disconnects=0;globalThis.__passwords=0;globalThis.__done=0;
globalThis.__game={tabId:7,documentId:'first',url:'file:///E:/fixture/game/game.html',gameFamily:'harbor',gameVersion:'harbor-1.0.0',wmlVersion:'0.9.5',mods:[{modId:'example'}]};
globalThis.__tabs=[{id:7,url:__game.url},{id:8,url:'file:///E:/fixture/game/second.html'},{id:9,url:'file:///E:/elsewhere/game.html'}];
globalThis.chrome={tabs:{query:async()=>__tabs,remove:async ids=>{__closed.push(...ids);if(!__keepOpen)__tabs=__tabs.filter(tab=>!ids.includes(tab.id));},create:async options=>{globalThis.__opened=options.url}}};
const source={postURL:'https://kone.gg/s/wayward-wml/ctRTv4mPI2NMv8JcYdlQeb',packages:[{id:'full',label:'전체판'},{id:'light',label:'경량판'}]};
let busy=false;
const message=async request=>request.type==='GET_GAME_SOURCE'?{source,edition:'light'}:request.type==='GET_GAME'?{game:__changed?{...__game,documentId:'changed'}:__game}:{available:true,release:{gameVersion:'harbor-2.0.0',size:200,fileName:'Harbor_v2.0.0.zip',html:'Harbor_v2.0.0.html',label:request.edition==='light'?'경량판':'전체판',url:'https://kio.ac/c/aC4q-xj6OjUx51pIypLAeb'}};
globalThis.__ui=initGameUpdater({message,askPassword:async()=>{__passwords++;return true},getPassword:()=>'',isBusy:()=>busy,setBusy:value=>{busy=value;__ui.refresh()},onInstalled:()=>__done++});
await __ui.load(__game);globalThis.__ready=true;`;
const server=http.createServer((req,res)=>{
 const name=new URL(req.url,'http://localhost').pathname.slice(1)||'update.html';
 if(name==='fixture.mjs'){res.setHeader('Content-Type','text/javascript');res.end(fixture);return;}
 if(!['update.html','update.css','game-update-ui.mjs',...Object.keys(stubs)].includes(name))return void res.writeHead(404).end();
 res.setHeader('Content-Type',name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.css')?'text/css':'text/javascript');
 res.end(stubs[name] || (name==='update.html'?fs.readFileSync(path.join(dir,name),'utf8').replace('src="update.mjs"','src="fixture.mjs"'):fs.readFileSync(path.join(dir,name))));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await puppeteer.launch({executablePath:testChrome,headless:true,args:['--no-sandbox']});
try {
 const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 const load=async()=>{await page.goto(`http://127.0.0.1:${server.address().port}/update.html`);await page.waitForFunction(()=>globalThis.__ready);await page.evaluate(()=>{document.querySelector('#panel-game').hidden=false;document.querySelector('#panel-updates').hidden=true;document.querySelector('#tab-updates').setAttribute('aria-selected','false');document.querySelector('#tab-game').setAttribute('aria-selected','true');});};
 const prepare=async()=>{await page.click('#game-prepare');try{await page.waitForSelector('#game-confirm[open]',{timeout:4000});}catch(error){throw new Error(await page.$eval('#game-update-status',el=>el.textContent),{cause:error});}};
 const approve=async()=>{await page.click('#game-saved');await page.click('#game-install-confirm');};
 await load();assert.equal(await page.$eval('#game-edition',el=>el.value),'light');
 fs.mkdirSync(path.join(dir,'test-output'),{recursive:true});
 for(const width of [1280,390]){await page.setViewport({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(dir,'test-output',`game-tab-${width}.png`),fullPage:true});}
 await page.click('#game-diagnose');await page.waitForFunction(()=>document.querySelector('#game-update-status').textContent.includes('파일명 검사 완료'));
 assert.match(await page.$eval('#game-diagnostic-guidance',el=>el.hidden?'':el.textContent),/하나의 게시글.*게임 다운로드 링크/);
 assert.match(await page.$eval('#game-update-status',el=>el.textContent),/Harbor_v2\.0\.0.zip[\s\S]*https:\/\/kio.ac[\s\S]*<게임 폴더>\/Harbor_v2\.0\.0.html/);
 assert.deepEqual(await page.evaluate(()=>[__downloads,__writes,__closed.length]),[0,0,0]);
 await prepare();assert.equal(await page.$eval('#game-install-confirm',el=>el.disabled),true);
 assert.match(await page.$eval('#game-confirm .notice',el=>el.textContent),/호환성 주의.*충돌/);
 assert.match(await page.$eval('#game-confirm-description',el=>el.textContent),/경량판.*\n경로: E:\/fixture\/game/);
 assert.match(await page.$eval('#game-confirm-description',el=>el.textContent),/example/);
 assert.deepEqual(await page.evaluate(()=>[__closed.length,__writes]),[0,0]);
 await page.click('#game-confirm button[value=cancel]');await page.waitForFunction(()=>__disconnects===1);
 assert.deepEqual(await page.evaluate(()=>[__closed.length,__writes]),[0,0]);
 await prepare();await page.evaluate(()=>__tabs.push({id:10,url:'file:///E:/fixture/game/new.html'}));await approve();
 await page.waitForFunction(()=>document.querySelector('#game-update-status').textContent.includes('새로운 게임 탭'));
 assert.deepEqual(await page.evaluate(()=>[__closed.length,__writes]),[0,0]);
 await load();await page.evaluate(()=>globalThis.__scanFailure=true);await page.click('#game-prepare');await page.waitForFunction(()=>document.querySelector('#game-update-status').textContent.includes('Defender scan failed'));
 assert.deepEqual(await page.evaluate(()=>[__closed.length,__writes,document.querySelector('#game-confirm').open]),[0,0,false]);
 await load();await page.evaluate(()=>__invalidZip=true);await page.click('#game-prepare');await page.waitForFunction(()=>document.querySelector('#game-update-status').textContent.includes('Invalid game ZIP'));
 assert.deepEqual(await page.evaluate(()=>[__closed.length,__writes]),[0,0]);
 await load();await prepare();await page.evaluate(()=>__changed=true);await approve();await page.waitForFunction(()=>document.querySelector('#game-update-status').textContent.includes('게임이 변경'));
 assert.deepEqual(await page.evaluate(()=>[__closed.length,__writes]),[0,0]);
 await load();await prepare();await page.evaluate(()=>{globalThis.__lockAcquired=false;navigator.locks.request('wml-mod-updater-install',async()=>{__lockAcquired=true;await new Promise(resolve=>globalThis.__unlock=resolve)});});await page.waitForFunction(()=>__lockAcquired);await approve();await page.waitForFunction(()=>document.querySelector('#game-update-status').textContent.includes('업데이트가 진행 중'));
 assert.deepEqual(await page.evaluate(()=>[__closed.length,__writes]),[0,0]);await page.evaluate(()=>__unlock());
 await load();await prepare();await page.evaluate(()=>__keepOpen=true);await approve();await page.waitForFunction(()=>document.querySelector('#game-update-status').textContent.includes('탭이 열려'));
 assert.equal(await page.evaluate(()=>__writes),0);
 await load();await prepare();await approve();await page.waitForFunction(()=>__done===1);
 assert.deepEqual(await page.evaluate(()=>__closed),[7,8]);assert.equal(await page.evaluate(()=>__writes),1);
 assert.deepEqual(await page.evaluate(()=>__tabs.map(tab=>tab.id)),[9]);
 await page.click('#game-open');assert.equal(await page.evaluate(()=>__opened),'file:///E:/fixture/game/game.html');
 await page.setViewport({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 assert.deepEqual(errors,[]);
 console.log('Game UI: edition persistence, inspected ZIP before consent, cancel, saved checkbox, tab/snapshot races, shared lock, close verification, scoped close, install and explicit reopen passed. Mock files only.');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
