import assert from 'node:assert/strict';

const data={}, calls=[], notices=[]; let handler, mode='current', reloads=0;
const local={async get(keys){return Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,data[key]]));},async set(value){Object.assign(data,value);},async remove(key){delete data[key];}};
globalThis.chrome={
  storage:{local,session:local},
  alarms:{onAlarm:{addListener(){}},async get(){return {name:'helper-update-check'};},async create(){}},
  action:{onClicked:{addListener(){}}},
  tabs:{onRemoved:{addListener(){}},onUpdated:{addListener(){}},async get(id){return {id,url:'file:///game.html'};},async sendMessage(id,message,options){notices.push({id,message,options});}},
  runtime:{getManifest:()=>({version:'0.7.3'}),getURL:path=>'chrome-extension://test/'+path,
    onMessage:{addListener(fn){handler=fn;}},onStartup:{addListener(){}},onInstalled:{addListener(){}},reload(){reloads++;},connectNative(){
      let message,disconnect;
      return {onMessage:{addListener(fn){message=fn;}},onDisconnect:{addListener(fn){disconnect=fn;}},disconnect(){disconnect?.();},postMessage(request){
        calls.push(request.op);queueMicrotask(()=>message({id:1,ok:true,result:{state:request.op==='self-check'?mode:'current',version:'0.7.3',...(mode==='available'?{latest:'0.7.4'}:{})}}));
      }};
    }}
};
await import('./worker.mjs');
const wait=async condition=>{for(let i=0;i<100;i++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.ok(condition());};
await wait(()=>data.helperUpdateStatus?.state==='current');
const send=(url)=>new Promise(resolve=>handler({type:'CHECK_HELPER_UPDATE'},{url},resolve));
assert.equal((await send('file:///game.html')).code,'INVALID_SENDER');
assert.equal((await send('chrome-extension://test/update.html?tabId=1')).ok,true);
assert.equal(calls.filter(op=>op==='self-check').length,2,'manual check must bypass the recent-check cache');
mode='available';
const snapshot={wmlVersion:'0.9.5',gameVersion:'2026-11-01',mods:[]};
const announce=documentId=>new Promise(resolve=>handler({type:'GAME_SNAPSHOT',snapshot,apis:[]},{url:'file:///game.html',frameId:0,documentId,tab:{id:1}},resolve));
await Promise.all([announce('first'),announce('first'),announce('first')]);
await wait(()=>notices.length===1);
assert.equal(calls.filter(op=>op==='self-check').length,3,'one game document triggers only one helper check');
assert.deepEqual(notices[0],{id:1,message:{type:'HELPER_UPDATE_AVAILABLE',current:'0.7.3',version:'0.7.4'},options:{documentId:'first'}});
assert.equal(calls.includes('self-apply'),false,'game startup must not apply the update');
assert.equal(reloads,0,'game startup must not restart the extension');
await announce('second');
await wait(()=>notices.length===2);
assert.equal(calls.filter(op=>op==='self-check').length,4,'a new game document triggers a new helper check');
delete globalThis.chrome;
console.log('Helper checks: UI-only manual check and one non-disruptive notice per game document passed.');
