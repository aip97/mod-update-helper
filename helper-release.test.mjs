import assert from 'node:assert/strict';
import {findHelperRelease, helperPostURL} from './helper-release.mjs';

const postURL = 'https://kone.gg/s/wayward-wml/cxDZPwAi6ZQYfWwmovNAeb';
const kio = 'https://kio.ac/c/dDt9ZC8_D_KbDWKWJiNkeb';
const html = `<title>도우미</title><div class="article-prose"><p>다운로드 (0.8.1)</p><p>${Buffer.from(kio).toString('base64')}</p></div>`;
const envelope = version => JSON.stringify({payload:Buffer.from(JSON.stringify({schema:1,version})).toString('base64'),signature:'c2ln'});
const files = [
  {name:'Mod-Update-Helper-User-0.8.0.zip',size:300},
  {name:'Mod-Update-Helper-User-0.8.1.zip',size:400},
  {name:'Mod-Update-Helper-Modder-0.8.1.zip',size:100},
  {name:'wml-updater-release-0.8.0.json',size:50},
  {name:'wml-updater-release.json',size:60},
];
const signatures = {'wml-updater-release-0.8.0.json':envelope('0.8.0'),'wml-updater-release.json':envelope('0.8.1')};
const listed = [], downloaded = [];
const list = async ({url,password}) => { listed.push({url,password}); return files; };
const download = async ({fileName,password,maxBytes}) => { downloaded.push({fileName,password,maxBytes}); return new TextEncoder().encode(signatures[fileName]).buffer; };

const release = await findHelperRelease({html,postURL,password:'shared',list,download});
assert.equal(release.version,'0.8.1');
assert.deepEqual(release.zip,{url:kio,fileName:'Mod-Update-Helper-User-0.8.1.zip',size:400});
assert.equal(release.envelope,signatures['wml-updater-release.json']);
assert.deepEqual(listed,[{url:kio,password:'shared'}],'the shared mod password opens the collection');
assert.deepEqual(downloaded,[{fileName:'wml-updater-release.json',password:'shared',maxBytes:131072}],'an older versioned signature is never downloaded');

// Signed-out visitors receive the board instead of the article body.
const board = '<title>도우미 - wayward- | 코네</title><main><a>로그인</a>' + '<p>다른 게시글 제목</p>'.repeat(300) + '</main>';
await assert.rejects(findHelperRelease({html:board,postURL,list,download}),error => error.code === 'KONE_LOGIN_REQUIRED' && error.postURL === postURL && /로그인/.test(error.message));
await assert.rejects(findHelperRelease({html:'<title>로그인</title>',postURL,list,download}),{code:'KONE_LOGIN_REQUIRED'});

await assert.rejects(findHelperRelease({html,postURL,list:async()=>files.slice(0,3),download}),{code:'HELPER_SIGNATURE_MISSING'});
await assert.rejects(findHelperRelease({html,postURL,list:async()=>files.slice(2),download}),{code:'HELPER_RELEASE_MISSING'});
await assert.rejects(findHelperRelease({html,postURL,list:async()=>[...files,{name:'Mod-Update-Helper-User-0.8.1.zip',size:400}],download}),{code:'HELPER_RELEASE_DUPLICATE'});
await assert.rejects(findHelperRelease({html,postURL,list:async()=>[{name:'Mod-Update-Helper-User-0.8.1.zip',size:17*1024*1024},files[4]],download}),{code:'HELPER_RELEASE_INVALID'});
const mismatched = {...signatures,'wml-updater-release.json':envelope('0.8.0')};
await assert.rejects(findHelperRelease({html,postURL,list,download:async({fileName})=>new TextEncoder().encode(mismatched[fileName]).buffer}),{code:'HELPER_SIGNATURE_MISSING'},'a signature for another version is not accepted');
await assert.rejects(findHelperRelease({html,postURL,list:async()=>{throw Object.assign(new Error('비밀번호'),{code:'PASSWORD_REQUIRED'});},download}),{code:'PASSWORD_REQUIRED'});

assert.equal(await helperPostURL(async()=>({postURL})),postURL);
await assert.rejects(helperPostURL(async()=>({})),{code:'HELPER_UNCONFIGURED'});
await assert.rejects(helperPostURL(async()=>({postURL:'https://example.com/s/a/cxDZPwAi6ZQYfWwmovNAeb'})));
console.log('Helper release: Kone post, Base64 Kio link, shared password, signature pairing and login detection passed.');
