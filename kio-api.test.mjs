import assert from 'node:assert/strict';
import {downloadKioApi,findKioRelease} from './kio-api.mjs';
import {Encoder, decode} from './vendor/cbor-x-1.6.4.mjs';
const encoder = new Encoder({useRecords:false, tagUint8Array:false});
const options = {url:'https://kio.ac/c/dDt9ZC8_D_KbDWKWJiNkeb', version:'1.82.2', password:'test-password'};
const root = new Uint8Array(16), fileId = new Uint8Array(16).fill(1);
const cdn = 'https://dalet.mittere.io/' + 'a'.repeat(64);
const bytes = Uint8Array.from({length:16}, (_, i) => i);
const realFetch = globalThis.fetch;
function mock(config = {}) {
  const calls = []; let getCount = 0;
  const reply = (data, status = 200) => new Response(encoder.encode(data), {status, headers:{'content-type':'application/cbor'}});
  globalThis.fetch = async (url, request) => {
    calls.push({url, request});
    assert.equal(request.redirect, 'error'); assert.equal(request.credentials, 'omit');
    if (config.denied) return new Response('Denied', {status:403});
    if (url.endsWith('/collection/get')) {
      const data = decode(request.body);
      assert.equal(data.uuid.length, 16);
      if (!getCount++) return reply({meta:{type:config.protector || 'password'}}, 418);
      assert.equal(data.protector[0].data.get('password'), options.password);
      if (config.wrongPassword) return reply({meta:{type:'password'}}, 418);
      return reply({root, token:'test-token', segment_size:16});
    }
    if (url.endsWith('/directory/get')) {
      assert.equal(request.headers['Kiosk-CAT'], 'test-token');
      const file = {name:config.filename || 'attention-image-prompt 1.82.2.zip', id:fileId, size:config.fileSize || 16};
      return reply({files:[{name:'AIP 이미지 서버 WML 0.9.5.zip', id:root, size:7}, file, ...(config.duplicate ? [file] : [])]});
    }
    if (url.endsWith('/file/gets')) {
      const data = decode(request.body); assert.deepEqual([...data.ids[0]], [...fileId]);
      return reply({files:[{segments:[{type:config.segmentType || 'cdn', data:new Map([['url', config.cdn || cdn]])}]}]});
    }
    assert.equal(url, cdn);
    return new Response(config.short ? bytes.slice(0, 15) : bytes, {status:200});
  };
  return calls;
}
try {
  const calls = mock();
  assert.deepEqual(new Uint8Array(await downloadKioApi(options)), bytes);
  assert.equal(calls.length, 5);
  mock({filename:'another-mod 1.82.2.zip'});
  assert.deepEqual(new Uint8Array(await downloadKioApi({...options, modId:'another-mod'})), bytes);
  for (const modId of ['another_mod', 'my.mod']) {
    mock({filename:`${modId} 1.82.2.zip`});
    assert.deepEqual(new Uint8Array(await downloadKioApi({...options, modId})), bytes);
  }
  for (const modId of ['con', 'aux.mod', 'trailing.']) {
    const calls = mock(); await assert.rejects(downloadKioApi({...options, modId}), /ID/); assert.equal(calls.length, 0);
  }
  mock(); await assert.rejects(downloadKioApi({...options, modId:'another-mod'}), /하나로/);
  const invalidIdCalls = mock(); await assert.rejects(downloadKioApi({...options, modId:'../bad'}), /ID/); assert.equal(invalidIdCalls.length, 0);
  mock({denied:true}); await assert.rejects(downloadKioApi(options), /403/);
  mock({wrongPassword:true}); await assert.rejects(downloadKioApi(options), /비밀번호/);
  mock({protector:'captcha'}); await assert.rejects(downloadKioApi(options), /지원하지 않는 인증/);
  mock({filename:'Faith_Mod_DivineBeast_v3.3.0.zip'});
  assert.equal((await findKioRelease({urls:[options.url],password:options.password,modId:'faith-divine-beast'})).version,'3.3.0');
  mock({filename:'another-mod 1.82.2.zip'});
  const discovery=await findKioRelease({urls:[options.url],password:options.password,modId:'another-mod'});
  assert.equal(discovery.fileName,'another-mod 1.82.2.zip');
  mock({filename:'unrelated.zip'});
  await assert.rejects(findKioRelease({urls:[options.url],password:options.password,modId:'another-mod'}),error=>error.message.includes('another-mod 1.2.3.zip') && error.message.includes('wml/mods/another-mod/mod.js') && error.message.includes(options.url) && error.message.includes('unrelated.zip'));
  mock(); await assert.rejects(findKioRelease({urls:[options.url],modId:'attention-image-prompt'}),{code:'PASSWORD_REQUIRED'});
  mock({duplicate:true}); await assert.rejects(findKioRelease({...options,urls:[options.url],modId:'attention-image-prompt'}),/여러 개/);
  mock({duplicate:true}); await assert.rejects(downloadKioApi(options), /하나로/);
  mock({fileSize:257*1024*1024}); await assert.rejects(downloadKioApi(options), /256 MiB/);
  mock({short:true}); await assert.rejects(downloadKioApi(options), /크기가 일치/);
  mock({segmentType:'edge'}); await assert.rejects(downloadKioApi(options), /전송 방식/);
  for (const cdn of ['https://127.0.0.1/file', 'http://dalet.mittere.io/'+'a'.repeat(64), 'https://dalet.mittere.io.evil.example/file', 'https://user:pass@dalet.mittere.io/'+'a'.repeat(64)]) {
    const requests = mock({cdn}); await assert.rejects(downloadKioApi(options), /전송 주소/); assert.equal(requests.length, 4);
  }
  const requests = mock(); await assert.rejects(downloadKioApi({...options,url:'https://evil.example/c/dDt9ZC8_D_KbDWKWJiNkeb'}), /공유 주소/); assert.equal(requests.length, 0);
} finally { globalThis.fetch = realFetch; }
console.log('Kio API: password flow, exact mod file, bounded sizes, denied auth, and host restrictions passed');
