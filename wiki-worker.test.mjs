import assert from 'node:assert/strict';

const storage = () => { const data={};return {data,async get(keys){return Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(key=>key in data).map(key=>[key,structuredClone(data[key])]));},async set(values){Object.assign(data,structuredClone(values));},async remove(key){delete data[key];}};};
const local=storage(),session=storage(),requests=[],alarmItems=new Map();
const gameURL='file:///isolated/game.html',uiURL='chrome-extension://test/update.html';
const apiPost='https://kone.gg/s/example/aaaaaaaaaaaaaaaaaaaaaa',manualPost='https://kone.gg/s/example/bbbbbbbbbbbbbbbbbbbbbb',wikiPost='https://kone.gg/s/example/cccccccccccccccccccccc';
const ids=['api-mod','manual-mod','private-installed-mod-987','bad-url-mod','duplicate-mod','cross-mod','common-mod','wayward-mod','faith-mod','overtime-mod','spoof-mod','wml-mod','range-mod','or-mod'];
const snapshot={wmlVersion:'0.9.4',gameVersion:'2026-11-01',mods:ids.map(id=>({id,version:'1.0.0'}))};
const apis=[{modId:'api-mod',protocol:2,active:true,postURL:apiPost}];
local.data.registrations={'api-mod':{postURL:manualPost},'manual-mod':{postURL:manualPost}};
local.data.wikiSourcesCache={at:Date.now(),entries:{'private-installed-mod-987':manualPost}};
let handler,navigate,alarmHandler;
globalThis.chrome={storage:{local,session},runtime:{getURL:name=>'chrome-extension://test/'+name,onMessage:{addListener(fn){handler=fn;}},async sendMessage(){}},
  extension:{async isAllowedFileSchemeAccess(){return true;}},scripting:{async executeScript(){return [{documentId:'doc'}];}},
  alarms:{onAlarm:{addListener(fn){alarmHandler=fn;}},async get(name){return alarmItems.get(name);},async create(name,info){alarmItems.set(name,{name,scheduledTime:info.when ?? Date.now()+info.periodInMinutes*60000});},async clear(name){alarmItems.delete(name);}},
  windows:{async update(){}},action:{onClicked:{addListener(){}},async setBadgeText(){}},tabs:{
    onRemoved:{addListener(){}},onUpdated:{addListener(fn){navigate=fn;}},async get(id){return {id,url:gameURL};},async query(){return [];},async create(){return {id:9};},async update(){return {};},
    async sendMessage(id,message){if(message.type==='READ_SNAPSHOT')return {ok:true,snapshot,apis};},
  }};
