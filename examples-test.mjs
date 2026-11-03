import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {validateStatus} from './core.mjs';
const source = fs.readFileSync(new URL('examples/bridge.js', import.meta.url), 'utf8');
const listeners = new Set(), messages = [];
const window = {
  WML: {currentPreset: () => ({mods: [{id:'my-mod'}, {id:'another-mod'}]})},
  addEventListener: (_, fn) => listeners.add(fn),
  removeEventListener: (_, fn) => listeners.delete(fn),
  postMessage: data => messages.push(data),
};
const run = id => vm.runInNewContext(`(() => {${source}\n})()`, {window, api: {
  id, wml: '0.9.5', game: '2026-11-01',
  get store() {throw Error('must not read saves');},
}});
run('my-mod'); run('my-mod'); run('another-mod');
assert.equal(listeners.size, 2);
const emit = (data, source = window) => [...listeners].forEach(fn => fn({data,source}));
emit({type:'WML_MOD_UPDATER_QUERY', requestId:'test-123'});
assert.deepEqual(messages.map(m => m.modId), ['my-mod','another-mod']);
for (const status of messages) assert.ok(validateStatus(status));
emit({type:'WML_MOD_UPDATER_QUERY', requestId:'test-123', command:'install'});
emit({type:'WML_MOD_UPDATER_QUERY', requestId:'test-123'}, {});
emit({type:'WML_MOD_UPDATER_QUERY', requestId:'<bad>'});
assert.equal(messages.length, 2);
window.WML.currentPreset = () => ({mods: [{id:'another-mod'}]});
emit({type:'WML_MOD_UPDATER_QUERY', requestId:'test-disabled'});
assert.equal(messages[2].active, false);
assert.equal(messages[3].active, true);
window.WML.currentPreset = () => {throw Error('unavailable');};
emit({type:'WML_MOD_UPDATER_QUERY', requestId:'test-fail-closed'});
assert.equal(messages[4].active, false);
assert.equal(messages[5].active, false);
console.log('Guide bridge example: multiple mods, duplicate setup and invalid requests passed');
