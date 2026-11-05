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
const {Encoder,decode}=await import('./vendor/cbor-x-1.6.4.mjs');
const cbor=new Encoder({useRecords:false,tagUint8Array:false});
const postURL='https://kone.gg/s/wayward-wml/cxDZPwAi6ZQYfWwmovNAeb', kio='https://kio.ac/c/dDt9ZC8_D_KbDWKWJiNkeb', cdn='https://dalet.mittere.io/'+'b'.repeat(64);
const envelope=JSON.stringify({payload:Buffer.from(JSON.stringify({schema:1,version:'0.7.4'})).toString('base64'),signature:'c2ln'});
const fetches=[];
globalThis.fetch=async (url,request={})=>{
  url=String(url);fetches.push(url);
  const reply=data=>new Response(cbor.encode(data),{status:200,headers:{'content-type':'application/cbor'}});
  if(url==='chrome-extension://test/self-update-config.json') return new Response(JSON.stringify({schema:1,postURL}));
  if(url===postURL) { assert.equal(request.credentials,'include','the Kone post is read with the signed-in session'); return new Response(`<title>도우미</title><div class="article-prose">${Buffer.from(kio).toString('base64')}</div>`); }
  if(url.endsWith('/collection/get')) return reply({root:new Uint8Array(16),token:'cat',segment_size:65536});
  if(url.endsWith('/directory/get')) return reply({files:[{name:'Mod-Update-Helper-User-0.7.4.zip',id:new Uint8Array(16).fill(2),size:400},{name:'wml-updater-release.json',id:new Uint8Array(16).fill(3),size:Buffer.byteLength(envelope)}]});
  if(url.endsWith('/file/gets')) { assert.deepEqual([...decode(request.body).ids[0]],[...new Uint8Array(16).fill(3)],'only the signature is fetched during a check'); return reply({files:[{segments:[{type:'cdn',data:new Map([['url',cdn]])}]}]}); }
  if(url===cdn) return new Response(envelope);
  throw new Error('unexpected fetch '+url);
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
