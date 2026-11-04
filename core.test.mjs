import assert from 'node:assert/strict';
import vm from 'node:vm';
import {Encoder} from './vendor/cbor-x-1.6.4.mjs';
const encoder=new Encoder({useRecords:false,tagUint8Array:false});
import {readFile} from 'node:fs/promises';
import {validateSnapshot, enrichMod, POST_URL, AIP_ID, compareVersions, parseRelease, parseReleaseHTML, validateStatus, validateReleaseURL, validatePostURL, validateModId} from './core.mjs';
const link = 'https://kio.ac/c/abcdefghijklmnopqrstuv', other = 'https://kio.ac/c/bBCDEFGHIJKLMNOPQRSTUV';
const options = {modId: 'test-mod', postURL: POST_URL};
const status = {protocol: 2, active: true, modId: 'test-mod', modName: 'Test Mod', modVersion: '1.2.3', wmlVersion: '0.9.4', gameVersion: '2026-11-01', postURL: POST_URL};
assert.equal(compareVersions('1.83.10', '1.83.2'), 1);
assert.equal(compareVersions('1.82.2', '1.83.0'), -1);
assert.equal(compareVersions('1.83.0', '1.83.0'), 0);
for (const version of ['1.2', '01.2.3', '1.02.3', '1.2.3.4', '1.2.3-beta']) assert.throws(() => compareVersions(version, '1.2.3'));
for (const value of ['', 'Bad-Mod', '../mod', 'mod.', 'mod ', 'con', 'aux.txt', 'com0', 'com9.js', 'lpt0', 'lpt9.zip', 'a'.repeat(65)]) assert.throws(() => validateModId(value));
for (const modId of ['another_mod', 'my.mod', 'rival_tavern', 'mod--id']) {
  assert.equal(validateModId(modId), modId);
  assert.equal(validateStatus({...status, modId}).modId, modId);
  assert.equal(parseRelease(`[${modId}] 1.2.3`, `다운로드 (1.2.3) ${link}`, {...options, modId}).modId, modId);
}
assert.equal(validatePostURL(POST_URL), POST_URL);
for (const value of ['not a URL', 'https://example.com']) assert.throws(() => validatePostURL(value), error => error.code === 'POST_URL_INVALID');
for (const value of [POST_URL + '?a=b', POST_URL + '#hash', POST_URL.replace('/s/', '/s/space/write/'), POST_URL.replace('kone.gg', 'kone.gg.evil.example'), POST_URL.replace('https://', 'https://user@'), 'https://kone.gg/s/space/short']) assert.throws(() => validatePostURL(value));
assert.equal(validateReleaseURL(link), link);
for (const value of [link + '?a=b', link + '#hash', link.replace('kio.ac', 'evil.example'), link.replace('https://', 'https://user@'), link + 'x']) assert.throws(() => validateReleaseURL(value));
for (const payload of [link, btoa(link), `${link} ${btoa(link)}`]) assert.equal(parseRelease('[test-mod] v1.2.3', `다운로드 (1.2.3) ${payload}`, options).urls[0], link);
assert.equal(parseRelease('상황별 이미지 프롬프트 모드 1.83.1', `다운로드 (1.83.1) ${btoa(link)}`).modId, AIP_ID);
for (const title of ['자유 제목','[other-mod] 9.9.9','[test-mod] 1.2.3 [other-mod] 2.3.4']) {
  assert.deepEqual(parseRelease(title, '링크: '+btoa(link), options).urls,[link]);
}
for (const payload of [link+'?token=secret', btoa('https://evil.example/update.zip'), 'no link']) assert.throws(()=>parseRelease('제목',payload,options));
for (const href of [`href="${link}"`, `href='${link}'`, `href=${link}`]) {
  assert.deepEqual(parseReleaseHTML(`<title>일반 제목</title><nav>${other}</nav><article><a ${href}>받기</a><script>${other}</script></article>`,options).urls,[link]);
}
assert.throws(()=>parseReleaseHTML('<title>로그인 - Kone</title><form><input type="password"></form>',options), error=>error.code==='KONE_LOGIN_REQUIRED');
assert.deepEqual(validateStatus({...status, secret: 'discard'}), status);
assert.equal(validateStatus({...status, protocol: 1}), null);
assert.ok(validateStatus({...status, protocol: 1, modId: AIP_ID}));
for (const patch of [{protocol: 3}, {active: undefined}, {active: 'true'}, {modId: 'bad!'}, {modVersion: '01.0.0'}, {wmlVersion: null}, {modName: 'x'.repeat(101)}, {postURL: 'https://evil.example'}, {gameVersion: {}}]) assert.equal(validateStatus({...status, ...patch}), null);

