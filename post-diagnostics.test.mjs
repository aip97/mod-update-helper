import assert from 'node:assert/strict';
import {analyzeRelease,analyzeReleaseHTML,parseReleaseHTML,POST_URL} from './core.mjs';
const link='https://kio.ac/c/abcdefghijklmnopqrstuv', other='https://kio.ac/c/bBCDEFGHIJKLMNOPQRSTUV';
const options={modId:'test-mod',postURL:POST_URL};
for(const title of ['일반 업데이트','[test-mod] 1.2.3 [other-mod] 2.0.0','선술집 확장판 v0.1.16 (WML)','']) {
 const report=analyzeRelease(title,'링크 : '+btoa(link),options);
 assert.equal(report.ok,true);
 assert.deepEqual(report.release.urls,[link]);
 assert.equal(report.checks.find(c=>c.id==='collection_files').status,'warning');
 assert.equal(report.checks.find(c=>c.id==='zip_contents').status,'warning');
}
assert.deepEqual(analyzeRelease('컬렉션',link+' '+btoa(link)+' '+other,options).release.urls,[link,other]);
for(const value of ['',link+'?token=secret',link.replace('https://','https://user:secret@'),btoa('https://evil.example/'), 'aHR0cHM6!!!']) {
 const report=analyzeRelease('아무 제목',value,options);assert.equal(report.ok,false);assert.ok(!JSON.stringify(report).includes('secret'));
}
const html=`<title>일반 제목</title><nav>${other}</nav><article><a href="${link}">받기</a></article><footer>${other}</footer>`;
assert.deepEqual(parseReleaseHTML(html,options).urls,[link]);
const archive=`<title>자유 제목</title><main><div class='article-prose'><div><p>다운로드 (2.0.0)</p>${link}<details><summary>다운로드 (1.0.0)</summary><div><details><summary>old</summary>${other}</details></div></details></div></div><div>댓글 ${other}</div></main>`;
assert.deepEqual(parseReleaseHTML(archive,options).urls,[link],'old folded releases and comments are not active post sources');
assert.equal(analyzeRelease('제목',link,{...options,postURL:POST_URL+'?token=secret'}).ok,false);
assert.throws(()=>analyzeReleaseHTML('x'.repeat(2_000_001),options),e=>e.code==='POST_FORMAT_INVALID');
assert.throws(()=>analyzeReleaseHTML('<title>Sign in - Kone</title>',options),e=>e.code==='KONE_LOGIN_REQUIRED');
assert.throws(()=>analyzeReleaseHTML('<title>코네</title><main>로그인 후 게시글을 확인할 수 있습니다.</main>',options),e=>e.code==='KONE_LOGIN_REQUIRED');
assert.throws(()=>analyzeReleaseHTML('<main>이 게시글에 접근 권한이 없습니다.</main>',options),e=>e.code==='KONE_ACCESS_REQUIRED');
assert.equal(analyzeReleaseHTML(`<header>로그인이 필요합니다.</header><div class="article-prose">${link} 설명: 로그인 후 확인할 수 있습니다.</div>`,options).ok,true);
assert.equal(analyzeReleaseHTML('<div class="article-prose">공유 링크가 없는 실제 게시글입니다.</div>',options).ok,false);
console.log('Free titles, collection links, deduplication, diagnostic boundaries, login and redaction passed');
