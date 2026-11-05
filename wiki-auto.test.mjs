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
assert.equal(known.data.wikiAutoStatus,undefined,'already published mods must not create new status records');

const publishedTransition=fixture();publishedTransition.data.wikiAutoSubmit=true;
publishedTransition.data.wikiAutoStatus=[{modId:'first-mod',gameFamily:'wayward',status:'pending',at:1},{modId:'first-mod',gameFamily:'faith',status:'pending',at:1}];
publishedTransition.setApproved(['first-mod']);createWikiAuto(publishedTransition.deps)(publishedTransition.game);
await wait(()=>publishedTransition.data.wikiAutoStatus?.some(item=>item.gameFamily==='wayward' && item.status==='published'));
assert.equal(publishedTransition.calls.diagnose,0);assert.equal(publishedTransition.calls.submit.length,0);
assert.equal(publishedTransition.data.wikiAutoStatus.find(item=>item.gameFamily==='faith').status,'pending','another game family must retain its own status');

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
const goodDiagnostic=invalid.deps.diagnose;let failedDiagnostic=true, diagnosticAttempts=0;
invalid.deps.diagnose=async(...args)=>{diagnosticAttempts++;return failedDiagnostic ? {ok:true,checks:[{id:'collection_files',status:'warning'}],release:{url,version:'1.0.0'}} : goodDiagnostic(...args);};
const retryInvalid=createWikiAuto(invalid.deps);retryInvalid(invalid.game);await wait(()=>invalid.data.wikiAutoStatus?.length===1);
assert.equal(invalid.data.wikiAutoStatus[0].status,'diagnostic_failed');assert.equal(invalid.calls.download,0);assert.equal(invalid.calls.submit.length,0);
await wait(()=>invalid.calls.retry.length===1);
assert.deepEqual(invalid.calls.retry[0],{tabId:1,documentId:'doc-1',when:13600001},'failed diagnostics schedule a retry after the per-item cooldown');
retryInvalid(invalid.game);await wait(()=>invalid.calls.retry.length===2);
assert.equal(diagnosticAttempts,1,'repeated events must not bypass the failed-item cooldown');
assert.equal(invalid.calls.retry[1].when,13600001,'repeated events preserve the original retry time');
invalid.advance(3600001);failedDiagnostic=false;retryInvalid(invalid.game);await wait(()=>invalid.calls.submit.length===1);

const newlyActive=fixture(['first-mod']);newlyActive.data.wikiAutoSubmit=true;
const originalDiagnostic=newlyActive.deps.diagnose;
let alarmUnavailable=false;
const originalRetry=newlyActive.deps.retry;
newlyActive.deps.retry=async(...args)=>{await originalRetry(...args);if(alarmUnavailable)throw new Error('alarm unavailable');};
newlyActive.deps.diagnose=async id=>id==='first-mod'
  ? {ok:true,checks:[{id:'collection_files',status:'warning'}],release:{url,version:'1.0.0'}}
  : originalDiagnostic(id);
const newlyActiveQueue=createWikiAuto(newlyActive.deps);newlyActiveQueue(newlyActive.game);
await wait(()=>newlyActive.data.wikiAutoStatus?.[0]?.status==='diagnostic_failed' && newlyActive.calls.retry.length===1);
alarmUnavailable=true;
const nextSnapshot=makeGame(['first-mod','second-mod']);newlyActive.setActive(nextSnapshot);newlyActiveQueue(nextSnapshot);
await wait(()=>newlyActive.calls.submit.length===1);
assert.equal(newlyActive.calls.submit[0].payload.mod_id,'second-mod','a previously failed candidate must not block a newly active candidate');
assert.equal(newlyActive.data.wikiAutoAttempts.times.length,2,'the new candidate still consumes the hourly quota');
assert.equal(newlyActive.calls.retry[1].when,13600001,'the failed candidate retains its original retry time');

const sourceFailure=fixture();sourceFailure.data.wikiAutoSubmit=true;
const sourceSuccess=sourceFailure.deps.sources;let catalogAvailable=false;
sourceFailure.deps.sources=async(...args)=>{if(catalogAvailable)return sourceSuccess(...args);sourceFailure.calls.sources++;throw new Error('catalog unavailable');};
const sourceQueue=createWikiAuto(sourceFailure.deps);sourceQueue(sourceFailure.game);
await wait(()=>sourceFailure.data.wikiAutoStatus?.length===1 && sourceFailure.calls.retry.length===1);
assert.equal(sourceFailure.data.wikiAutoStatus[0].status,'error','catalog failure must be visible');
assert.deepEqual(sourceFailure.calls.retry[0],{tabId:1,documentId:'doc-1',when:13600001},'catalog failure schedules a bounded retry');
assert.equal(sourceFailure.calls.diagnose,0);
catalogAvailable=true;sourceFailure.advance(3600001);sourceQueue(sourceFailure.game);await wait(()=>sourceFailure.calls.submit.length===1);

