import assert from 'node:assert/strict';
import {holdUpdaterWindow} from './self-update.mjs';

const data={helperUpdateStatus:{state:'waiting',version:'0.7.0',latest:'0.7.1'}}, calls=[];
const elements={'self-update-status':{},'self-update-apply':{}};
let otherWindow=true, mode='updated', reloads=0, leases=0;
globalThis.document={getElementById:id=>elements[id]};
globalThis.window={addEventListener(){},removeEventListener(){}};
globalThis.location={href:'chrome-extension://id/update.html?tab=42'};
globalThis.chrome={
  storage:{local:{async get(key){return {[key]:data[key]};},async set(value){Object.assign(data,value);},async remove(key){delete data[key];}},onChanged:{addListener(){}}},
  tabs:{async getCurrent(){return {id:9};}},
  runtime:{getManifest:()=>({version:'0.7.0'}),reload(){reloads++;},connectNative(){
    let message,disconnect,op;return {onMessage:{addListener(fn){message=fn;}},onDisconnect:{addListener(fn){disconnect=fn;}},disconnect(){if(op==='self-lease') leases--;disconnect?.();},postMessage(request){
      op=request.op;calls.push(op);if(op==='self-lease') leases++;
      queueMicrotask(()=>message({id:1,ok:mode!=='error' || op!=='self-apply',error:'test failure',result:{state:op==='self-apply'?mode:'idle',version:op==='self-apply'?'0.7.1':'0.7.0'}}));
    }};
  }}
};
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{async request(name,options,fn){assert.equal(name,'wml-mod-updater-self-update');return fn(options.ifAvailable && otherWindow ? null : {});}}}});
const updater=await holdUpdaterWindow();
await new Promise(resolve=>setTimeout(resolve,0));
assert.match(elements['self-update-status'].textContent,/0\.7\.0.*0\.7\.1/);
assert.equal(elements['self-update-apply'].hidden,false);
assert.equal(leases,1);
assert.equal((await updater.apply()).state,'waiting');
assert.equal(calls.includes('self-apply'),false,'another window must prevent installation');
assert.equal(leases,1,'the current window reacquires its lease after waiting');
assert.equal(data.helperUpdateReopen,undefined);
otherWindow=false;mode='waiting';
assert.equal((await updater.apply()).state,'waiting','native lease in another profile blocks installation');
assert.equal(leases,1);assert.equal(data.helperUpdateReopen,undefined);
mode='error';
await assert.rejects(updater.apply(),/test failure/);
assert.equal(leases,1,'failed installation restores the lease');
assert.equal(data.helperUpdateReopen,undefined);
mode='updated';
assert.equal((await updater.apply()).state,'updated');
assert.equal(leases,0);assert.equal(reloads,1);
assert.deepEqual(data.helperUpdateReopen,{tabId:9,url:'chrome-extension://id/update.html?tab=42',fromVersion:'0.7.0'});
assert.equal(data.helperUpdateStatus.version,'0.7.1');
console.log('Self update UI: version, other-window protection, failure recovery and restart passed.');
