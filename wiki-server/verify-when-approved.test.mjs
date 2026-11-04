import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {writeZip} from '../zip-tools.mjs';
import {verifyPublicRelease} from './verify-when-approved.mjs';

test('archived verifier checks supplied post and ZIP fixtures only',async()=>{
  const post='https://kone.gg/s/wayward-wml/cxDZPwAi6ZQYfWwmovNAeb';
  const collection='https://kio.ac/c/abcdefghijklmnopqrstuv';
  const payload={mod_id:'sample-mod',post_url:post,wml_versions:['0.9.5'],game_spec:'>=2026-11-01',version:'1.2.3'};
  const source=`WML.define({id:'sample-mod',version:'1.2.3',game:'>=2026-11-01',wml:'0.9.5',setup(api){const q='WML_MOD_UPDATER_QUERY',s='WML_MOD_UPDATER_STATUS',x={protocol:2},postURL='${post}';}});`;
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'wiki-verifier-test-'));
  try {
    const zip=path.join(temp,'fixture.zip');
    writeZip(zip,[{name:'wml/mods/sample-mod/mod.js',data:Buffer.from(source)}]);
    const bytes=fs.readFileSync(zip), fetcher=async()=>new Response(`<title>Example</title><article>${collection}</article>`);
    const listFiles=async()=>[{name:'sample-mod 1.2.3.zip',size:bytes.length}], download=async()=>bytes;
    assert.equal((await verifyPublicRelease(payload,{fetcher,listFiles,download})).apiVerified,true);
    const secret=randomUUID(), other='https://kio.ac/c/bcdefghijklmnopqrstuvw', calls=[];
    const twoLinks=async()=>new Response(`<article>${other} ${collection}</article>`);
    const withSecret={fetcher:twoLinks,kioPassword:secret,kioPasswordUrls:[collection],
      listFiles:async({url,password})=>{calls.push({url,password});return url===collection?[{name:'sample-mod 1.2.3.zip',size:bytes.length}]:[];},
      download:async({url,password})=>{calls.push({url,password});return bytes;}};
    const verified=await verifyPublicRelease(payload,withSecret);
    assert.equal(verified.apiVerified,true);
    assert.equal(calls.find(call=>call.url===other).password,undefined);
    assert.equal(calls.filter(call=>call.url===collection).length,2);
    assert.ok(calls.filter(call=>call.url===collection).every(call=>call.password===secret));
    assert.equal(JSON.stringify(verified).includes(secret),false);
    await assert.rejects(verifyPublicRelease(payload,{...withSecret,kioPasswordUrls:[]}),e=>e.manualReview===true && !e.message.includes(secret));
    await assert.rejects(verifyPublicRelease(payload,{...withSecret,listFiles:async()=>{throw new Error(secret)}}),e=>e.manualReview===true && !e.message.includes(secret));
    await assert.rejects(verifyPublicRelease(payload,{...withSecret,download:async()=>{throw new Error(secret)}}),e=>e.manualReview===true && !e.message.includes(secret));
    await assert.rejects(verifyPublicRelease(payload,{...withSecret,download:async()=>{throw secret}}),e=>e.manualReview===true && !e.message.includes(secret));
    await assert.rejects(verifyPublicRelease({...payload,version:'1.2.4'},{fetcher,listFiles,download}),/버전/);
    await assert.rejects(verifyPublicRelease(payload,{fetcher:async()=>new Response('',{status:403}),listFiles,download}),e=>e.manualReview===true);
    await assert.rejects(verifyPublicRelease(payload,{fetcher:async()=>new Response('<title>Kone</title><script data-sveltekit-fetched></script>'),listFiles,download}),e=>e.manualReview===true);
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
});