const sourceRevoked=fixture();sourceRevoked.data.wikiAutoSubmit=true;let rejectSource;
sourceRevoked.deps.sources=async()=>new Promise((_,reject)=>{rejectSource=reject;});
createWikiAuto(sourceRevoked.deps)(sourceRevoked.game);await wait(()=>typeof rejectSource==='function');
sourceRevoked.data.wikiAutoSubmit=false;rejectSource(new Error('catalog unavailable'));
await new Promise(resolve=>setTimeout(resolve,20));
assert.equal(sourceRevoked.data.wikiAutoStatus,undefined,'revoked consent must not record a new status');
assert.equal(sourceRevoked.calls.retry.length,0,'revoked consent must not schedule another scan');

const sourceChanged=fixture(['first-mod','second-mod']);sourceChanged.data.wikiAutoSubmit=true;let failChangedSource;
sourceChanged.deps.sources=async()=>new Promise((_,reject)=>{failChangedSource=reject;});
createWikiAuto(sourceChanged.deps)(sourceChanged.game);await wait(()=>typeof failChangedSource==='function');
sourceChanged.setActive({...sourceChanged.game,mods:sourceChanged.game.mods.filter(mod=>mod.modId==='second-mod')});
failChangedSource(new Error('catalog unavailable'));
await wait(()=>sourceChanged.calls.retry.length===1);
assert.deepEqual(sourceChanged.data.wikiAutoStatus.map(item=>item.modId),['second-mod'],'only still-active candidates receive failure status');
assert.equal(sourceChanged.calls.retry[0].documentId,'doc-1','remaining candidates still get a retry');

const unknownSubmission=fixture();unknownSubmission.data.wikiAutoSubmit=true;let submissions=0;
unknownSubmission.deps.submit=async()=>{submissions++;throw Object.assign(new Error('outcome unknown'),{code:'SUBMISSION_UNKNOWN'});};
const unknownQueue=createWikiAuto(unknownSubmission.deps);unknownQueue(unknownSubmission.game);
await wait(()=>unknownSubmission.data.wikiAutoStatus?.[0]?.status==='unknown');
assert.equal(unknownSubmission.calls.retry.length,0,'an unknown submission outcome must not schedule a duplicate');
assert.equal(Object.values(unknownSubmission.data.wikiAutoAttempts.seen)[0].submitted,true);
unknownQueue(unknownSubmission.game);await new Promise(resolve=>setTimeout(resolve,20));
assert.equal(submissions,1,'an uncertain submission must not be immediately repeated');
unknownSubmission.advance(86400001);unknownQueue(unknownSubmission.game);await new Promise(resolve=>setTimeout(resolve,20));
assert.equal(submissions,1,'an uncertain submission must not be repeated after the ordinary success cooldown');

for (const change of ['consent','document','session-error']) {
  const interrupted=fixture();interrupted.data.wikiAutoSubmit=true;let rejectSubmission,attempts=0;
  let unavailable=false;
  let activeGame=interrupted.game;
  interrupted.deps.current=async()=>{if(unavailable)throw new Error('session unavailable');return activeGame;};
  interrupted.deps.submit=async()=>{attempts++;return new Promise((_,reject)=>{rejectSubmission=reject;});};
  const queue=createWikiAuto(interrupted.deps);queue(interrupted.game);
  await wait(()=>typeof rejectSubmission==='function');
  const next=change==='document' ? {...interrupted.game,documentId:'new-document'} : interrupted.game;
  if(change==='document')activeGame=next;else if(change==='session-error')unavailable=true;else interrupted.data.wikiAutoSubmit=false;
  rejectSubmission(Object.assign(new Error('outcome unknown'),{code:'SUBMISSION_UNKNOWN'}));
  await wait(()=>Object.values(interrupted.data.wikiAutoAttempts.seen).some(entry=>entry.unknown));
  assert.equal(interrupted.data.wikiAutoStatus,undefined,`${change} must not create a UI status after the context changed`);
  assert.equal(interrupted.calls.retry.length,0,`${change} must not schedule a retry`);
  interrupted.data.wikiAutoSubmit=true;unavailable=false;queue(next);await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(attempts,1,`${change} must retain the in-flight unknown-outcome marker`);
}

const pendingSubmission=fixture();pendingSubmission.data.wikiAutoSubmit=true;
pendingSubmission.deps.submit=async()=>{throw Object.assign(new Error('already pending'),{code:'WIKI_ALREADY_PENDING'});};
createWikiAuto(pendingSubmission.deps)(pendingSubmission.game);
await wait(()=>pendingSubmission.data.wikiAutoStatus?.[0]?.status==='pending');
assert.equal(pendingSubmission.calls.retry.length,0,'an already pending application must not be retried hourly');
assert.equal(Object.values(pendingSubmission.data.wikiAutoAttempts.seen)[0].submitted,true);

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