const snapshot = {wmlVersion: '0.9.5', gameVersion: '2026-11-01', mods: [{id: 'test-mod', version: '1.2.3'}, {id: 'no-api', version: '1.0.0'}, {id: 'raw-version', version: 'v2-beta'}]};
assert.equal(validateSnapshot(snapshot).mods[2].supported, false);
assert.equal(validateSnapshot({...snapshot, mods: [{id: 'no-version', version: ''}]}).mods[0].supported, false);
assert.equal(validateSnapshot({...snapshot, mods: [...snapshot.mods, snapshot.mods[0]]}), null);
assert.equal(validateSnapshot({...snapshot, secret: 'discard'}).secret, undefined);
assert.equal(validateSnapshot(snapshot).gameFamily, 'wayward');
const faithSnapshot = {...snapshot, wmlVersion:'0.9.3', gameVersion:'faith-3.3.2', htmlVersion:'faith-3.3.2'};
assert.equal(validateSnapshot(faithSnapshot).gameFamily, 'faith');
assert.equal(validateSnapshot(faithSnapshot).mods[0].supported, true);
assert.equal(validateSnapshot({...snapshot, wmlVersion:'0.9.2'}).mods[0].supported, false);
for (const patch of [{gameVersion:'unknown'}, {gameFamily:'wayward'}, {htmlVersion:'faith-3.3.1'}, {htmlVersion:'2026-11-01'}]) assert.equal(validateSnapshot({...faithSnapshot, ...patch}), null);
for (const version of ['overtime-1.0.0','harbor-1.2.3','my-other-game-2.4.0']) {
  const other = validateSnapshot({...snapshot,wmlVersion:'1.0.0',gameVersion:version,htmlVersion:version});
  assert.ok(other.mods[0].supported);
  assert.equal(other.gameFamily, version.replace(/-\d+(?:\.\d+)*$/, ''));
}
const post = POST_URL.replace('d7dNsfio5zS0D3neJOhkeb', 'abcdefghijklmnopqrstuv');
assert.equal(enrichMod({}, {postURL: POST_URL}, {postURL: post}).postURL, POST_URL);
assert.equal(enrichMod({}, {postURL: 'invalid'}, {postURL: post}).source, 'manual');
assert.equal(enrichMod({}, {}, {}).apiSupported, true);

// Both content worlds: currentPreset is the only active-list source, optional APIs supply metadata.
const listeners = [], messages = [], queries = [], children = [];
let runtimeListener, requestNumber = 0, preset = {wml: snapshot.wmlVersion, game: snapshot.gameVersion, mods: snapshot.mods};
const win = {
  WML: {VERSION: '0.9.5', currentPreset: () => preset, status() { throw new Error('Forbidden status read'); }},
  addEventListener(type, cb) { if (type === 'message') listeners.push(cb); },
  postMessage(value) { queries.push(value); queueMicrotask(() => listeners.forEach(cb => cb({source: win, data: value}))); }
};
win.top = win;
const element = () => ({style: {}, setAttribute() {}, append(...items) { children.push(...items); }, remove() {}});
const context = {window: win, location: {pathname: '/index.html'}, crypto: {randomUUID: () => 'request-' + (++requestNumber)}, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
  chrome: {runtime: {sendMessage: async value => { messages.push(value); }, onMessage: {addListener: cb => { runtimeListener = cb; }}}},
  document: {getElementById: () => null, createElement: element, body: element()}};
