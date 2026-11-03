import assert from 'node:assert/strict';
import {Encoder} from './vendor/cbor-x-1.6.4.mjs';
const encoder=new Encoder({useRecords:false,tagUint8Array:false});
import {POST_URL} from './core.mjs';
const storage = () => {
  const data = {};
  return {data, async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in data).map(key => [key, structuredClone(data[key])])); }, async set(values) { Object.assign(data, structuredClone(values)); }, async remove(key) { delete data[key]; }};
};
const local = storage(), session = storage(), opened = [], activated = [], notices = [], focused = [], broadcasts = [], fetched = [];
let handler, navigate, documentId = 'first', deny = false, invalid = false, pauseFetch;
const gameURL = 'file:///isolated/game.html', uiURL = 'chrome-extension://test/update.html';
globalThis.chrome = {
  storage: {local, session},
  runtime: {getURL: file => 'chrome-extension://test/' + file, onMessage: {addListener(fn) { handler = fn; }}, async sendMessage(message) { broadcasts.push(message); }},
  windows: {async update(id, values) { focused.push({id, ...values}); }},
  action: {onClicked: {addListener() {}}, async setBadgeText() {}},
  tabs: {
    onRemoved: {addListener() {}}, onUpdated: {addListener(fn) { navigate = fn; }},
    async get(id) { return {id, url: gameURL}; }, async query() { return opened; },
    async create(tab) { const created = {...tab, id: opened.length + 10, windowId: 5}; opened.push(created); return created; },
    async update(id, values) { activated.push({id, ...values}); return {...opened.find(tab => tab.id === id), ...values}; },
    async sendMessage(id, message) { notices.push(message); }
  }
};
const post2 = POST_URL.replace('d7dNsfio5zS0D3neJOhkeb', 'abcdefghijklmnopqrstuv');
globalThis.fetch = async url => {
  if(url.startsWith('https://api.kio.ac/')) return new Response(encoder.encode(url.endsWith('/directory/get') ? {files:['first-mod','second-mod'].map(id=>({name:id+' 1.1.0.zip',size:100,id:new Uint8Array(16)}))} : {root:new Uint8Array(16),token:'fixture',segment_size:100}),{headers:{'content-type':'application/cbor'}});
  fetched.push(url);
  if (pauseFetch) await pauseFetch;
  if (deny) return new Response('Unauthorized', {status: 403});
  if (invalid) return new Response('<title>Missing collection link</title>');
  return new Response(`<title>[${url === POST_URL ? 'first-mod' : 'second-mod'}] 1.1.0</title><p>다운로드 (1.1.0)</p>https://kio.ac/c/abcdefghijklmnopqrstuv`);
};
await import('./worker.mjs');
const send = message => new Promise(resolve => handler(message, {url: gameURL, documentId, frameId: 0, tab: {id: 1}}, resolve));
const snapshot = {wmlVersion: '0.9.4', gameVersion: '2026-11-01', mods: [{id: 'first-mod', version: '1.0.0'}, {id: 'second-mod', version: '1.0.0'}]};
const apis = [{modId: 'first-mod', protocol: 2, active: true, postURL: POST_URL}, {modId: 'second-mod', protocol: 2, active: true, postURL: post2}];
const announce = (metadata = apis) => send({type: 'GAME_SNAPSHOT', snapshot, apis: metadata});
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
async function waitFor(check) { for (let i = 0; i < 100; i++) { if (check()) return; await tick(); } assert.ok(check(), 'notification did not complete'); }
async function nextDocument() { navigate(1, {status: 'loading'}); await tick(); documentId += '-next'; }

for (const api of apis) local.data['release-' + api.modId] = {modId: api.modId, version: '1.0.0', url: 'https://kio.ac/c/abcdefghijklmnopqrstuv', postURL: api.postURL, checkedAt: Date.now()};
let finishInitial; pauseFetch = new Promise(resolve => { finishInitial = resolve; });
await Promise.all([announce(), announce(), announce()]);
await waitFor(() => fetched.length === 2);
session.data['game-1'].seenAt += 100;
finishInitial(); pauseFetch = undefined;
await waitFor(() => opened.length === 1);
assert.equal(fetched.length, 2, 'startup bypasses the old one-hour cache but coalesces repeated snapshots');
assert.equal(focused[0].focused, true, 'the browser window must become visible');
assert.equal(new URL(opened[0].url).pathname, '/update.html');
assert.equal(new URL(opened[0].url).searchParams.get('tabId'), '1');
await announce(); await tick();
assert.equal(opened.length, 1, 'only one updater tab for several mods and repeated snapshots');
assert.equal(activated.length, 0, 'repeated polls must not repeatedly focus the UI');

await nextDocument(); await announce();
await waitFor(() => activated.length === 1);
assert.equal(opened.length, 1, 'reuse the existing updater after a new game document starts');
assert.equal(opened[0].url.split('?')[0], uiURL);
assert.equal(focused.length, 2, 'an existing updater in another window is focused');
assert.deepEqual(broadcasts.at(-1), {type: 'UPDATES_AVAILABLE', tabId: 1}, 'reuse refreshes the visible update list without a reload');

await nextDocument(); await announce([]); await tick();
assert.equal(activated.length, 1, 'no URL must not open an updater');
await session.remove('opened-update-1');
await local.remove('release-first-mod'); await local.remove('release-second-mod');
deny = true; await announce(); await tick();
assert.equal(activated.length, 1, 'login failure must not open an updater');

deny = false; invalid = true;
await nextDocument(); await announce(); await tick();
assert.equal(activated.length, 1, 'a missing collection must not open an updater');
invalid = false;
await nextDocument();

let resume; pauseFetch = new Promise(resolve => { resume = resolve; });
await announce(); await tick();
await nextDocument(); resume(); await tick();
assert.equal(activated.length, 1, 'a release result for an old game document must not open an updater');
assert.equal(opened.length, 1);
delete globalThis.chrome;
console.log('Startup update screen: coalesced newer mods, one open per document, existing-tab reuse, no URL/login/stale-document suppression: OK');
