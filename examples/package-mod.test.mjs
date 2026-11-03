import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {inspectPackage} from '../installer.mjs';
import {parseGameRequirement} from '../game-compat.mjs';

const helper = fileURLToPath(new URL('./package-mod.py', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wml-package-test-'));
const source = path.join(tmp, 'mod'); fs.mkdirSync(source);
const run = version => spawnSync('python', [helper, source, tmp, '--id', 'sample-mod', '--version', version], {encoding:'utf8'});
try {
  const reserved = spawnSync('python', ['-c', "import runpy,sys; m=runpy.run_path(sys.argv[1]); assert all(not m['safe_component'](prefix+chr(code)+'.txt') for prefix in ('COM','lpt') for code in (0xb9,0xb2,0xb3))", helper], {encoding:'utf8'});
  assert.equal(reserved.status, 0, reserved.stderr);
  const compatibility = spawnSync('python', ['-c', "import runpy,sys; m=runpy.run_path(sys.argv[1]); check=m['check_header']; base=\"WML.define({id:'sample-mod',version:'1.0.0',game:'>=2026-10-04',wml:%s,setup(){}});\"\nfor value in (\"'0.9.5'\", \"['0.9.4', '0.9.5']\"):\n check((base%value).encode(),'sample-mod','1.0.0')\nfor value in (\"'>=0.9.5'\",\"'0.09.5'\",\"[]\",\"['0.9.5','0.9.5']\",\"null\"):\n try: check((base%value).encode(),'sample-mod','1.0.0')\n except ValueError: pass\n else: raise AssertionError(value)", helper], {encoding:'utf8'});
  assert.equal(compatibility.status, 0, compatibility.stderr);
  const gameRequirements = [
    ['*', true], [' * ', true], ['wayward', true], ['faith', true],
    ['>=2026-10-04', true], ['wayward >=2026-10-18-pre <2026-11-02', true],
    ['faith>=3.3.2', true], ['>=faith-3.3.2 <faith-4.0.0', true], ['faith-3.3.2', true],
    ['faith faith>=3.3.2', true], ['faith=3.3.2', true],
    ['overtime', true], ['overtime>=1.0.0', true], ['>=overtime-1.0.0 <overtime-2.0.0', true], ['overtime-1.0.0', true],
    ['overtime overtime>=1.0.0', true], ['overtime=1.0.0', true],
    ['harbor', true], ['harbor>=1.2.0 <harbor-2.0.0', true], ['harbor-1.2.3', true], ['future-1.0.0', true],
    ['harbor-1', true], ['harbor-1>=1.0.0', true], ['unknown', true],
    ['', false], [' ', false], ['unknown?', false], ['faith *', false], ['wayward faith', false],
    ['faith >=2026-11-01', false], ['>=2026-02-30', false], ['>=0999-12-31', false],
    ['faith>=03.3.2', false], ['faith>=1000000.0.0', false], ['faith>=3.x', false],
    ['faith overtime', false], ['overtime >=2026-11-01', false], ['overtime>=01.0.0', false], ['overtime>=1000000.0.0', false],
    ['harbor faith', false], ['harbor-01', false], ['Harbor-1.0.0', false], ['harbor_2>=1.0.0', false], ['wayward-1.0.0', false], ['a'.repeat(65), false],
    ['any', false], ['any-1.0.0', false], ['faith3.3.2', false],
    ['>=2026-01-01-' + 'p'.repeat(54), false], ['faith-' + '1.'.repeat(29) + '1', false], [' '.repeat(256) + '*', false],
  ];
  const gameCheck = spawnSync('python', ['-c', "import json,runpy,sys; m=runpy.run_path(sys.argv[1]); print(json.dumps([m['valid_game_requirement'](v) for v in json.loads(sys.argv[2])]))", helper, JSON.stringify(gameRequirements.map(([value]) => value))], {encoding:'utf8'});
  assert.equal(gameCheck.status, 0, gameCheck.stderr);
  assert.deepEqual(JSON.parse(gameCheck.stdout), gameRequirements.map(([, valid]) => valid));
  for (const [value, valid] of gameRequirements) {
    if (valid) assert.doesNotThrow(() => parseGameRequirement(value), value);
    else assert.throws(() => parseGameRequirement(value), undefined, value);
  }
  assert.deepEqual(fs.readFileSync(helper), fs.readFileSync(new URL('../skills/wml-updater-integration/scripts/package-mod.py', import.meta.url)), 'standalone skill packager stays identical');
  const ids = spawnSync('python', ['-c', "import runpy,sys,pathlib; m=runpy.run_path(sys.argv[1]); root=pathlib.Path(sys.argv[2]); source=root/'ids'; source.mkdir();\nfor mod_id in ('another_mod','my.mod'):\n (source/'mod.js').write_text(\"WML.define({id:'\"+mod_id+\"',version:'1.0.0',game:'>=2026-10-04',setup(){}});\"); m['package'](source,root,mod_id,'1.0.0')\nfor mod_id in ('con','aux.mod','trailing.'):\n try: m['package'](source,root,mod_id,'1.0.0')\n except ValueError as e: assert 'Invalid mod ID' in str(e)\n else: raise AssertionError(mod_id)", helper, tmp], {encoding:'utf8'});
  assert.equal(ids.status, 0, ids.stderr);
  for (const id of ['another_mod', 'my.mod']) assert.equal((await inspectPackage(fs.readFileSync(path.join(tmp, `${id} 1.0.0.zip`)), '1.0.0', id)).version, '1.0.0');
  fs.writeFileSync(path.join(source, 'mod.js'), "// test\nWML.define({id:'sample-mod', version:'1.2.0', game:'>=2026-10-04', setup(api){}});");
  fs.mkdirSync(path.join(source, 'assets'));
  fs.writeFileSync(path.join(source, 'assets/icon.svg'), '<svg/>');
  const result = run('1.2.0'); assert.equal(result.status, 0, result.stderr);
  const output = path.join(tmp, 'sample-mod 1.2.0.zip'), bytes = fs.readFileSync(output);
  assert.equal((await inspectPackage(bytes, '1.2.0', 'sample-mod')).files.length, 2);
  assert.notEqual(run('1.2.0').status, 0, 'must refuse existing ZIP');
  assert.deepEqual(fs.readFileSync(output), bytes);
  assert.notEqual(run('1.2.1').status, 0, 'must reject mismatched metadata');
  fs.writeFileSync(path.join(source, 'settings.json'), '{}');
  const unsafe = run('1.2.0'); assert.notEqual(unsafe.status, 0); assert.match(unsafe.stderr, /Unsafe or mutable/);
  assert.equal(fs.existsSync(path.join(tmp, 'sample-mod 1.2.1.zip')), false);
  fs.unlinkSync(path.join(source, 'settings.json'));
  fs.writeFileSync(path.join(source, 'mod.js'), "WML.define({id:'sample-mod',version:'1.3.0',game:'faith>=3.3.2',wml:'0.9.3',setup(){}});");
  const faithResult = run('1.3.0'); assert.equal(faithResult.status, 0, faithResult.stderr);
  const faithPackage = await inspectPackage(fs.readFileSync(path.join(tmp, 'sample-mod 1.3.0.zip')), '1.3.0', 'sample-mod');
  assert.equal(faithPackage.version, '1.3.0');
  fs.writeFileSync(path.join(source, 'mod.js'), "WML.define({id:'sample-mod',version:'1.4.0',game:'overtime>=1.0.0',wml:'0.9.3',setup(){}});");
  const overtimeResult = run('1.4.0'); assert.equal(overtimeResult.status, 0, overtimeResult.stderr);
  const overtimePackage = await inspectPackage(fs.readFileSync(path.join(tmp, 'sample-mod 1.4.0.zip')), '1.4.0', 'sample-mod');
  assert.equal(overtimePackage.version, '1.4.0');
  assert.equal(overtimePackage.gameFamily, 'overtime');
  fs.writeFileSync(path.join(source, 'mod.js'), "WML.define({id:'sample-mod',version:'1.5.0',game:'harbor>=1.2.0 <harbor-2.0.0',wml:'1.0.0',setup(){}});");
  const genericResult = run('1.5.0'); assert.equal(genericResult.status, 0, genericResult.stderr);
  const genericPackage = await inspectPackage(fs.readFileSync(path.join(tmp, 'sample-mod 1.5.0.zip')), '1.5.0', 'sample-mod');
  assert.equal(genericPackage.gameFamily, 'harbor');
  console.log('Python packager: installer-compatible ZIP, overwrite refusal, metadata and mutable-path guards passed');
} finally {
  assert.equal(path.dirname(tmp), path.resolve(os.tmpdir()));
  assert.ok(path.basename(tmp).startsWith('wml-package-test-'));
  fs.rmSync(tmp, {recursive:true, force:true});
}
