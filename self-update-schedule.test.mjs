import assert from 'node:assert/strict';
import {startSelfUpdates} from './self-update.mjs';

const data={helperUpdateStatus:{state:'current',checkedAt:Date.now()}}, calls=[], created=[];
let alarm, releaseConfirm, holdConfirm=true, failConfirm=false, existing={name:'helper-update-check',scheduledTime:123};
globalThis.chrome={
  storage:{local:{async get(key){return {[key]:data[key]};},async set(value){Object.assign(data,value);}}},
  alarms:{onAlarm:{addListener(fn){alarm=fn;}},async get(){return existing;},async create(name,options){created.push({name,...options});}},
  runtime:{getManifest:()=>({version:'0.7.3'}),onStartup:{addListener(){}},onInstalled:{addListener(){}},connectNative(){
    let message,disconnect;
    return {onMessage:{addListener(fn){message=fn;}},onDisconnect:{addListener(fn){disconnect=fn;}},disconnect(){disconnect?.();},postMessage(request){
      calls.push(request.op);
      const reply=()=>message({id:1,ok:!(failConfirm && request.op==='self-confirm'),error:'test failure',result:{state:'current',version:'0.7.3'}});
      if(request.op==='self-confirm' && holdConfirm) releaseConfirm=reply;
      else queueMicrotask(reply);
    }};
  }}
};
const wait=async condition=>{for(let i=0;i<100;i++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.ok(condition());};
const checkNow=startSelfUpdates();
await wait(()=>releaseConfirm);
assert.equal(created.length,0,'worker restart must preserve the existing periodic alarm');
alarm({name:'helper-update-check'});
alarm({name:'helper-update-check'});
const manual=checkNow();
holdConfirm=false; releaseConfirm();
await manual;
assert.deepEqual(calls,['self-confirm','self-confirm','self-check'],'concurrent alarms and manual checks coalesce into a forced check');
assert.equal(data.helperUpdateStatus.state,'current');
failConfirm=true;
await checkNow();
assert.equal(data.helperUpdateStatus.state,'error');
const count=calls.length;
await new Promise(resolve=>setTimeout(resolve,20));
assert.equal(calls.length,count,'a persistent error must not spin');
failConfirm=false; existing=null;
startSelfUpdates();
await wait(()=>created.some(item=>item.name==='helper-update-check'));
assert.equal(created.filter(item=>item.name==='helper-update-check').length,1,'a missing periodic alarm is recreated');
await wait(()=>calls.length>count);
delete globalThis.chrome;
console.log('Self update schedule: preserve existing alarm, restore missing alarm, coalesce forced checks and stop on errors passed.');
