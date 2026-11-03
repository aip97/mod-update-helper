import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeZip } from './zip-tools.mjs';
import { inspectPackage, inspectGameDirectory, applyUpdate, compareVersions, evaluateCompatibility, listBackups, restoreBackup, readModMetadata } from './installer.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const prefix = 'wml/mods/attention-image-prompt/';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aip-updater-zip-'));
const originalZip = zip([
 {name:prefix+'mod.js',data:Buffer.from("WML.define({id:'attention-image-prompt',version:'1.82.2',game:'>=2026-10-04',setup(){}});")},
 ...['README_USER.md','INTRO_EN.html',...Array.from({length:13},(_,i)=>'lib/part'+i+'.js')].map(name=>({name:prefix+name,data:Buffer.from('fixture '+name)}))
]);
const parsed = await inspectPackage(originalZip, '1.82.2');
assert.equal(parsed.files.length, 16);
assert.equal(compareVersions('1.9.9', '1.10.0'), -1);
assert.throws(() => compareVersions('1.82.2-beta', '1.82.2'));
await assert.rejects(inspectPackage(originalZip, '1.82.3'), /버전/);
await assert.rejects(inspectPackage(new Uint8Array([0]), '1.82.2'), /크기/);

function zip(entries) {
  const filename = path.join(tmp, 'test.zip'); writeZip(filename, entries); return fs.readFileSync(filename);
}
const entries = parsed.files.map(f => ({ name: f.path, data: Buffer.from(f.data) }));
await assert.rejects(inspectPackage(zip([...entries, { name: '../evil.js', data: Buffer.from('bad') }]), '1.82.2'), /경로/);
await assert.rejects(inspectPackage(zip([...entries, entries[0]]), '1.82.2'), /중복/);
await assert.rejects(inspectPackage(zip(entries.filter(f => f.name !== prefix + 'mod.js')), '1.82.2'), /누락/);
await assert.rejects(inspectPackage(zip([...entries, { name: 'wayward-imagegen/src/cli.js', data: Buffer.from('bad') }]), '1.82.2'), /경로/);
const damaged = zip(entries); damaged[30 + Buffer.byteLength(entries[0].name)] ^= 255;
await assert.rejects(inspectPackage(damaged, '1.82.2'));
const badCRC = zip(entries); badCRC.writeUInt32LE(1234, 14);
await assert.rejects(inspectPackage(badCRC, '1.82.2'), /정보/);
const badDirectory = zip([{ name: 'wml/', dir: true }, ...entries]); badDirectory.writeUInt16LE(1, 6);
await assert.rejects(inspectPackage(badDirectory, '1.82.2'));

const bytes = text => new TextEncoder().encode(text);
const text = data => new TextDecoder().decode(data);
function fakeGame() {
  const store = new Map([
    [prefix + 'mod.js', bytes("WML.define({\n id: 'attention-image-prompt',\n version: '1.82.1',\n game: '>=2026-10-04',\n setup(api) {}\n});")],
    ['wml/runtime/wml-core.js', bytes("const VERSION = '0.9.5';")],
    ['Wayward_WML_ko.html', bytes('<script src="wml/runtime/wml-core.js"></script><script src="wml/symbols/2026-11-01.js"></script>/* WML_BRIDGE_BEGIN 2026-11-01 */')],
    [prefix + 'README_USER.md', bytes('old readme')],
    [prefix + 'settings.json', bytes('{"private":"keep"}')],
    ['images/custom.png', bytes('keep image')],
  ]);
  const dirs = new Set(['']);
  for (const f of store.keys()) { const parts = f.split('/'); parts.pop(); while (parts.length) { dirs.add(parts.join('/')); parts.pop(); } }
  const config = { fail: null, restoreMissing: null, failBackup: false, failures: 0, writes: [] };
  const notFound = () => Object.assign(new Error('Not found'), { name: 'NotFoundError' });
  function directory(p) {
    const key = n => p ? p + '/' + n : n;
    return {
      kind: 'directory', name: p.split('/').pop(),
      async getDirectoryHandle(n, { create = false } = {}) { const q = key(n); if (!dirs.has(q) && !create) throw notFound(); dirs.add(q); return directory(q); },
      async getFileHandle(n, { create = false } = {}) {
        const q = key(n); if (!store.has(q)) { if (!create) throw notFound(); store.set(q, new Uint8Array()); }
        return {
          kind: 'file', name: n,
          async getFile() { return new Blob([store.get(q)]); },
          async createWritable() {
            let data;
            return {
              async write(input) { data = input instanceof Uint8Array ? new Uint8Array(input) : bytes(input); },
              async close() {
                if (config.failures && q === config.restoreMissing) throw notFound();
                store.set(q, data); config.writes.push(q);
                if (config.failures && q === config.corruptRecovery) store.set(q, bytes('silently corrupted recovery'));
                if (config.changeRuntimeOnBackup && q.startsWith('.wml-mod-updater-backups/')) store.set('wml/runtime/wml-core.js', bytes("const VERSION = '0.9.4';"));
                if (config.changeHTMLOnBackup && q.startsWith('.wml-mod-updater-backups/')) store.set(config.changeHTMLOnBackup.path, bytes(config.changeHTMLOnBackup.html));
                if ((q === config.fail || (config.failBackup && q.startsWith('.wml-mod-updater-backups/'))) && !config.failures++) throw new Error('Injected write failure');
              },
              async abort() {},
            };
          },
        };
      },
      async removeEntry(n) { const q = key(n); if (!store.delete(q)) throw notFound(); },
      async *values() {
        for (const d of dirs) if (d && d.startsWith(p ? p + '/' : '') && !d.slice(p ? p.length + 1 : 0).includes('/')) yield directory(d);
        for (const f of store.keys()) if (f.startsWith(p ? p + '/' : '') && !f.slice(p ? p.length + 1 : 0).includes('/')) yield await this.getFileHandle(f.split('/').pop());
      },
    };
  }
  return { root: directory(''), store, config };
}
const a = fakeGame();
assert.deepEqual(await inspectGameDirectory(a.root), { modVersion: '1.82.1', wmlVersion: '0.9.5', gameVersion: '2026-11-01', gameFamily:'wayward', gameFile:'Wayward_WML_ko.html', htmlVersion:'2026-11-01', gameSpec:'>=2026-10-04', supportedWml:null });
const installed = await applyUpdate(a.root, originalZip, { expectedVersion: '1.82.2', allowUnknownWml: true, expectedInstalledVersion: '1.82.1' });
assert.equal(installed.filesWritten, 16);
assert.equal((await inspectGameDirectory(a.root)).modVersion, '1.82.2');
assert.equal(text(a.store.get(prefix + 'settings.json')), '{"private":"keep"}');
assert.equal(text(a.store.get('images/custom.png')), 'keep image');
assert.equal(text(a.store.get(installed.backupPath + '/' + prefix + 'README_USER.md')), 'old readme');
assert.equal(a.config.writes.filter(x => !x.startsWith('.wml-mod-updater-backups/')).at(-1), prefix + 'mod.js');
await assert.rejects(applyUpdate(a.root, originalZip, { expectedVersion: '1.82.2', allowUnknownWml: true, expectedInstalledVersion: '1.82.2' }), /같거나 이전/);