vm.runInNewContext(await readFile(new URL('./wml-reader.js', import.meta.url), 'utf8'), context);
vm.runInNewContext(await readFile(new URL('./game-bridge.js', import.meta.url), 'utf8'), context);
const installedListeners = listeners.length;
vm.runInNewContext(await readFile(new URL('./wml-reader.js', import.meta.url), 'utf8'), context);
vm.runInNewContext(await readFile(new URL('./game-bridge.js', import.meta.url), 'utf8'), context);
assert.equal(listeners.length, installedListeners, 'reconnecting must not duplicate bridge listeners');
await new Promise(resolve => setTimeout(resolve, 400));
assert.equal(messages[0].type, 'GAME_SNAPSHOT');
assert.equal(messages[0].snapshot.mods.length, 3);
assert.equal(messages[0].apis.length, 0);
preset = {...preset, mods: [{id: 'no-api', version: '1.0.0'}]};
const fresh = await new Promise(resolve => runtimeListener({type: 'READ_SNAPSHOT'}, {}, resolve));
assert.equal(fresh.snapshot.mods.length, 1);
assert.equal(fresh.snapshot.mods[0].id, 'no-api');
preset = {...preset, mods: [{id: 'no-version'}, {id: 'long-version', version: 'a'.repeat(200)}]};
const versionless = await new Promise(resolve => runtimeListener({type: 'READ_SNAPSHOT'}, {}, resolve));
assert.equal(versionless.snapshot.mods[0].version, '');
assert.equal(versionless.snapshot.mods[1].version.length, 64);
assert.equal(validateSnapshot(versionless.snapshot).mods.every(mod => !mod.supported), true);
preset = {wml:'0.9.3', game:'faith-3.3.2', mods:[{id:'faith-mobile',version:'1.0.1'}]};
context.document.querySelector = selector => selector === 'meta[name="wf-version"]' ? {content:'3.3.2'} : null;
const faithReply = await new Promise(resolve => runtimeListener({type:'READ_SNAPSHOT'}, {}, resolve));
assert.equal(faithReply.snapshot.htmlVersion, 'faith-3.3.2');
assert.equal(validateSnapshot(faithReply.snapshot).gameFamily, 'faith');
context.document.querySelector = selector => selector === 'meta[name="wf-version"]' ? {content:'3.3.1'} : null;
const staleHTML = await new Promise(resolve => runtimeListener({type:'READ_SNAPSHOT'}, {}, resolve));
assert.equal(staleHTML.ok, false);
for (const [version, meta, content] of [['overtime-1.0.0','ot-version','1.0.0'], ['harbor-1.2.3','wml-game','harbor-1.2.3']]) {
  preset = {wml:'0.10.0',game:version,mods:[{id:'example-mod',version:'1.0.0'}]};
  context.document.querySelector = selector => selector === `meta[name="${meta}"]` ? {content} : null;
  const reply = await new Promise(resolve => runtimeListener({type:'READ_SNAPSHOT'}, {}, resolve));
  assert.equal(validateSnapshot(reply.snapshot).htmlVersion, version);
}
win.WML_GAME = 'faith-3.3.2';
assert.equal((await new Promise(resolve => runtimeListener({type:'READ_SNAPSHOT'}, {}, resolve))).ok, false, 'conflicting HTML declarations fail closed');
delete win.WML_GAME;
runtimeListener({type: 'UPDATE_AVAILABLE', modId: 'test-mod', current: '1.0.0', version: '1.1.0'});
const count = children.length;
runtimeListener({type: 'UPDATE_AVAILABLE', modId: 'test-mod', current: '1.0.0', version: '1.1.0'});
assert.equal(children.length, count);
win.WML.currentPreset = () => { throw new Error('unavailable'); };
assert.equal((await new Promise(resolve => runtimeListener({type: 'READ_SNAPSHOT'}, {}, resolve))).ok, false);

