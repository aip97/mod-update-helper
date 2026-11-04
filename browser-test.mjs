import assert from 'node:assert/strict';
import {Encoder} from './vendor/cbor-x-1.6.4.mjs';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {fileURLToPath, pathToFileURL} from 'node:url';
import puppeteer,{testChrome} from './browser-test-deps.mjs';
const dir=path.dirname(fileURLToPath(import.meta.url));
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'wml-updater-extension-'));
const options={executablePath:testChrome,headless:true,protocolTimeout:20000,userDataDir:profile,ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${dir}`,`--load-extension=${dir}`,'--no-sandbox','--host-resolver-rules=MAP kone.gg ~NOTFOUND']};
let browser=await puppeteer.launch(options);
try {
  const target=await browser.waitForTarget(t=>t.type()==='service_worker'&&t.url().endsWith('/worker.mjs'),{timeout:20000});
  const worker=await target.worker(); const id=new URL(target.url()).hostname;
  const manifest=await worker.evaluate(()=>chrome.runtime.getManifest());
  assert.equal(manifest.version,JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8')).version); assert.equal(manifest.name,'모드 업데이트 도우미');
  await worker.evaluate(()=>chrome.storage.local.set({kioDefaultPassword:''}));
  const page=await browser.newPage();const failures=[];page.on('pageerror',e=>failures.push(e.message));
  await page.goto(`chrome-extension://${id}/update.html`,{waitUntil:'networkidle0'});
  assert.equal(await page.$eval('#update',el=>el.disabled),true);
  assert.equal(await page.evaluate(()=>typeof showDirectoryPicker),'function');
  const out=path.join(dir,'test-output');fs.mkdirSync(out,{recursive:true});
  for(const width of [1100,390]){await page.setViewport({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:path.join(out,`extension-${width}.png`),fullPage:true});}
  assert.deepEqual(failures,[]);
  await page.goto(`chrome-extension://${id}/GUIDE.html`,{waitUntil:'networkidle0'});
  for(const width of [1100,390]){
    await page.setViewport({width,height:1000});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.equal(await page.$$eval('img',images=>images.some(image=>!image.complete||image.naturalWidth===0)),false);
    await page.screenshot({path:path.join(out,`guide-${width}.png`),fullPage:true});
  }
  await browser.close();
  const preferences=path.join(profile,'Default','Preferences');const prefs=JSON.parse(fs.readFileSync(preferences,'utf8'));
  prefs.extensions ??= {}; prefs.extensions.settings ??= {}; prefs.extensions.settings[id] ??= {};
  prefs.extensions.settings[id].allow_file_access=true;fs.writeFileSync(preferences,JSON.stringify(prefs));
  browser=await puppeteer.launch(options);
  const fixture=path.join(profile,'two-mods.html');
  const example=fs.readFileSync(path.join(dir,'examples/bridge.js'),'utf8');
  fs.writeFileSync(fixture,`<!doctype html><meta charset="utf-8"><title>Isolated no-API fixture</title><script>window.WML={currentPreset:()=>({wml:'0.9.4',game:'2026-11-01',mods:[{id:'attention-image-prompt',version:'1.81.6'},{id:'example-mod',version:'1.0.0'}]}),define(mod){mod.setup({id:mod.id,wml:'0.9.4',game:'2026-11-01'})}};WML.define({id:'example-mod',setup(api){${example}\n}});</script>`);
  const control=await browser.newPage();await control.goto(`chrome-extension://${id}/update.html`);
  assert.equal(await control.evaluate(()=>chrome.extension.isAllowedFileSchemeAccess()),true);
  const game=await browser.newPage();game.on('pageerror',e=>console.error('Fixture page error:',e.message));
  await game.evaluateOnNewDocument(()=>{globalThis.__messages=[];addEventListener('message',event=>__messages.push(event.data));});
  await game.goto(pathToFileURL(fixture).href);
  try { await control.waitForFunction(async()=>{const {lastGame}=await chrome.storage.session.get('lastGame');return lastGame?.mods.length===2},{timeout:15000,polling:100}); }
  catch(e) { console.log(await game.evaluate(()=>({preset:WML.currentPreset(),messages:__messages.slice(-10)})));console.log(await control.evaluate(()=>chrome.storage.session.get(null)));throw e; }
  const gameTabId=await control.evaluate(async url=>(await chrome.tabs.query({})).find(tab=>tab.url===url).id,pathToFileURL(fixture).href);
  const status=await control.evaluate(async tabId=> (await chrome.runtime.sendMessage({type:'GET_GAME',tabId})).game,gameTabId);
  assert.deepEqual(status.mods.map(mod=>mod.modId).sort(),['attention-image-prompt','example-mod']);
  assert.equal(status.mods.find(mod=>mod.modId==='attention-image-prompt').apiSupported,false);
  assert.equal(status.mods.find(mod=>mod.modId==='attention-image-prompt').modVersion,'1.81.6');
  assert.equal(status.mods.find(mod=>mod.modId==='example-mod').apiSupported,true);
  await control.bringToFront();
  await control.goto(`chrome-extension://${id}/update.html?tabId=${status.tabId}&modId=example-mod`,{waitUntil:'networkidle0'});
  await control.waitForFunction(()=>document.querySelector('#mod-select').value==='example-mod');
  assert.equal(await control.$eval('#mod-select',el=>el.value),'example-mod');
  const active=await control.evaluate(async tabId=>chrome.runtime.sendMessage({type:'VERIFY_ACTIVE',tabId,modId:'example-mod'}),status.tabId);
  assert.equal(active.ok,true);assert.equal(active.status.active,true);
  await control.goto(`chrome-extension://${id}/update.html?modId=example-mod`,{waitUntil:'networkidle0'});
  await control.waitForFunction(()=>document.querySelectorAll('#mod-select option').length===2);
  assert.equal(await control.$$eval('#mod-select option',els=>els.length),2);
  assert.equal(await control.$eval('#mod-select',el=>el.value),'example-mod');
  await game.evaluate(()=>{WML.currentPreset=()=>({wml:'0.9.4',game:'2026-11-01',mods:[{id:'attention-image-prompt',version:'1.81.6'}]})});
  const inactive=await control.evaluate(async tabId=>chrome.runtime.sendMessage({type:'VERIFY_ACTIVE',tabId,modId:'example-mod'}),status.tabId);
  assert.equal(inactive.ok,false);
  await control.click('#refresh-active');await control.waitForFunction(()=>document.querySelectorAll('#active-mods li').length===1);
  assert.equal(await control.$eval('#mod-select',el=>el.value),'attention-image-prompt');
  assert.equal(await control.$eval('#update',el=>el.disabled),true);
  await control.waitForFunction(()=>!document.querySelector('#post-url').disabled);
  assert.equal(await control.$eval('#post-url',el=>el.disabled),false);
  const liveWorker=await (await browser.waitForTarget(t=>t.type()==='service_worker'&&t.url().endsWith('/worker.mjs'))).worker();
  const fixtureEncoder=new Encoder({useRecords:false,tagUint8Array:false});
  await liveWorker.evaluate(async encoded=>{
    const postURL='https://kone.gg/s/somisoft/d7dNsfio5zS0D3neJOhkeb';
    await chrome.storage.local.set({registrations:{'attention-image-prompt':{postURL}}});
    globalThis.fetch=async url=>url.startsWith('https://api.kio.ac/') ? new Response(Uint8Array.from(encoded[url.endsWith('/directory/get')?'files':'collection']),{headers:{'content-type':'application/cbor'}}) : new Response('<title>[attention-image-prompt] 1.81.7</title><p>다운로드 (1.81.7)</p>https://kio.ac/c/abcdefghijklmnopqrstuv');
  },{files:[...fixtureEncoder.encode({files:[{name:'attention-image-prompt 1.81.7.zip',id:new Uint8Array(16),size:100}]})],collection:[...fixtureEncoder.encode({root:new Uint8Array(16),token:'fixture',segment_size:100})]});
  await control.close();
  await liveWorker.evaluate(tabId=>chrome.tabs.sendMessage(tabId,{type:'READ_SNAPSHOT',connect:true},{frameId:0}),status.tabId);
  const opened=await browser.waitForTarget(t=>t.url().startsWith(`chrome-extension://${id}/update.html?tabId=${status.tabId}`));
  assert.ok(opened,'a verified newer active mod automatically opens the update screen');
  await liveWorker.evaluate(tabId=>chrome.tabs.sendMessage(tabId,{type:'READ_SNAPSHOT',connect:true},{frameId:0}),status.tabId);
  assert.equal(browser.targets().filter(t=>t.url().startsWith(`chrome-extension://${id}/update.html`)).length,1,'polling must not open duplicate update screens');
  const contractControl=await opened.page();
  for(const [family,version,wml,meta] of [['overtime','1.0.0','0.9.5','<meta name="ot-version" content="1.0.0">'],['harbor','1.2.3','0.10.0','<meta name="wml-game" content="harbor-1.2.3">']]){
    const contractFixture=path.join(profile,family+'-contract.html');
    fs.writeFileSync(contractFixture,`<!doctype html><meta charset="utf-8">${meta}<title>${family} contract fixture</title><script>window.WML={currentPreset:()=>({wml:'${wml}',game:'${family}-${version}',mods:[{id:'${family}-sample',version:'1.0.0'}]})};</script>`);
    const contractPage=await browser.newPage();await contractPage.goto(pathToFileURL(contractFixture).href);
    const tabId=await liveWorker.evaluate(async url=>(await chrome.tabs.query({})).find(tab=>tab.url===url).id,pathToFileURL(contractFixture).href);
    const detected=await contractControl.evaluate(async tabId=>chrome.runtime.sendMessage({type:'GET_GAME',tabId}),tabId);
    assert.equal(detected.ok,true,JSON.stringify(detected));
    assert.deepEqual([detected.game.gameFamily,detected.game.gameVersion,detected.game.htmlVersion],[family,family+'-'+version,family+'-'+version]);
    assert.equal(detected.game.mods[0].supported,true);
    await contractPage.evaluate(family=>{document.querySelector(family==='overtime'?'meta[name="ot-version"]':'meta[name="wml-game"]').content=family==='overtime'?'9.9.9':family+'-9.9.9'},family);
    const changed=await contractControl.evaluate(async tabId=>chrome.runtime.sendMessage({type:'GET_GAME',tabId}),tabId);
    assert.equal(changed.ok,false,'HTML metadata disagreeing with the running build must invalidate the connection');
  }
  console.log('No-API AIP + optional example API, currentPreset identity/version, fresh removal and selection reset: OK');
  console.log('Verified update automatically opens one updater tab in a real isolated extension browser: OK');
  console.log('Contract fixtures: real extension reader recognizes Overtime ot-version and generic Harbor wml-game with WML 0.10.0: OK');
  console.log('Real unpacked extension: current manifest, service worker, directory picker, disconnected safe state, desktop/mobile rendering: OK');
}finally{await browser.close();}
