import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyPublicRelease,createPublicReleaseVerifier} from './verify.mjs';
import {createHandler} from './wiki-submit.mjs';

const post='https://kone.gg/s/wayward-wml/cxDZPwAi6ZQYfWwmovNAeb';
const payload={mod_id:'sample-mod',name:'Sample',post_url:post,wml_versions:['0.9.5'],game_spec:'>=2026-11-01',description:'Sample description',category:'기타',version:'1.2.3',api_version:'2'};
const publishableKey='sb_publishable_test-key';

test('production verification requires manual review without contacting Kone or Kio',async()=>{
  let contacted=false;
  await assert.rejects(verifyPublicRelease(payload,{fetcher:async()=>{contacted=true;},listFiles:async()=>{contacted=true;},download:async()=>{contacted=true;}}),e=>e.manualReview===true && /자동 수집/.test(e.message));
  await assert.rejects(createPublicReleaseVerifier({enabled:true})(payload),e=>e.manualReview===true && /인증 방식/.test(e.message));
  await assert.rejects(createPublicReleaseVerifier()(payload),e=>e.manualReview===true && /자동 수집/.test(e.message));
  assert.equal(contacted,false);
  await assert.rejects(verifyPublicRelease({...payload,post_url:'https://invalid.example/'}),e=>!e.manualReview);
});

test('submission rate limits before verification and auto-publishes only detected verified candidates',async()=>{
  const calls=[]; let submitted;
  const fetcher=async(url,options)=>{
    const name=String(url).split('/').pop(); calls.push(name);
    assert.equal(options.headers.apikey,'server-key-for-tests-only');
    assert.equal(options.headers.authorization,undefined);
    if(name==='wiki_reserve_quota') return Response.json(true);
    if(name==='wiki_create_submission') {submitted=JSON.parse(options.body).p_payload;return Response.json({id:'11111111-1111-4111-8111-111111111111',status:'pending',revision:1});}
    if(name==='wiki_auto_publish') return Response.json({status:'approved'});
    throw new Error('unexpected request');
  };
  const handler=createHandler({url:'https://example.supabase.co',key:'server-key-for-tests-only',publishableKeys:[publishableKey],fetcher,verify:async()=>{calls.push('verify');return {apiVerified:true,apiVersion:'2',name:'verified name',version:'1.2.3',wmlVersions:['0.9.5'],gameSpec:'>=2026-11-01',packageSha256:'a'.repeat(64)};}});
  const request=source=>new Request('https://example.supabase.co/functions/v1/wiki-submit',{method:'POST',headers:{'cf-connecting-ip':'192.0.2.1',apikey:publishableKey},body:JSON.stringify({kind:'create',source,payload})});
  let response=await handler(request('detected')), body=await response.json();
  assert.equal(body.status,'approved');assert.deepEqual(calls,['wiki_reserve_quota','verify','wiki_create_submission','wiki_auto_publish']);
  assert.equal(submitted.name,'verified name');assert.equal(submitted.description,'설명 미등록');assert.equal(submitted.category,'미분류');
  calls.length=0;response=await handler(request('manual'));body=await response.json();
  assert.equal(body.status,'pending');assert.deepEqual(calls,['wiki_reserve_quota','verify','wiki_create_submission']);
  calls.length=0;response=await handler(new Request('https://example.supabase.co/functions/v1/wiki-submit',{method:'POST',headers:{apikey:publishableKey},body:JSON.stringify({kind:'create',source:'detected',payload})}));
  assert.equal(response.status,400);assert.deepEqual(calls,[]);
  response=await handler(new Request('https://example.supabase.co/functions/v1/wiki-submit',{method:'POST',headers:{'cf-connecting-ip':'192.0.2.1'},body:JSON.stringify({kind:'create',source:'detected',payload})}));
  assert.equal(response.status,401);assert.deepEqual(calls,[]);
  response=await handler(new Request('https://example.supabase.co/functions/v1/wiki-submit',{method:'POST',headers:{apikey:'sb_publishable_incorrect','cf-connecting-ip':'192.0.2.1'},body:JSON.stringify({kind:'create',source:'detected',payload})}));
  assert.equal(response.status,401);assert.deepEqual(calls,[]);
});

test('unverifiable post remains pending and no untrusted approval is accepted',async()=>{
  const calls=[];
  const fetcher=async(url,options)=>{
    const name=String(url).split('/').pop(), args=JSON.parse(options.body);calls.push({name,args});
    return Response.json(name==='wiki_create_submission'?{id:'11111111-1111-4111-8111-111111111111',status:'pending',revision:1}:true);
  };
  const handler=createHandler({url:'https://example.supabase.co',key:'server-key-for-tests-only',publishableKeys:[publishableKey],fetcher});
  const response=await handler(new Request('https://example.supabase.co/functions/v1/wiki-submit',{method:'POST',headers:{'cf-connecting-ip':'192.0.2.1',apikey:publishableKey},body:JSON.stringify({kind:'create',source:'detected',payload,api_verified:true,status:'approved'})}));
  const body=await response.json();assert.equal(body.status,'pending');assert.equal(body.verification,'manual_review');
  assert.match(body.reason,/자동 수집/);
  assert.deepEqual(calls.map(c=>c.name),['wiki_reserve_quota','wiki_create_submission']);
  assert.equal(calls.find(c=>c.name==='wiki_create_submission').args.p_api_verified,false);
  assert.equal(calls.some(c=>c.name==='wiki_auto_publish'),false);
});

test('submission family must match its game condition and is passed to the database',async()=>{
  let sent; let calls=0;
  const handler=createHandler({url:'https://example.supabase.co',key:'server-key-for-tests-only',publishableKeys:[publishableKey],fetcher:async(url,options)=>{
    calls++;
    if(String(url).endsWith('wiki_create_submission')) {sent=JSON.parse(options.body).p_payload;return Response.json({id:'11111111-1111-4111-8111-111111111111',status:'pending',revision:1});}
    return Response.json(true);
  }});
  const request=game_family=>new Request('https://example.supabase.co/functions/v1/wiki-submit',{method:'POST',headers:{'cf-connecting-ip':'192.0.2.1',apikey:publishableKey},body:JSON.stringify({kind:'revision',source:'manual',payload:{...payload,game_family}})});
  const invalid=await handler(request('faith'));
  assert.equal(invalid.status,400);assert.equal(calls,0);
  const valid=await handler(request('wayward'));
  assert.equal(valid.status,200);assert.equal(sent.game_family,'wayward');
});

