import assert from 'node:assert/strict';
import {nativeUpdate,startSelfUpdates,reopenUpdaterWindow} from './self-update.mjs';
const data={helperUpdateReopen:{tabId:42,url:'chrome-extension://id/update.html?tab=12',fromVersion:'0.7.0'}}, calls=[], alarms=[], reopened=[], timeouts=[];let alarm, unlocked=false, reloads=0, mode='available', tabMissing=false, version='0.7.0';
const originalTimeout=globalThis.setTimeout;
globalThis.setTimeout=(fn,delay,...args)=>{timeouts.push(delay);return originalTimeout(fn,delay,...args);};
globalThis.chrome={storage:{local:{async get(key){return {[key]:data[key]};},async set(value){Object.assign(data,value);},async remove(key){delete data[key];}}},
  tabs:{async update(id,values){if(tabMissing) throw new Error('tab missing');reopened.push({id,...values});},async create(values){reopened.push(values);}},
  alarms:{onAlarm:{addListener(fn){alarm=fn;}},async get(){return null;},async create(name,value){alarms.push({name,...value});}},
  runtime:{getManifest:()=>({version}),getURL:path=>'chrome-extension://id/'+path,onStartup:{addListener(){}},onInstalled:{addListener(){}},reload(){reloads++;},connectNative(){
    let message,disconnect;return {onMessage:{addListener(fn){message=fn;}},onDisconnect:{addListener(fn){disconnect=fn;}},disconnect(){disconnect?.();},postMessage(request){calls.push(request.op);if(request.op==='self-check') envelopes.push(request.envelope);queueMicrotask(()=>message({id:1,ok:true,result:{state:request.op==='self-check'?mode:request.op==='self-apply'?'updated':'current',version:request.op==='self-apply'?'0.7.1':'0.7.0'}}));}};
  }}};
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{async request(name,options,fn){assert.equal(name,'wml-mod-updater-self-update');assert.equal(options.ifAvailable,true);return fn(unlocked?{}:null);}}}});
const wait=async condition=>{for(let i=0;i<100;i++){if(condition())return;await new Promise(r=>setTimeout(r,5));}assert.ok(condition());};
assert.equal((await nativeUpdate('self-confirm')).result.state,'current','a local disconnect must not reject a completed reply');
assert.ok(timeouts.includes(120000),'confirmation keeps its shorter timeout');
let loginRequired=false;
const envelopes=[];
startSelfUpdates({findRelease:async()=>{if(loginRequired) throw Object.assign(new Error('코네 로그인 후 이용해 주세요.'),{code:'KONE_LOGIN_REQUIRED',postURL:'https://kone.gg/s/wayward-wml/cxDZPwAi6ZQYfWwmovNAeb'});return {version:'0.7.1',postURL:'https://kone.gg/s/wayward-wml/cxDZPwAi6ZQYfWwmovNAeb',zip:{url:'https://kio.ac/c/dDt9ZC8_D_KbDWKWJiNkeb',fileName:'Mod-Update-Helper-User-0.7.1.zip',size:4},envelope:'{"signed":1}'};}});
await wait(()=>data.helperUpdateStatus?.state==='waiting');
assert.equal(envelopes[0],'{"signed":1}','the signed metadata from the Kone post is verified natively');
assert.deepEqual({...data.helperUpdateStatus.release},{postURL:'https://kone.gg/s/wayward-wml/cxDZPwAi6ZQYfWwmovNAeb',url:'https://kio.ac/c/dDt9ZC8_D_KbDWKWJiNkeb',fileName:'Mod-Update-Helper-User-0.7.1.zip',size:4,envelope:'{"signed":1}'},'the Kio download target is kept for the manual update');
assert.deepEqual(reopened,[],'worker startup must not navigate the still-updating page');
assert.ok(data.helperUpdateReopen,'reopen request remains pending before the version changes');
version='0.7.1';await reopenUpdaterWindow();
assert.deepEqual(reopened,[{id:42,url:'chrome-extension://id/update.html?tab=12'}]);
assert.equal(data.helperUpdateReopen,undefined,'reopen request is consumed once');
tabMissing=true;data.helperUpdateReopen={tabId:99,url:'chrome-extension://id/update.html?tab=12',fromVersion:'0.7.0'};
await reopenUpdaterWindow();
assert.deepEqual(reopened[1],{url:'chrome-extension://id/update.html?tab=12'},'missing tab is recreated with its game query');
version='0.7.0';
assert.equal(calls.includes('self-apply'),false,'an open updater window blocks replacement');
assert.equal(reloads,0);assert.equal(alarms.some(item=>item.name==='helper-update-retry'),false,'waiting for the user must not cause one-minute retries');
unlocked=true;alarm({name:'helper-update-retry'});
await wait(()=>calls.filter(op=>op==='self-check').length===2);
assert.equal(data.helperUpdateStatus.state,'waiting');
assert.equal(calls.includes('self-apply'),false,'automatic checks never apply the update');
assert.equal(reloads,0,'automatic checks never restart the extension');
await nativeUpdate('self-apply');
assert.ok(timeouts.includes(900000),'self-update must allow the Defender scan to finish');
mode='current';alarm({name:'helper-update-check'});await wait(()=>data.helperUpdateStatus.state==='current');
loginRequired=true;const checks=calls.filter(op=>op==='self-check').length;alarm({name:'helper-update-check'});await wait(()=>data.helperUpdateStatus.state==='login_required');
assert.equal(data.helperUpdateStatus.postURL,'https://kone.gg/s/wayward-wml/cxDZPwAi6ZQYfWwmovNAeb','the login warning links to the release post');
assert.equal(calls.filter(op=>op==='self-check').length,checks,'nothing is sent to the native host without a readable post');
loginRequired=false;
assert.equal(reloads,0,'current version does not reload');
delete globalThis.chrome;
globalThis.setTimeout=originalTimeout;
console.log('Self update worker: native replies, manual-only apply, no automatic restart and version-aware reopen passed.');
