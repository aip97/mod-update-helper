import assert from 'node:assert/strict';
import {createWikiAuto} from './wiki-auto.mjs';
import {POST_URL} from './core.mjs';

const post='https://kone.gg/s/example/abcdefghijklmnopqrstuv', url='https://kio.ac/c/abcdefghijklmnopqrstuv';
const makeGame = ids => ({tabId:1,documentId:'doc-1',gameFamily:'wayward',gameVersion:'2026-11-01',wmlVersion:'0.9.5',mods:ids.map(id=>({modId:id,modVersion:'1.0.0',supported:true})),api:Object.fromEntries(ids.map(id=>[id,{protocol:2,active:true,postURL:post,modName:id}]))});
function fixture(ids=['first-mod']) {
  let clock=10000000, lock=Promise.resolve(), active=makeGame(ids), approved=[];
  const data={}, calls={sources:0,diagnose:0,download:0,inspect:0,submit:[],retry:[]};
  const storage={async get(keys){return Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,structuredClone(data[key])]));},async set(values){Object.assign(data,structuredClone(values));}};
  const deps={storage,now:()=>clock,mutate:fn=>{const value=lock.then(fn);lock=value.catch(()=>{});return value;},
    sources:async()=>{calls.sources++;return approved.map(value=>typeof value === 'string' ? {mod_id:value,game_family:'wayward',post_url:post} : value);},
    diagnose:async modId=>{calls.diagnose++;return {ok:true,checks:[{id:'collection_files',status:'pass'}],release:{url,version:'1.0.0',fileName:modId+' 1.0.0.zip'}};},
    password:async()=> 'private-test-password',
    download:async args=>{calls.download++;assert.equal(args.password,'private-test-password');return new ArrayBuffer(1);},
    inspect:async()=>{calls.inspect++;return {version:'1.0.0',gameSpec:'>=2026-10-04',supportedWml:['0.9.5']};},
    submit:async(kind,payload,source)=>{calls.submit.push({kind,payload,source});return {status:'pending'};},
    current:async()=>active,retry:async(game,when)=>calls.retry.push({tabId:game.tabId,documentId:game.documentId,when})};
  return {data,calls,deps,game:active,advance:ms=>clock+=ms,setActive:value=>active=value,setApproved:ids=>approved=ids};
}
const wait=async condition=>{for(let i=0;i<200;i++){if(condition())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.ok(condition(),'background scan did not finish');};

const disabled=fixture();createWikiAuto(disabled.deps)(disabled.game);await new Promise(resolve=>setTimeout(resolve,20));
assert.equal(disabled.calls.sources,0,'automatic submissions are off by default');
const inactive=fixture();inactive.data.wikiAutoSubmit=true;inactive.game.api['first-mod'].active=false;
createWikiAuto(inactive.deps)(inactive.game);await new Promise(resolve=>setTimeout(resolve,20));assert.equal(inactive.calls.sources,0,'inactive API responses are not submitted');
const legacy=fixture(['attention-image-prompt']);legacy.data.wikiAutoSubmit=true;legacy.game.api['attention-image-prompt']={protocol:1};
createWikiAuto(legacy.deps)(legacy.game);await wait(()=>legacy.calls.submit.length===1);
assert.equal(legacy.calls.submit[0].payload.post_url,POST_URL,'legacy AIP uses its known post only');
assert.equal(legacy.calls.submit[0].payload.api_version,'1');

const limited=fixture(['first-mod','second-mod','third-mod']);limited.data.wikiAutoSubmit=true;
const schedule=createWikiAuto(limited.deps);schedule(limited.game);
await wait(()=>limited.calls.submit.length===2);
await wait(()=>limited.calls.retry.length===1);
assert.deepEqual(limited.calls.retry[0],{tabId:1,documentId:'doc-1',when:13600001},'remaining candidates are scheduled after the hourly limit');
assert.equal(limited.data.wikiAutoAttempts.times.length,2);
assert.equal(limited.data.wikiAutoStatus[0].status,'pending');
assert.equal(limited.calls.submit[0].kind,'create');assert.equal(limited.calls.submit[0].source,'detected');
assert.equal(limited.calls.submit[0].payload.category,'미분류');
assert.equal(JSON.stringify(limited.calls.submit).includes('private-test-password'),false,'Kio password is never sent to the wiki');
schedule(limited.game);await new Promise(resolve=>setTimeout(resolve,20));assert.equal(limited.calls.submit.length,2,'hourly limit and per-release dedup apply');
limited.advance(3600001);schedule(limited.game);await wait(()=>limited.calls.submit.length===3);
assert.equal(limited.calls.submit[2].payload.mod_id,'third-mod');

const known=fixture();known.data.wikiAutoSubmit=true;known.setApproved(['first-mod']);createWikiAuto(known.deps)(known.game);
await wait(()=>known.calls.sources===1);await new Promise(resolve=>setTimeout(resolve,10));assert.equal(known.calls.diagnose,0,'published wiki entries are not resubmitted');

const otherFamily=fixture();otherFamily.data.wikiAutoSubmit=true;otherFamily.setApproved([{mod_id:'first-mod',game_family:'faith'}]);
createWikiAuto(otherFamily.deps)(otherFamily.game);await wait(()=>otherFamily.calls.submit.length===1);
assert.equal(otherFamily.calls.submit[0].payload.mod_id,'first-mod','an entry for another game does not block registration');
const shared=fixture();shared.data.wikiAutoSubmit=true;shared.setApproved([{mod_id:'first-mod',game_family:'any'}]);
createWikiAuto(shared.deps)(shared.game);await wait(()=>shared.calls.sources===1);await new Promise(resolve=>setTimeout(resolve,10));assert.equal(shared.calls.diagnose,0,'a shared entry covers all game families');

const multiFamily=fixture();multiFamily.data.wikiAutoSubmit=true;
const faithGame={...makeGame(['first-mod']),tabId:2,documentId:'faith-doc',gameFamily:'faith',gameVersion:'faith-3.3.2'};
multiFamily.deps.current=async tabId=>tabId===1?multiFamily.game:faithGame;
multiFamily.deps.inspect=async()=>({version:'1.0.0',gameSpec:multiFamily.calls.submit.length ? 'faith>=3.0.0' : '>=2026-10-04',supportedWml:['0.9.5']});
const multiQueue=createWikiAuto(multiFamily.deps);multiQueue(multiFamily.game);await wait(()=>multiFamily.calls.submit.length===1);
multiQueue(faithGame);await wait(()=>multiFamily.calls.submit.length===2);
assert.equal(multiFamily.calls.submit[1].payload.game_spec,'faith>=3.0.0','identical mod IDs and posts in different game families do not share an attempt key');
const wrongPackage=fixture();wrongPackage.data.wikiAutoSubmit=true;wrongPackage.deps.inspect=async()=>({version:'1.0.0',gameSpec:'faith>=3.0.0',supportedWml:['0.9.5']});
createWikiAuto(wrongPackage.deps)(wrongPackage.game);await wait(()=>wrongPackage.data.wikiAutoStatus?.length===1);
assert.equal(wrongPackage.data.wikiAutoStatus[0].status,'archive_failed');assert.equal(wrongPackage.calls.submit.length,0,'an incompatible archive must not be auto-submitted');

const invalid=fixture();invalid.data.wikiAutoSubmit=true;
const goodDiagnostic=invalid.deps.diagnose;let failedDiagnostic=true;
invalid.deps.diagnose=async(...args)=>failedDiagnostic ? {ok:true,checks:[{id:'collection_files',status:'warning'}],release:{url,version:'1.0.0'}} : goodDiagnostic(...args);
const retryInvalid=createWikiAuto(invalid.deps);retryInvalid(invalid.game);await wait(()=>invalid.data.wikiAutoStatus?.length===1);
assert.equal(invalid.data.wikiAutoStatus[0].status,'diagnostic_failed');assert.equal(invalid.calls.download,0);assert.equal(invalid.calls.submit.length,0);
invalid.advance(3600001);failedDiagnostic=false;retryInvalid(invalid.game);await wait(()=>invalid.calls.submit.length===1);

const badArchive=fixture();badArchive.data.wikiAutoSubmit=true;badArchive.deps.inspect=async()=>{throw new Error('unsafe archive');};
createWikiAuto(badArchive.deps)(badArchive.game);await wait(()=>badArchive.data.wikiAutoStatus?.length===1);
assert.equal(badArchive.data.wikiAutoStatus[0].status,'archive_failed');assert.equal(badArchive.calls.submit.length,0);

const withdrawn=fixture();withdrawn.data.wikiAutoSubmit=true;let resume;
withdrawn.deps.download=async()=>new Promise(resolve=>{resume=resolve;});
createWikiAuto(withdrawn.deps)(withdrawn.game);await wait(()=>typeof resume==='function');withdrawn.data.wikiAutoSubmit=false;resume(new ArrayBuffer(1));
await new Promise(resolve=>setTimeout(resolve,20));assert.equal(withdrawn.calls.submit.length,0,'revoked consent prevents submission');

const navigated=fixture();navigated.data.wikiAutoSubmit=true;let finish;
navigated.deps.download=async()=>new Promise(resolve=>{finish=resolve;});
createWikiAuto(navigated.deps)(navigated.game);await wait(()=>typeof finish==='function');navigated.setActive({...navigated.game,documentId:'another'});finish(new ArrayBuffer(1));
await new Promise(resolve=>setTimeout(resolve,20));assert.equal(navigated.calls.submit.length,0,'stale game document cannot submit');

const parallel=fixture(['first-mod']);parallel.data.wikiAutoSubmit=true;const other={...makeGame(['second-mod']),tabId:2,documentId:'doc-2'};
parallel.deps.current=async tabId=>tabId===1?parallel.game:other;
const diagnosis=parallel.deps.diagnose;let continueFirst;
parallel.deps.diagnose=async (...args)=>{if(args[0]==='first-mod')await new Promise(resolve=>{continueFirst=resolve;});return diagnosis(...args);};
const queue=createWikiAuto(parallel.deps);queue(parallel.game);await wait(()=>typeof continueFirst==='function');queue(other);queue(parallel.game);continueFirst();
await wait(()=>parallel.calls.submit.length===2);
assert.deepEqual(parallel.calls.submit.map(call=>call.payload.mod_id),['first-mod','second-mod'],'other game documents are queued and repeated snapshots deduplicated');
console.log('Wiki auto: opt-in, diagnostics, local ZIP inspection, dedup, rate limit and consent cancellation passed.');
