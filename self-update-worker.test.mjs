import assert from 'node:assert/strict';
import {nativeUpdate,startSelfUpdates} from './self-update.mjs';
const data={}, calls=[], alarms=[];let alarm, unlocked=false, reloads=0, mode='available';
globalThis.chrome={storage:{local:{async get(key){return {[key]:data[key]};},async set(value){Object.assign(data,value);}}},
  alarms:{onAlarm:{addListener(fn){alarm=fn;}},async create(name,value){alarms.push({name,...value});}},
  runtime:{getManifest:()=>({version:'0.7.0'}),onStartup:{addListener(){}},onInstalled:{addListener(){}},reload(){reloads++;},connectNative(){
    let message,disconnect;return {onMessage:{addListener(fn){message=fn;}},onDisconnect:{addListener(fn){disconnect=fn;}},disconnect(){disconnect?.();},postMessage(request){calls.push(request.op);queueMicrotask(()=>message({id:1,ok:true,result:{state:request.op==='self-check'?mode:request.op==='self-apply'?'updated':'current',version:request.op==='self-apply'?'0.7.1':'0.7.0'}}));}};
  }}};
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{async request(name,options,fn){assert.equal(name,'wml-mod-updater-self-update');assert.equal(options.ifAvailable,true);return fn(unlocked?{}:null);}}}});
const wait=async condition=>{for(let i=0;i<100;i++){if(condition())return;await new Promise(r=>setTimeout(r,5));}assert.ok(condition());};
assert.equal((await nativeUpdate('self-confirm')).result.state,'current','a local disconnect must not reject a completed reply');
startSelfUpdates();
await wait(()=>data.helperUpdateStatus?.state==='waiting');
assert.equal(calls.includes('self-apply'),false,'an open updater window blocks replacement');
assert.equal(reloads,0);assert.ok(alarms.some(item=>item.name==='helper-update-retry'));
unlocked=true;alarm({name:'helper-update-retry'});
await wait(()=>reloads===1);
assert.equal(data.helperUpdateStatus.state,'updated');assert.equal(calls.filter(op=>op==='self-apply').length,1);
mode='current';alarm({name:'helper-update-check'});await wait(()=>data.helperUpdateStatus.state==='current');
assert.equal(reloads,1,'current version does not reload');
delete globalThis.chrome;
console.log('Self update worker: native replies, UI lock deferral, pending retry, verified apply and extension-only reload passed.');