globalThis.fetch=async address=>{
  const url=String(address);requests.push(url);
  if(url.startsWith('https://bxcptogtnylktxodiqyn.supabase.co/')) {
    const row=(mod_id,game_family,game_spec,post_url=wikiPost,wml_versions=[])=>({mod_id,game_family,game_spec,post_url,wml_versions});
    return new Response(JSON.stringify([
      row('api-mod','wayward',''),row('manual-mod','wayward',''),row('private-installed-mod-987','wayward',''),
      row('bad-url-mod','wayward','','https://evil.example/'),row('duplicate-mod','wayward','',wikiPost),row('duplicate-mod','wayward','',manualPost),
      row('cross-mod','wayward','',wikiPost),row('cross-mod','faith','faith>=3.0.0',manualPost),row('cross-mod','any','*',apiPost),
      row('common-mod','any','*'),row('wayward-mod','wayward',''),row('faith-mod','faith','faith>=3.3.0'),row('overtime-mod','overtime','overtime>=1.0.0'),
      row('spoof-mod','wayward','faith>=3.3.0'),row('wml-mod','wayward','',wikiPost,['0.9.5']),row('range-mod','wayward','>=2026-12-01'),row('or-mod','wayward','2026-10-04 || 2026-11-01'),
    ]),{headers:{'content-type':'application/json'}});
  }
  return new Response('Unauthorized',{status:403});
};
await import('./worker.mjs');
const send=(message,sender)=>new Promise(resolve=>handler(message,sender,resolve));
const gameSender={url:gameURL,documentId:'doc',frameId:0,tab:{id:1}};
assert.equal((await send({type:'GAME_SNAPSHOT',snapshot,apis},gameSender)).ok,true);
for(let i=0;i<100 && local.data.wikiSourcesCache?.version!==2;i++)await new Promise(resolve=>setTimeout(resolve,10));
assert.equal(local.data.wikiSourcesCache?.version,2,'old source cache is immediately replaced with validated family metadata');
const wikiRequests=requests.filter(url=>url.startsWith('https://bxcptogtnylktxodiqyn.supabase.co/'));
assert.ok(wikiRequests.length>0);
for(const request of wikiRequests)for(const id of ids)assert.equal(decodeURIComponent(request).includes(id),false,'installed mod IDs must not appear in catalog requests');
const {game}=await send({type:'GET_GAME',tabId:1},{url:uiURL});
const mods=Object.fromEntries(game.mods.map(mod=>[mod.modId,mod]));
assert.deepEqual([mods['api-mod'].source,mods['api-mod'].postURL],['api',apiPost]);
assert.deepEqual([mods['manual-mod'].source,mods['manual-mod'].postURL],['manual',manualPost]);
assert.deepEqual([mods['private-installed-mod-987'].source,mods['private-installed-mod-987'].postURL],['wiki',wikiPost]);
assert.equal(mods['bad-url-mod'].postURL,undefined);
assert.equal(mods['duplicate-mod'].postURL,undefined,'conflicting approved URLs are rejected');
assert.equal(mods['cross-mod'].postURL,wikiPost,'specific Wayward source wins over shared');
assert.equal(mods['common-mod'].postURL,wikiPost,'shared source applies to Wayward');
assert.equal(mods['wayward-mod'].postURL,wikiPost,'blank game specification means Wayward');
assert.equal(mods['or-mod'].postURL,wikiPost,'one of multiple exact game versions is accepted');
for(const id of ['faith-mod','overtime-mod','spoof-mod','wml-mod','range-mod']) assert.equal(mods[id].postURL,undefined,`${id} must not be used for this game`);
local.data['release-common-mod']={modId:'common-mod',postURL:wikiPost,version:'9.9.9',url:'https://kio.ac/c/abcdefghijklmnopqrstuv',checkedAt:Date.now()};
local.data['release-v2:wayward:2026-11-01:0.9.4:cross-mod']={modId:'cross-mod',postURL:wikiPost,version:'9.9.9',url:'https://kio.ac/c/abcdefghijklmnopqrstuv',checkedAt:Date.now()};
local.data['release-v2:wayward:2026-11-01:0.9.4:common-mod']={modId:'common-mod',postURL:wikiPost,version:'9.9.9',url:'https://kio.ac/c/abcdefghijklmnopqrstuv',checkedAt:Date.now()};
snapshot.gameVersion='faith-3.3.2';await send({type:'GAME_SNAPSHOT',snapshot,apis},gameSender);
const faith=Object.fromEntries((await send({type:'GET_GAME',tabId:1},{url:uiURL})).game.mods.map(mod=>[mod.modId,mod]));
assert.equal(faith['cross-mod'].postURL,manualPost,'Faith gets its own source instead of Wayward or shared');
assert.equal(faith['cross-mod'].cachedRelease,undefined,'another game family release cache is never reused');
assert.equal(faith['common-mod'].postURL,wikiPost);assert.equal(faith['common-mod'].cachedRelease,undefined,'shared post URLs do not mix caches from different game families');assert.equal(faith['faith-mod'].postURL,wikiPost);
assert.equal(faith['wayward-mod'].postURL,undefined);assert.equal(faith['overtime-mod'].postURL,undefined);
assert.equal(faith['manual-mod'].postURL,undefined,'legacy manual registrations do not leak into Faith');
assert.equal((await send({type:'SAVE_SETTINGS',tabId:1,modId:'manual-mod',postURL:wikiPost,gameContext:{documentId:'doc',gameVersion:'2026-11-01',wmlVersion:'0.9.4'}},{url:uiURL})).code,'CONTEXT_CHANGED','a stale game view cannot save a source into the wrong family');
assert.equal((await send({type:'SAVE_SETTINGS',tabId:1,modId:'manual-mod',postURL:apiPost},{url:uiURL})).ok,true);
assert.equal(local.data.registrations['manual-mod'].postURL,manualPost,'legacy Wayward registrations are preserved');
assert.equal((await send({type:'GET_SETTINGS',tabId:1},{url:uiURL})).settings['manual-mod'].postURL,apiPost,'Faith receives its family-specific setting');
snapshot.gameVersion='overtime-1.2.0';await send({type:'GAME_SNAPSHOT',snapshot,apis},gameSender);
const overtime=Object.fromEntries((await send({type:'GET_GAME',tabId:1},{url:uiURL})).game.mods.map(mod=>[mod.modId,mod]));
assert.equal(overtime['cross-mod'].postURL,apiPost,'shared source is the fallback when no exact family exists');
assert.equal(overtime['overtime-mod'].postURL,wikiPost);assert.equal(overtime['faith-mod'].postURL,undefined);
assert.equal(overtime['manual-mod'].postURL,undefined,'Faith manual registrations do not leak into Overtime');
snapshot.gameVersion='2026-11-01';
snapshot.wmlVersion='0.9.5';await send({type:'GAME_SNAPSHOT',snapshot,apis},gameSender);
const newerWml=Object.fromEntries((await send({type:'GET_GAME',tabId:1},{url:uiURL})).game.mods.map(mod=>[mod.modId,mod]));
assert.equal(newerWml['wml-mod'].postURL,wikiPost,'the matching WML version is accepted');
assert.equal(newerWml['common-mod'].cachedRelease,undefined,'different WML versions never share a release cache');
snapshot.wmlVersion='0.9.4';snapshot.gameVersion='2026-11-02';await send({type:'GAME_SNAPSHOT',snapshot,apis},gameSender);
const newerGame=Object.fromEntries((await send({type:'GET_GAME',tabId:1},{url:uiURL})).game.mods.map(mod=>[mod.modId,mod]));
assert.equal(newerGame['common-mod'].cachedRelease,undefined,'different game versions never share a release cache');
assert.equal(newerGame['manual-mod'].postURL,manualPost,'Wayward still uses its existing manual registration');
assert.equal(newerGame['or-mod'].postURL,undefined,'a game version outside an OR list is excluded');
snapshot.gameVersion='2026-11-01';
assert.equal((await send({type:'SCAN_WIKI_CANDIDATES',tabId:1},gameSender)).code,'INVALID_SENDER');
assert.equal(requests.some(url=>url.includes('/functions/v1/wiki-submit')),false,'automatic submissions default to off');
snapshot.mods.push({id:'new-auto',version:'1.0.0'});apis.push({modId:'new-auto',protocol:2,active:true,postURL:apiPost});
local.data.wikiAutoSubmit=true;local.data.wikiAutoAttempts={times:[Date.now(),Date.now()],seen:{}};
await send({type:'GAME_SNAPSHOT',snapshot,apis},gameSender);
for(let i=0;i<100 && !alarmItems.has('wiki-auto-retry-1');i++)await new Promise(resolve=>setTimeout(resolve,10));
assert.equal(session.data['wiki-auto-retry-1'],'doc','hourly retry is bound to the active game document');
assert.ok(alarmItems.has('wiki-auto-retry-1'));
await new Promise(resolve=>setTimeout(resolve,30));const beforeOptOut=requests.length;
local.data.wikiAutoSubmit=false;alarmHandler({name:'wiki-auto-retry-1'});await new Promise(resolve=>setTimeout(resolve,30));
assert.equal(requests.length,beforeOptOut,'revoked consent prevents a queued retry from making requests');
local.data.wikiAutoSubmit=true;await send({type:'GAME_SNAPSHOT',snapshot,apis},gameSender);
for(let i=0;i<100 && !session.data['wiki-auto-retry-1'];i++)await new Promise(resolve=>setTimeout(resolve,10));
assert.equal(session.data['wiki-auto-retry-1'],'doc');
navigate(1,{status:'loading'});for(let i=0;i<100 && session.data['wiki-auto-retry-1'];i++)await new Promise(resolve=>setTimeout(resolve,10));
assert.equal(session.data['wiki-auto-retry-1'],undefined,'navigation cancels the pending retry');
assert.equal(alarmItems.has('wiki-auto-retry-1'),false);
console.log('Wiki source fallback: API/manual priority, validated public catalog and no installed IDs in requests passed.');