const b = fakeGame(), before = new Map([...b.store].map(([k, v]) => [k, v.slice()]));
b.config.fail = prefix + 'INTRO_EN.html';
await assert.rejects(applyUpdate(b.root, originalZip, { expectedVersion: '1.82.2', allowUnknownWml: true, expectedInstalledVersion: '1.82.1' }), /이전 상태로 복원/);
assert.deepEqual(new Map([...b.store].filter(([k]) => !k.startsWith('.wml-mod-updater-backups/'))), before);
const c = fakeGame(); c.config.failBackup = true;
await assert.rejects(applyUpdate(c.root, originalZip, { expectedVersion: '1.82.2', allowUnknownWml: true, expectedInstalledVersion: '1.82.1' }), /Injected/);
assert.equal(c.config.writes.filter(x => !x.startsWith('.wml-mod-updater-backups/')).length, 0);
const d = fakeGame();
await assert.rejects(applyUpdate(d.root, originalZip, { expectedVersion: '1.82.2', allowUnknownWml: true, expectedInstalledVersion: '1.80.0' }), /버전이 변경/);
assert.equal(d.config.writes.length, 0);
const e = fakeGame(); e.config.fail = prefix + 'INTRO_EN.html'; e.config.restoreMissing = prefix + 'README_USER.md';
await assert.rejects(applyUpdate(e.root, originalZip, { expectedVersion: '1.82.2', allowUnknownWml: true, expectedInstalledVersion: '1.82.1' }), /일부 파일을 복원하지 못했습니다: wml\/mods\/attention-image-prompt\/README_USER.md/);
assert.equal(path.dirname(path.resolve(tmp)), path.resolve(os.tmpdir()));
const modId = 'another-mod', otherPrefix = `wml/mods/${modId}/`;
const header = (version = '1.2.0') => `/* WML.define({id:'fake'}) */\nWML.define({ 'id': '${modId}', name: {ko: '테스트', en: 'Test'}, "version": '${version}', game: '>=2026-10-04', setup(api) {} });`;
const genericEntries = [
  {name: otherPrefix + 'mod.js', data: Buffer.from(header())},
  ...['lib/helper.js', 'data/events.json', 'styles/main.css', 'docs/readme.md', 'assets/icon.png'].map(name => ({name: otherPrefix + name, data: Buffer.from('new asset')})),
];
const genericZip = zip(genericEntries);
for (const setup of ['async setup(api) {}','async /* loader callback */ setup(api) {}','setup: async (api) => {}']) {
  const source=header().replace('setup(api) {}',setup);
  assert.equal((await inspectPackage(zip([{name:'mod.js',data:Buffer.from(source)}]),'1.2.0',modId)).version,'1.2.0');
}
const archiveRoots = ['', `${modId}/`, 'mods/', `mods/${modId}/`, 'wml/mods/', otherPrefix];
const layoutEntries = root => genericEntries.map(entry => ({ ...entry, name: root + entry.name.slice(otherPrefix.length) }));
const updateOptions = { modId, expectedVersion: '1.2.0', expectedInstalledVersion: '1.1.0', allowUnknownWml: true };
async function genericGame() {
  const game = fakeGame();
  await game.root.getDirectoryHandle('wml').then(d => d.getDirectoryHandle('mods')).then(d => d.getDirectoryHandle(modId, { create: true }));
  game.store.set(otherPrefix + 'mod.js', bytes(header('1.1.0')));
  return game;
}
const packPath='image-packs/maker-character/mods/another-mod/';
const packedEntries=[...genericEntries,...Array.from({length:320},(_,i)=>({name:packPath+`images/${i}.webp`,data:Buffer.from('image fixture '+i)})),{name:packPath+'pack.js',data:Buffer.from('const pack = {};')}];
const wrapped=zip(packedEntries.map(item=>({...item,name:('Game_Folder/'+item.name).replaceAll('/','\\')})));
assert.equal((await inspectPackage(wrapped,'1.2.0',modId)).files.length,327);
for (const fail of [false,true]) {
  const fixture=await genericGame();
  let folder=fixture.root;for(const part of (packPath+'images').split('/').filter(Boolean)) folder=await folder.getDirectoryHandle(part,{create:true});
  fixture.store.set(packPath+'images/0.webp',bytes('original image'));
  const before=new Map(fixture.store);
  if(fail) {
    fixture.config.fail=packPath+'images/2.webp';
    await assert.rejects(applyUpdate(fixture.root,wrapped,updateOptions),/이전 상태로 복원/);
  } else {
    const applied=await applyUpdate(fixture.root,wrapped,updateOptions);
    assert.equal(text(fixture.store.get(packPath+'images/0.webp')),'image fixture 0');
    await restoreBackup(fixture.root,applied.backupPath,{modId,expectedInstalledVersion:'1.2.0',allowUnknownWml:true});
  }
  assert.deepEqual(new Map([...fixture.store].filter(([p])=>!p.startsWith('.wml-mod-updater-backups/'))),before);
}
for(const unsafe of ['Game_Folder/image-packs/p/run.cmd','Game_Folder/image-packs/p/../out.png','Game_Folder/wml/runtime/wml-core.js']) {
  await assert.rejects(inspectPackage(zip([...packedEntries.map(item=>({...item,name:'Game_Folder/'+item.name})),{name:unsafe,data:Buffer.from('bad')}]),'1.2.0',modId),/경로/);
}
await assert.rejects(inspectPackage(zip([{name:'mods/mod.js',data:Buffer.from(header())},{name:'mods\\mod.js',data:Buffer.from(header())}]),'1.2.0',modId),/중복/);
for (const root of archiveRoots) {
  const sourceEntries = layoutEntries(root);
  const directories = [...new Set(sourceEntries.flatMap(entry => {
    const parts = entry.name.split('/'); parts.pop();
    return parts.map((_, i) => parts.slice(0, i + 1).join('/') + '/');
  }))].map(name => ({ name, dir: true }));
  const fixture = zip([...directories, ...sourceEntries]);
  const pkg = await inspectPackage(fixture, '1.2.0', modId);
  assert.equal(pkg.archiveRoot, root);
  assert.deepEqual(pkg.files.map(file => file.path), genericEntries.map(entry => entry.name));
  const game = await genericGame(), snapshot = new Map(game.store);
  const result = await applyUpdate(game.root, fixture, updateOptions);
  assert.ok(game.config.writes.every(p => p.startsWith(otherPrefix) || p.startsWith('.wml-mod-updater-backups/')));
  const manifest = JSON.parse(text(game.store.get(result.backupPath + '/manifest.json')));
  assert.deepEqual(manifest.files.map(file => file.path), genericEntries.map(entry => entry.name));
  await restoreBackup(game.root, result.backupPath, { modId, allowUnknownWml:true, expectedInstalledVersion: '1.2.0' });
  assert.deepEqual(new Map([...game.store].filter(([p]) => !p.startsWith('.wml-mod-updater-backups/'))), snapshot);
  const failed = await genericGame(), beforeFailure = new Map(failed.store);
  failed.config.fail = otherPrefix + 'styles/main.css';
  await assert.rejects(applyUpdate(failed.root, fixture, updateOptions), /이전 상태로 복원/);
  assert.deepEqual(new Map([...failed.store].filter(([p]) => !p.startsWith('.wml-mod-updater-backups/'))), beforeFailure);
  for (const source of [header('1.3.0'), header().replace("'another-mod'", "'wrong-mod'")]) {
    const wrong = zip(sourceEntries.map(entry => entry.name === root + 'mod.js' ? { ...entry, data: Buffer.from(source) } : entry));
    const rejected = await genericGame(), before = new Map(rejected.store);
    await assert.rejects(applyUpdate(rejected.root, wrong, updateOptions), /ID|버전/);
    assert.deepEqual(rejected.config.writes, []);
    assert.deepEqual(rejected.store, before);
  }
}
for (const id of ['mods', 'wml']) {
  for (const root of new Set(['', `${id}/`, 'mods/', `mods/${id}/`, 'wml/mods/', `wml/mods/${id}/`])) {
    assert.equal((await inspectPackage(zip([{ name: root + 'mod.js', data: Buffer.from(header().replaceAll(modId, id)) }]), '1.2.0', id)).archiveRoot, root);
  }
}
const rejectedLayouts = [
  ...['../mod.js', '/mod.js', 'C:/mod.js', 'mods//mod.js', 'mods/./mod.js', 'mods/../mod.js', 'wrapper/mod.js', 'renamed.js'].map(name => [{ name, data: Buffer.from(header()) }]),
  [...layoutEntries(''), { name: 'MOD.js', data: Buffer.from(header()) }],
  [...layoutEntries(''), { name: 'lib/HELPER.js', data: Buffer.from('duplicate') }],
  [...layoutEntries(''), { name: 'LIB/extra.js', data: Buffer.from('case collision') }],
  [...layoutEntries(''), { name: 'assets/', dir: true }, { name: 'ASSETS/', dir: true }],
  [...layoutEntries(''), { name: 'settings.json', data: Buffer.from('private') }],
  [...layoutEntries(''), { name: 'lib/mod.js', data: Buffer.from(header().replaceAll(modId, 'other-mod')) }],
  [...layoutEntries(''), { name: 'lib/MOD.js', data: Buffer.from(header().replaceAll(modId, 'other-mod')) }],
  [...layoutEntries(''), { name: 'wml/mods/other-mod/mod.js', data: Buffer.from(header().replaceAll(modId, 'other-mod')) }],
  [...layoutEntries('mods/'), { name: 'README.md', data: Buffer.from('outside') }],
  [...layoutEntries('mods/'), { name: 'other/', dir: true }],
  [...layoutEntries(otherPrefix), { name: 'wml/mods/other-mod/readme.md', data: Buffer.from('other mod') }],
];
for (let i = 0; i < archiveRoots.length; i++) {
  for (let j = i + 1; j < archiveRoots.length; j++) rejectedLayouts.push([
    { name: archiveRoots[i] + 'mod.js', data: Buffer.from(header()) },
    { name: archiveRoots[j] + 'mod.js', data: Buffer.from(header()) },
  ]);
}
for (const badEntries of rejectedLayouts) {
  const game = await genericGame(), before = new Map(game.store);
  await assert.rejects(applyUpdate(game.root, zip(badEntries), updateOptions));
  assert.deepEqual(game.config.writes, []);
  assert.deepEqual(game.store, before);
}
// A nested helper named mod.js is fine when it does not define another WML package.
assert.equal((await inspectPackage(zip([...layoutEntries(''), { name: 'lib/mod.js', data: Buffer.from('export const helper = true;') }]), '1.2.0', modId)).files.length, 7);
for (const id of ['another_mod', 'my.mod']) {
  const fixture = zip([{name: `wml/mods/${id}/mod.js`, data: Buffer.from(header().replaceAll(modId, id))}]);
  assert.equal((await inspectPackage(fixture, '1.2.0', id)).version, '1.2.0');
}
for (const id of ['con', 'aux.mod', 'trailing.', 'com0', 'lpt9.js', '.hidden', 'com\u00b9']) {
  await assert.rejects(inspectPackage(genericZip, '1.2.0', id), /ID/);
}
assert.equal((await inspectPackage(genericZip, '1.2.0', modId)).files.length, 6);
await assert.rejects(inspectPackage(zip([...genericEntries, {name: otherPrefix + 'mod.js/extra.js', data: Buffer.from('bad')}]), '1.2.0', modId), /충돌/);
const symlink = zip(genericEntries), central = symlink.readUInt32LE(symlink.length - 6);
symlink.writeUInt32LE((0xa000 << 16) >>> 0, central + 38);
await assert.rejects(inspectPackage(symlink, '1.2.0', modId), /링크/);
await assert.rejects(inspectPackage(genericZip, '1.2.0'), /경로/);
await assert.rejects(inspectPackage(genericZip, '1.2.0', '../evil'), /ID/);
for (const name of ['../evil.js', 'images/custom.png', 'CACHE/x.json', 'saves/game.json', 'config.json', 'settings.json', '.git/config', 'CON.txt', 'com1.json', 'file.js:evil', 'bad./a.js', 'run.cmd', 'run.ps1', 'run.exe']) {
  await assert.rejects(inspectPackage(zip([...genericEntries, {name: otherPrefix + name, data: Buffer.from('bad')}]), '1.2.0', modId), /경로/);
}
for (const source of [header().replace("'another-mod'", "'wrong-mod'"), header().replace("game: '>=2026-10-04'", "version: '1.2.0', game: '>=2026-10-04'"), header().replace("'1.2.0'", "getVersion()"), "// WML.define({id:'another-mod',version:'1.2.0',game:'>=2026-10-04'})\nalert('bad')"]) {
  await assert.rejects(inspectPackage(zip([{name: otherPrefix + 'mod.js', data: Buffer.from(source)}]), '1.2.0', modId));
}
const generic = fakeGame();
await generic.root.getDirectoryHandle('wml').then(d => d.getDirectoryHandle('mods')).then(d => d.getDirectoryHandle(modId, {create:true}));
generic.store.set(otherPrefix + 'mod.js', bytes(header('1.1.0')));
assert.deepEqual(await readModMetadata(generic.root, modId), {modVersion:'1.1.0',gameFamily:'wayward',gameSpec:'>=2026-10-04',supportedWml:null,modName:'Test',modNameKo:'테스트',modNameEn:'Test'});
for (const [name, expected] of [
  ["'Original name'", {modName:'Original name'}],
  [String.raw`{ko:'한국어 이름',en:'Owner\'s "mod"'}`, {modName:`Owner's "mod"`,modNameKo:'한국어 이름',modNameEn:`Owner's "mod"`}],
  [String.raw`{ko:'\uD14C\uC2A4\uD2B8',en:'Test'}`, {modName:'Test',modNameKo:'테스트',modNameEn:'Test'}],
]) {
  generic.store.set(otherPrefix + 'mod.js', bytes(header('1.1.0').replace("{ko: '테스트', en: 'Test'}", name)));
  const metadata = await readModMetadata(generic.root, modId);
  assert.deepEqual(Object.fromEntries(Object.entries(metadata).filter(([key]) => key.startsWith('modName'))), expected);
}
generic.store.set(otherPrefix + 'mod.js', bytes(header('1.1.0')));
const aipBefore = generic.store.get(prefix + 'mod.js').slice();
const genericResult = await applyUpdate(generic.root, genericZip, {modId, expectedVersion:'1.2.0', allowUnknownWml: true, expectedInstalledVersion:'1.1.0'});
assert.ok(genericResult.backupPath.startsWith('.wml-mod-updater-backups/another-mod/'));
assert.equal((await inspectGameDirectory(generic.root, modId)).modVersion, '1.2.0');
assert.deepEqual(generic.store.get(prefix + 'mod.js'), aipBefore);
generic.store.set(otherPrefix + 'mod.js', bytes(header('1.1.0')));
const genericBefore = new Map([...generic.store].filter(([k]) => !k.startsWith('.wml-mod-updater-backups/')));
generic.config.fail = otherPrefix + 'styles/main.css';
await assert.rejects(applyUpdate(generic.root, genericZip, {modId, expectedVersion:'1.2.0', allowUnknownWml: true, expectedInstalledVersion:'1.1.0'}), /이전 상태로 복원/);
assert.deepEqual(new Map([...generic.store].filter(([k]) => !k.startsWith('.wml-mod-updater-backups/'))), genericBefore);
assert.ok(path.basename(tmp).startsWith('aip-updater-zip-'));
const declaredZip = declaration => zip(entries.map(entry => entry.name === prefix + 'mod.js' ? { ...entry, data: Buffer.from(entry.data.toString().replace(/WML\s*\.\s*define\s*\(\s*\{/, `WML.define({ wml: ${declaration},`)) } : entry));
for (const declaration of ["'0.9.5'", "['0.9.4', '0.9.5']"]) {
  const pkg = await inspectPackage(declaredZip(declaration), '1.82.2');
  assert.equal(evaluateCompatibility(pkg, '0.9.5').state, 'supported');
}
for (const declaration of ["'>=0.9.5'", "'0.09.5'", '[]', "['0.9.5', '0.9.5']", '[null]', 'null', '5', "{version:'0.9.5'}", "['0.9.5', ['0.9.4']]"]) {
  await assert.rejects(inspectPackage(declaredZip(declaration), '1.82.2'));
}
assert.equal(parsed.supportedWml, null);
const unknown = fakeGame();
await assert.rejects(applyUpdate(unknown.root, originalZip, {expectedVersion:'1.82.2', expectedInstalledVersion:'1.82.1'}), {code:'WML_COMPAT_UNKNOWN'});
assert.equal(unknown.config.writes.length, 0);
const incompatible = fakeGame();
await assert.rejects(applyUpdate(incompatible.root, declaredZip("'0.9.4'"), {expectedVersion:'1.82.2', expectedInstalledVersion:'1.82.1', allowUnknownWml:true}), {code:'WML_INCOMPATIBLE', currentWml:'0.9.5', supportedWml:['0.9.4']});
assert.equal(incompatible.config.writes.length, 0);
const supportedZip = declaredZip("'0.9.5'");
async function updatedGame() {
  const game = fakeGame();
  game.store.set('wml/mods/unrelated/mod.js', bytes('unrelated'));
  const before = new Map([...game.store].map(([p, data]) => [p, data.slice()]));
  const result = await applyUpdate(game.root, supportedZip, {expectedVersion:'1.82.2', expectedInstalledVersion:'1.82.1'});
  return {...game, before, result};
}
const liveFiles = game => new Map([...game.store].filter(([p]) => !p.startsWith('.wml-mod-updater-backups/')));
const manual = await updatedGame();
assert.equal((await listBackups(manual.root)).length, 1);
assert.deepEqual(await listBackups(manual.root, 'unrelated'), []);
const manualResult = await restoreBackup(manual.root, manual.result.backupPath, {allowUnknownWml:true,expectedInstalledVersion:'1.82.2'});
assert.equal(manualResult.version, '1.82.1');
assert.notEqual(manualResult.backupPath, manual.result.backupPath);
assert.deepEqual(liveFiles(manual), manual.before);
assert.equal((await listBackups(manual.root)).length, 2);
assert.equal(manual.config.writes.filter(p => !p.startsWith('.wml-mod-updater-backups/')).at(-1), prefix + 'mod.js');
// The protective rollback backup can reapply the exact pre-rollback files, including added files.
await restoreBackup(manual.root, manualResult.backupPath, {allowUnknownWml:true,expectedInstalledVersion:'1.82.1'});
assert.equal((await inspectGameDirectory(manual.root)).modVersion, '1.82.2');
for (const kind of ['traversal', 'other-mod', 'missing', 'corrupt', 'legacy', 'changed', 'version']) {
  const game = await updatedGame(), manifestPath = game.result.backupPath + '/manifest.json';
  const manifest = JSON.parse(text(game.store.get(manifestPath)));
  if (kind === 'traversal') manifest.files[0].path = '../evil.js';
  if (kind === 'other-mod') manifest.files[0].path = 'wml/mods/another-mod/mod.js';
  if (kind === 'legacy') delete manifest.schema;
  if (kind === 'version') manifest.previousVersion = '9.9.9';
  if (kind === 'missing') game.store.delete(game.result.backupPath + '/' + prefix + 'mod.js');
  if (kind === 'corrupt') game.store.set(game.result.backupPath + '/' + prefix + 'mod.js', bytes('broken'));
  if (kind === 'changed') game.store.set(prefix + 'README_USER.md', bytes('user edit'));
  game.store.set(manifestPath, bytes(JSON.stringify(manifest)));
  const snapshot = new Map(game.store), writes = game.config.writes.length;
  await assert.rejects(restoreBackup(game.root, game.result.backupPath, {allowUnknownWml:true,expectedInstalledVersion:'1.82.2'}));
  assert.equal(game.config.writes.length, writes, kind);
  assert.deepEqual(game.store, snapshot, kind);
  if (kind !== 'changed') {
    const listed = await listBackups(game.root);
    assert.deepEqual(listed, []);
    assert.equal(listed.rejected.length, 1);
    assert.equal(listed.rejected[0].backupPath, game.result.backupPath);
    assert.ok(listed.rejected[0].reason);
  }
}
await assert.rejects(restoreBackup(manual.root, '.wml-mod-updater-backups/attention-image-prompt/../evil', {allowUnknownWml:true,expectedInstalledVersion:'1.82.2'}));
const rollbackFailure = await updatedGame(), rollbackBefore = liveFiles(rollbackFailure);
rollbackFailure.config.fail = prefix + 'README_USER.md';
await assert.rejects(restoreBackup(rollbackFailure.root, rollbackFailure.result.backupPath, {allowUnknownWml:true,expectedInstalledVersion:'1.82.2'}), /이전 상태로 복원/);
assert.deepEqual(liveFiles(rollbackFailure), rollbackBefore);
const protectiveFailure = await updatedGame(), protectiveBefore = liveFiles(protectiveFailure);
protectiveFailure.config.failBackup = true;
await assert.rejects(restoreBackup(protectiveFailure.root, protectiveFailure.result.backupPath, {allowUnknownWml:true,expectedInstalledVersion:'1.82.2'}), /Injected/);
assert.deepEqual(liveFiles(protectiveFailure), protectiveBefore);
const corruptRecovery = fakeGame();
corruptRecovery.config.fail = prefix + 'INTRO_EN.html';
corruptRecovery.config.corruptRecovery = prefix + 'README_USER.md';
await assert.rejects(applyUpdate(corruptRecovery.root, supportedZip, {expectedVersion:'1.82.2', expectedInstalledVersion:'1.82.1'}), /일부 파일을 복원하지 못했습니다: wml\/mods\/attention-image-prompt\/README_USER.md/);
const runtimeRace = await updatedGame(), raceBefore = liveFiles(runtimeRace);
runtimeRace.config.changeRuntimeOnBackup = true;
const liveWritesBefore = runtimeRace.config.writes.filter(p => !p.startsWith('.wml-mod-updater-backups/')).length;
await assert.rejects(restoreBackup(runtimeRace.root, runtimeRace.result.backupPath, {allowUnknownWml:true,expectedInstalledVersion:'1.82.2'}), /복원 준비 중 설치 버전이 변경/);
assert.equal(runtimeRace.config.writes.filter(p => !p.startsWith('.wml-mod-updater-backups/')).length, liveWritesBefore);
raceBefore.set('wml/runtime/wml-core.js', bytes("const VERSION = '0.9.4';"));
assert.deepEqual(liveFiles(runtimeRace), raceBefore);

const faithFile = 'Wayward_Faith_v3.3.2.html';
const faithHTML = version => `<html><head><title>Wayward: Faith</title><meta name="wf-version" content="${version}"><script src="wml/runtime/wml-core.js"></script></head></html>`;
const faithHeader = (version = '1.1.0', game = 'faith>=3.3.0', wml = "'0.9.3'") => `WML.define({id:'attention-image-prompt',version:'${version}',game:'${game}',${wml ? `wml:${wml},` : ''}setup(){}});`;
function faithGame({game = 'faith>=3.3.0', wml = "'0.9.3'"} = {}) {
  const fixture = fakeGame();
  fixture.store.set(prefix + 'mod.js', bytes(faithHeader('1.0.0', game, wml)));
  fixture.store.set('wml/runtime/wml-core.js', bytes("const VERSION = '0.9.3';"));
  fixture.store.delete('Wayward_WML_ko.html');
  fixture.store.set(faithFile, bytes(faithHTML('3.3.2')));
  return fixture;
}
const faithEntries = [{name:prefix+'mod.js',data:Buffer.from(faithHeader())},{name:prefix+'assets/icon.svg',data:Buffer.from('<svg/>')}];
const faithZip = zip(faithEntries);
const faithOptions = {gameFile:faithFile,expectedInstalledVersion:'1.0.0',expectedVersion:'1.1.0'};
for (const archiveRoot of ['', 'attention-image-prompt/', 'mods/', 'mods/attention-image-prompt/', 'wml/mods/', prefix]) {
  const fixture = faithGame(), before = liveFiles(fixture);
  const archive = zip(faithEntries.map(entry => ({...entry,name:archiveRoot+entry.name.slice(prefix.length)})));
  const pkg = await inspectPackage(archive, '1.1.0');
  assert.equal(pkg.gameFamily, 'faith');
  assert.equal(evaluateCompatibility(pkg, '0.9.3', 'faith-3.3.2').gameState, 'supported');
  const result = await applyUpdate(fixture.root, archive, faithOptions);
  const backups = await listBackups(fixture.root);
  assert.equal(backups[0].gameFamily, 'faith');
  assert.equal(backups[0].gameSpec, 'faith>=3.3.0');
  assert.deepEqual(backups[0].supportedWml, ['0.9.3']);
  await restoreBackup(fixture.root, result.backupPath, {gameFile:faithFile,expectedInstalledVersion:'1.1.0'});
  assert.deepEqual(liveFiles(fixture), before, archiveRoot);
}
for (const game of ['>=2026-10-04', 'faith>=3.3.3', 'faith<3.3.2']) {
  const fixture = faithGame();
  const archive = zip([{name:prefix+'mod.js',data:Buffer.from(faithHeader('1.1.0',game))}]);
  await assert.rejects(applyUpdate(fixture.root, archive, {...faithOptions,allowUnknownWml:true}), {code:'GAME_INCOMPATIBLE'});
  assert.equal(fixture.config.writes.length, 0);
}
const normalWrongFamily = fakeGame();
await assert.rejects(applyUpdate(normalWrongFamily.root, faithZip, {expectedInstalledVersion:'1.82.1',expectedVersion:'1.1.0',allowUnknownWml:true}), /같거나 이전/);
const normalFaithZip = zip([{name:prefix+'mod.js',data:Buffer.from(faithHeader('1.83.0','faith',"'0.9.5'"))}]);
await assert.rejects(applyUpdate(normalWrongFamily.root, normalFaithZip, {expectedInstalledVersion:'1.82.1',expectedVersion:'1.83.0',allowUnknownWml:true}), {code:'GAME_INCOMPATIBLE'});
assert.equal(normalWrongFamily.config.writes.length, 0);
const normalOldLoader = fakeGame();
normalOldLoader.store.set('wml/runtime/wml-core.js', bytes("const VERSION = '0.9.2';"));
await assert.rejects(inspectGameDirectory(normalOldLoader.root), /WML 0.9.3/);

const multipleHTML = faithGame();
multipleHTML.store.set('Wayward_WML_ko.html', bytes('<script src="wml/runtime/wml-core.js"></script>/* WML_BRIDGE_BEGIN 2026-11-01 */'));
await assert.rejects(inspectGameDirectory(multipleHTML.root), /하나로 확인/);
assert.equal((await inspectGameDirectory(multipleHTML.root, 'attention-image-prompt', {gameFile:faithFile})).gameVersion, 'faith-3.3.2');
for (const gameFile of ['../Wayward.html','sub/Wayward.html','C:\\Wayward.html','..\\Wayward.html']) await assert.rejects(inspectGameDirectory(multipleHTML.root, 'attention-image-prompt', {gameFile}), /파일 이름/);
const renamedHTML = faithGame();
renamedHTML.store.set('renamed.html', renamedHTML.store.get(faithFile));
renamedHTML.store.delete(faithFile);
assert.equal((await inspectGameDirectory(renamedHTML.root, 'attention-image-prompt', {gameFile:'renamed.html'})).gameVersion, 'faith-3.3.2');
const wrongHTML = faithGame();
wrongHTML.store.set(faithFile, bytes(faithHTML('3.3.2') + '<script src="wml/symbols/faith-3.3.1.js"></script>'));
await assert.rejects(applyUpdate(wrongHTML.root, faithZip, faithOptions), /서로 다릅니다/);
assert.equal(wrongHTML.config.writes.length, 0);
const htmlRace = faithGame();
htmlRace.config.changeHTMLOnBackup = {path:faithFile, html:faithHTML('3.3.3')};
await assert.rejects(applyUpdate(htmlRace.root, faithZip, faithOptions), /백업 중 설치 버전이 변경/);
assert.equal(htmlRace.config.writes.filter(p => !p.startsWith('.wml-mod-updater-backups/')).length, 0);

for (const oldSpec of ['>=2026-10-04','faith>=3.4.0']) {
  const fixture = faithGame({game:oldSpec});
  const result = await applyUpdate(fixture.root, faithZip, faithOptions);
  const writes = fixture.config.writes.length;
  await assert.rejects(restoreBackup(fixture.root, result.backupPath, {gameFile:faithFile,expectedInstalledVersion:'1.1.0',allowUnknownWml:true}), {code:'GAME_INCOMPATIBLE'});
  assert.equal(fixture.config.writes.length, writes);
}
const unknownRestore = faithGame({wml:null});
const unknownResult = await applyUpdate(unknownRestore.root, faithZip, faithOptions);
await assert.rejects(restoreBackup(unknownRestore.root, unknownResult.backupPath, {gameFile:faithFile,expectedInstalledVersion:'1.1.0'}), {code:'WML_COMPAT_UNKNOWN'});
await restoreBackup(unknownRestore.root, unknownResult.backupPath, {gameFile:faithFile,expectedInstalledVersion:'1.1.0',allowUnknownWml:true});
const incompatibleRestore = faithGame();
const incompatibleResult = await applyUpdate(incompatibleRestore.root, faithZip, faithOptions);
incompatibleRestore.store.set('wml/runtime/wml-core.js', bytes("const VERSION = '0.9.4';"));
const restoreWrites = incompatibleRestore.config.writes.length;
await assert.rejects(restoreBackup(incompatibleRestore.root, incompatibleResult.backupPath, {gameFile:faithFile,expectedInstalledVersion:'1.1.0',allowUnknownWml:true}), {code:'WML_INCOMPATIBLE'});
assert.equal(incompatibleRestore.config.writes.length, restoreWrites);
const restoreHTMLRace = faithGame();
const restoreHTMLResult = await applyUpdate(restoreHTMLRace.root, faithZip, faithOptions);
restoreHTMLRace.config.changeHTMLOnBackup = {path:faithFile, html:faithHTML('3.3.3')};
const originalWrites = restoreHTMLRace.config.writes.filter(p => !p.startsWith('.wml-mod-updater-backups/')).length;
await assert.rejects(restoreBackup(restoreHTMLRace.root, restoreHTMLResult.backupPath, {gameFile:faithFile,expectedInstalledVersion:'1.1.0'}), /복원 준비 중 설치 버전이 변경/);
assert.equal(restoreHTMLRace.config.writes.filter(p => !p.startsWith('.wml-mod-updater-backups/')).length, originalWrites);
for (const path of ['Wayward_Faith_v3.3.2.html', prefix+'Wayward_Faith_v3.3.2.html']) {
  await assert.rejects(inspectPackage(zip([...faithEntries,{name:path,data:Buffer.from(faithHTML('3.3.2'))}]),'1.1.0'), /경로|게임 HTML/);
}

// Overtime and Harbor use the agreed format as fixtures; no releases of these games are available here.
const namedHTML = (family, version) => `<meta name="${family === 'overtime' ? 'ot-version' : 'wml-game'}" content="${family === 'overtime' ? version : family+'-'+version}"><script src="wml/runtime/wml-core.js"></script>`;
function namedGame(family) {
  const fixture = faithGame({game:family,wml:"'1.0.0'"});
  fixture.store.delete(faithFile);
  fixture.gameFile = family + '.html';
  fixture.store.set(fixture.gameFile, bytes(namedHTML(family,'1.2.3')));
  fixture.store.set('wml/runtime/wml-core.js', bytes("const VERSION = '1.0.0';"));
  return fixture;
}
for (const family of ['overtime','harbor']) {
  const entries = [{name:prefix+'mod.js',data:Buffer.from(faithHeader('1.1.0',family+'>=1.0.0',"'1.0.0'"))},{name:prefix+'assets/icon.svg',data:Buffer.from('<svg/>')}];
  for (const archiveRoot of ['', 'attention-image-prompt/', 'mods/', 'mods/attention-image-prompt/', 'wml/mods/', prefix]) {
    const fixture = namedGame(family), before = liveFiles(fixture);
    const archive = zip(entries.map(entry => ({...entry,name:archiveRoot+entry.name.slice(prefix.length)})));
    const info = await inspectGameDirectory(fixture.root);
    assert.equal(info.gameFamily, family); assert.equal(info.wmlVersion,'1.0.0');
    const result = await applyUpdate(fixture.root, archive, {gameFile:fixture.gameFile,expectedInstalledVersion:'1.0.0',expectedVersion:'1.1.0'});
    assert.equal((await listBackups(fixture.root))[0].gameFamily, family);
    await restoreBackup(fixture.root, result.backupPath, {gameFile:fixture.gameFile,expectedInstalledVersion:'1.1.0'});
    assert.deepEqual(liveFiles(fixture),before);
  }
  await assert.rejects(inspectPackage(zip([...entries,{name:prefix+'game.html',data:Buffer.from(namedHTML(family,'1.2.3'))}]),'1.1.0'), /게임 HTML/);
  const newer = namedGame(family);
  await assert.rejects(applyUpdate(newer.root, zip([{name:prefix+'mod.js',data:Buffer.from(faithHeader('1.1.0',family+'>=1.2.4',"'1.0.0'"))}]), {gameFile:newer.gameFile,expectedInstalledVersion:'1.0.0',expectedVersion:'1.1.0'}), {code:'GAME_INCOMPATIBLE'});
  assert.equal(newer.config.writes.length,0);
}
for (const currentFamily of ['wayward','faith','overtime','harbor']) {
  for (const otherFamily of ['wayward','faith','overtime','harbor'].filter(family => family !== currentFamily)) {
    const fixture = currentFamily === 'wayward' ? fakeGame() : currentFamily === 'faith' ? faithGame() : namedGame(currentFamily);
    const gameFile = fixture.gameFile || (currentFamily === 'faith' ? faithFile : 'Wayward_WML_ko.html');
    fixture.store.set('wml/runtime/wml-core.js',bytes("const VERSION = '1.0.0';"));
    fixture.store.set(prefix+'mod.js',bytes(faithHeader('1.0.0',currentFamily,"'1.0.0'")));
    const wrong = zip([{name:prefix+'mod.js',data:Buffer.from(faithHeader('1.1.0',otherFamily,"'1.0.0'"))}]);
    await assert.rejects(applyUpdate(fixture.root, wrong, {gameFile,expectedInstalledVersion:'1.0.0',expectedVersion:'1.1.0',allowUnknownWml:true}), {code:'GAME_INCOMPATIBLE'});
    assert.equal(fixture.config.writes.length,0);
    fixture.store.set(prefix+'mod.js',bytes(faithHeader('1.0.0',otherFamily,"'1.0.0'")));
    const correct = zip([{name:prefix+'mod.js',data:Buffer.from(faithHeader('1.1.0',currentFamily,"'1.0.0'"))}]);
    const result = await applyUpdate(fixture.root, correct, {gameFile,expectedInstalledVersion:'1.0.0',expectedVersion:'1.1.0'});
    const writes = fixture.config.writes.length;
    await assert.rejects(restoreBackup(fixture.root,result.backupPath,{gameFile,expectedInstalledVersion:'1.1.0',allowUnknownWml:true}),{code:'GAME_INCOMPATIBLE'});
    assert.equal(fixture.config.writes.length,writes);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log('installer: generic game families, six ZIP layouts, exact HTML/race guards, cross-family update/rollback gates, backups and unrelated files passed');