const makeStorage = () => {
  const data = {};
  return {data, async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in data).map(k => [k, structuredClone(data[k])])); }, async set(values) { Object.assign(data, structuredClone(values)); }, async remove(key) { delete data[key]; }};
};
const local = makeStorage(), session = makeStorage(), fetches = [];
let handler, navigation, removal, currentSnapshot = snapshot, apis = [], tabURL = 'file:///game/index.html', tabClosed = false, duringRead, fileAccess = true;
globalThis.chrome = {
  extension: {async isAllowedFileSchemeAccess() { return fileAccess; }},
  scripting: {async executeScript({target, files, world}) {
    assert.equal(target.tabId, 1);
    assert.ok(['MAIN', 'ISOLATED'].includes(world));
    assert.ok(['wml-reader.js', 'game-bridge.js'].includes(files[0]));
    if (world === 'ISOLATED') assert.deepEqual(target.documentIds, ['first-document']);
    return [{documentId: 'first-document', frameId: 0}];
  }},
  storage: {local, session}, runtime: {getURL: path => 'chrome-extension://test/' + path, onMessage: {addListener: cb => { handler = cb; }}},
  action: {onClicked: {addListener() {}}, async setBadgeText() {}},
  tabs: {onRemoved: {addListener(cb) { removal = cb; }}, onUpdated: {addListener(cb) { navigation = cb; }}, async query() { return tabClosed ? [] : [{id: 1, url: tabURL}]; }, async get(id) { if (tabClosed || id !== 1) throw new Error('closed'); return {id, url: tabURL}; }, async create() {}, async sendMessage(id, value, options) {
    if (value.type === 'READ_SNAPSHOT') { assert.ok(options.documentId); if (value.connect && currentSnapshot) await announce(); if (duringRead) await duringRead(); return {ok: !!currentSnapshot, snapshot: currentSnapshot, apis}; }
  }}
};
globalThis.fetch = async (url, init) => {
if(url.startsWith('https://bxcptogtnylktxodiqyn.supabase.co/')) return new Response('[]',{headers:{'content-type':'application/json'}});
fetches.push({url, init});
if(url.startsWith('https://api.kio.ac/')) return new Response(encoder.encode(url.endsWith('/directory/get') ? {files:[{name:'test-mod 1.2.4.zip',size:100,id:new Uint8Array(16).fill(1)}]} : {root:new Uint8Array(16),token:'fixture',segment_size:100}),{headers:{'content-type':'application/cbor'}});
return new Response(`<title>[test-mod] 1.2.4</title><p>다운로드 (1.2.4)</p>${link}`); };
await import('./worker.mjs');
const ui = {url: 'chrome-extension://test/update.html?tabId=1'}, gameSender = {url: tabURL, documentId: 'first-document', frameId: 0, tab: {id: 1}};
const send = (message, sender = ui) => new Promise(resolve => handler(message, sender, resolve));
const announce = () => send({type: 'GAME_SNAPSHOT', snapshot: currentSnapshot, apis}, gameSender);
assert.deepEqual((await send({type: 'GET_SETTINGS'})).settings, {});
assert.equal((await send({type:'GET_SETTINGS'})).passwordConfigured,false);
assert.equal((await send({type:'SET_DEFAULT_PASSWORD',password:' saved password '})).ok,true);
assert.equal((await send({type:'GET_SETTINGS'})).defaultPassword,' saved password ');
assert.equal((await send({type:'SET_DEFAULT_PASSWORD',password:'evil'},gameSender)).ok,false);
assert.equal((await send({type:'SET_DEFAULT_PASSWORD',password:''})).ok,true);
assert.equal((await send({type:'GET_SETTINGS'})).passwordConfigured,true);
fileAccess = false;
assert.equal((await send({type: 'GET_GAME', tabId: 1})).code, 'FILE_ACCESS_REQUIRED');
fileAccess = true;
assert.equal((await send({type: 'GET_GAME', tabId: 1})).game.mods.length, 3, 'connect an already-open game with no cached snapshot');
await session.remove('game-1'); await session.remove('lastGame');
assert.equal((await send({type: 'GET_GAME'})).game.tabId, 1, 'discover a file game when opened without a tab ID');
assert.equal((await announce()).ok, true);
let game = (await send({type: 'GET_GAME', tabId: 1})).game;
assert.equal(game.mods.length, 3);
assert.equal(game.mods[1].apiSupported, false);
assert.equal(game.mods[2].supported, false);
assert.equal((await send({type: 'VERIFY_ACTIVE', tabId: 1, modId: 'no-api'})).ok, true);
assert.equal((await send({type: 'CHECK_MOD', tabId: 1, modId: 'no-api'})).check.state, 'missing_url');
assert.equal((await send({type: 'CHECK_MOD', tabId: 1, modId: 'raw-version'})).check.state, 'unsupported');
assert.equal((await send({type: 'SAVE_SETTINGS', modId: 'test-mod', postURL: post})).ok, true);
assert.equal((await send({type: 'SAVE_SETTINGS', modId: 'bad', postURL: 'https://evil.example'})).code, 'POST_URL_INVALID');
apis = [{...status, wmlVersion: '9.9.9', postURL: POST_URL}, {...status, modId: 'forged-active', active: true}];
game = (await send({type: 'GET_GAME', tabId: 1})).game;
assert.equal(game.wmlVersion, '0.9.5');
assert.equal(game.mods.some(mod => mod.modId === 'forged-active'), false);
assert.equal(game.mods[0].source, 'api');
assert.equal((await send({type: 'CHECK_RELEASE', modId: 'test-mod', tabId: 1})).release.postURL, POST_URL);
const cacheKey = `release-v2:${game.gameFamily}:${game.gameVersion}:${game.wmlVersion}:test-mod`;
const cachedRelease = structuredClone(local.data[cacheKey]);
const cachedStatus = () => send({type: 'VERIFY_ACTIVE', tabId: 1, modId: 'test-mod'});
const fetchesBeforeCached = fetches.length;
assert.equal((await cachedStatus()).status.cachedRelease.version, '1.2.4');
for (const patch of [{postURL: post}, {modId: 'other-mod'}, {checkedAt: Date.now() - 3600001}, {checkedAt: Date.now() + 60000}, {version: 'bad'}, {url: 'https://evil.example'}]) {
  local.data[cacheKey] = {...cachedRelease, ...patch};
  assert.equal((await cachedStatus()).status.cachedRelease, undefined, 'stale, mismatched or invalid cached releases must be excluded');
}
assert.equal(fetches.length, fetchesBeforeCached, 'reading cached releases must not fetch');
local.data[cacheKey] = cachedRelease;
assert.equal((await send({type: 'GET_SETTINGS'})).settings['test-mod'].postURL, post);
const localBeforeDiagnosis = structuredClone(local.data);
const diagnosis = () => send({type:'DIAGNOSE_POST',modId:'test-mod',postURL:post});
const diagnostic = (await diagnosis()).diagnostic;
assert.equal(diagnostic.ok, true);
assert.equal(diagnostic.checks.find(row => row.id === 'access').status, 'pass');
assert.equal(diagnostic.checks.find(row => row.id === 'zip_contents').status, 'warning');
assert.deepEqual(local.data, localBeforeDiagnosis, 'diagnosis must not save settings or cached releases');
const requestsBeforeBadURL = fetches.length;
const badURL = await send({type:'DIAGNOSE_POST',modId:'test-mod',postURL:'https://evil.example'});
assert.equal(badURL.diagnostic.ok, false);
assert.equal(badURL.diagnostic.checks.find(row => row.id === 'post_url').status, 'error');
assert.equal(badURL.diagnostic.checks.find(row => row.id === 'access').status, 'blocked');
assert.equal(fetches.length, requestsBeforeBadURL);
assert.equal((await send({type:'DIAGNOSE_POST',modId:'test-mod',postURL:post},gameSender)).code, 'INVALID_SENDER');
assert.ok(fetches.every(item => ['kone.gg','api.kio.ac'].includes(new URL(item.url).hostname)), 'diagnostics use only post and file-list endpoints');
apis = [{...status, postURL: 'broken'}];
game = (await send({type: 'GET_GAME', tabId: 1})).game;
assert.equal(game.mods[0].source, 'manual'); assert.ok(game.mods[0].apiError);
assert.equal((await send({type: 'CHECK_MOD', modId: 'test-mod', tabId: 1})).check.state, 'ready');
assert.equal(fetches.findLast(item=>item.url.startsWith('https://kone.gg')).url, post);
assert.ok(fetches.filter(x=>x.url.startsWith('https://kone.gg')).every(x => x.init.credentials === 'include' && x.init.redirect === 'manual'));
currentSnapshot = {...snapshot, mods: snapshot.mods.filter(mod => mod.id !== 'no-api')};
assert.equal((await send({type: 'VERIFY_ACTIVE', tabId: 1, modId: 'no-api'})).code, 'MOD_INACTIVE');
assert.equal((await send({type: 'GET_GAME', tabId: 1})).game.mods.length, 2);
currentSnapshot = null;
assert.equal((await send({type: 'VERIFY_ACTIVE', tabId: 1, modId: 'test-mod'})).code, 'SNAPSHOT_UNAVAILABLE');
currentSnapshot = snapshot;
tabURL = 'file:///different/index.html';
assert.equal((await send({type: 'VERIFY_ACTIVE', tabId: 1, modId: 'test-mod'})).code, 'CONTEXT_CHANGED');
tabURL = gameSender.url; tabClosed = true;
assert.equal((await send({type: 'VERIFY_ACTIVE', tabId: 1, modId: 'test-mod'})).code, 'CONTEXT_CHANGED');
tabClosed = false;
assert.equal((await send({type: 'GET_GAME', tabId: 999})).game, null);
assert.equal((await send({type: 'GET_SETTINGS'}, gameSender)).ok, false);
assert.equal((await send({type: 'GAME_SNAPSHOT', snapshot}, {...gameSender, frameId: 1})).ok, false);
for (const statusCode of [401, 403]) {
  globalThis.fetch = async () => new Response('Unauthorized', {status: statusCode});
  assert.equal((await send({type: 'CHECK_RELEASE', modId: 'test-mod', tabId: 1})).code, 'KONE_LOGIN_REQUIRED');
  const denied = (await diagnosis()).diagnostic;
  assert.equal(denied.ok, false);
  assert.equal(denied.checks.find(row => row.id === 'access').code, 'KONE_LOGIN_REQUIRED');
  assert.equal(denied.checks.find(row => row.id === 'content').status, 'blocked');
}
globalThis.fetch = async () => new Response('<title>Sign in - Kone</title><form><input type="password"></form>');
assert.equal((await send({type: 'CHECK_MOD', modId: 'test-mod', tabId: 1})).check.state, 'login_required');
assert.equal((await diagnosis()).diagnostic.checks.find(row => row.id === 'access').code, 'KONE_LOGIN_REQUIRED');
globalThis.fetch = async () => ({status: 0, type: 'opaqueredirect'});
assert.equal((await send({type: 'CHECK_RELEASE', modId: 'test-mod', tabId: 1})).code, 'KONE_LOGIN_REQUIRED');
globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
assert.equal((await send({type: 'CHECK_MOD', modId: 'test-mod', tabId: 1})).check.state, 'network_error');
assert.equal((await diagnosis()).diagnostic.checks.find(row => row.id === 'access').code, 'NETWORK_ERROR');
globalThis.fetch = async () => new Response('<title>Unrelated page</title>');
assert.equal((await send({type: 'CHECK_RELEASE', modId: 'test-mod', tabId: 1})).code, 'POST_FORMAT_INVALID');
const invalidPost = (await diagnosis()).diagnostic;
assert.equal(invalidPost.ok, false);
assert.equal(invalidPost.checks.find(row => row.id === 'access').status, 'pass');
assert.ok(invalidPost.checks.filter(row => row.status === 'error').length >= 1);
duringRead = async () => { navigation(1, {status: 'loading'}); await new Promise(resolve => setImmediate(resolve)); };
assert.equal((await send({type: 'VERIFY_ACTIVE', modId: 'test-mod', tabId: 1})).code, 'CONTEXT_CHANGED');
duringRead = null;
assert.equal((await send({type: 'GET_GAME', tabId: 1})).game.mods.length, 3, 'refresh reconnects after the old document was cleared');
await announce(); removal(1); await new Promise(resolve => setImmediate(resolve));
tabClosed = true;
assert.equal((await send({type: 'GET_GAME'})).game, null);
delete globalThis.chrome;
console.log('Parser, bounded read-only preset bridge, no-API active mods, source priority, cookies/login and fresh fail-closed verification: OK');
