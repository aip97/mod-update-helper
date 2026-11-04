import assert from 'node:assert/strict';
import {nativeUpdate,startSelfUpdates,reopenUpdaterWindow} from './self-update.mjs';
const data={helperUpdateReopen:{tabId:42,url:'chrome-extension://id/update.html?tab=12',fromVersion:'0.7.0'}}, calls=[], alarms=[], reopened=[], timeouts=[];let alarm, unlocked=false, reloads=0, mode='available', tabMissing=false, version='0.7.0';
const originalTimeout=globalThis.setTimeout;
globalThis.setTimeout=(fn,delay,...args)=>{timeouts.push(delay);return originalTimeout(fn,delay,...args);};
globalThis.chrome={storage:{local:{async get(key){return {[key]:data[key]};},async set(value){Object.assign(data,value);},async remove(key){delete data[key];}}},
  tabs:{async update(id,values){if(tabMissing) throw new Error('tab missing');reopened.push({id,...values});},async create(values){reopened.push(values);}},
  alarms:{onAlarm:{addListener(fn){alarm=fn;}},async create(name,value){alarms.push({name,...value});}},
  runtime:{getManifest:()=>({version}),getURL:path=>'chrome-extension://id/'+path,onStartup:{addListener(){}},onInstalled:{addListener(){}},reload(){reloads++;},connectNative(){
    let message,disconnect;return {onMessage:{addListener(fn){message=fn;}},onDisconnect:{addListener(fn){disconnect=fn;}},disconnect(){disconnect?.();},postMessage(request){calls.push(request.op);queueMicrotask(()=>message({id:1,ok:true,result:{state:request.op==='self-check'?mode:request.op==='self-apply'?'updated':'current',version:request.op==='self-apply'?'0.7.1':'0.7.0'}}));}};
  }}};
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{async request(name,options,fn){assert.equal(name,'wml-mod-updater-self-update');assert.equal(options.ifAvailable,true);return fn(unlocked?{}:null);}}}});
const wait=async condition=>{for(let i=0;i<100;i++){if(condition())return;await new Promise(r=>setTimeout(r,5));}assert.ok(condition());};
assert.equal((await nativeUpdate('self-confirm')).result.state,'current','a local disconnect must not reject a completed reply');
assert.ok(timeouts.includes(120000),'confirmation keeps its shorter timeout');
startSelfUpdates();
await wait(()=>data.helperUpdateStatus?.state==='waiting');
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
assert.equal(reloads,0);assert.ok(alarms.some(item=>item.name==='helper-update-retry'));
unlocked=true;alarm({name:'helper-update-retry'});
await wait(()=>reloads===1);
assert.equal(data.helperUpdateStatus.state,'updated');assert.equal(calls.filter(op=>op==='self-apply').length,1);
assert.ok(timeouts.includes(900000),'self-update must allow the Defender scan to finish');
mode='current';alarm({name:'helper-update-check'});await wait(()=>data.helperUpdateStatus.state==='current');
assert.equal(reloads,1,'current version does not reload');
delete globalThis.chrome;
globalThis.setTimeout=originalTimeout;
console.log('Self update worker: native replies, UI lock deferral, pending retry, verified apply and extension-only reload passed.');
