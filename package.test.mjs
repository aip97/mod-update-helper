import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync, spawnSync} from 'node:child_process';
import {test} from 'node:test';

const dir = path.dirname(fileURLToPath(import.meta.url));
const version = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version;
const read = file => fs.readFileSync(file);
const quotePS = value => "'" + value.replaceAll("'", "''") + "'";
const powershell = args => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], {encoding:'utf8'});
const filesIn = directory => fs.readdirSync(directory, {withFileTypes:true}).flatMap(entry => {
  const full = path.join(directory, entry.name);
  return entry.isDirectory() ? filesIn(full).map(name => entry.name + '/' + name) : [entry.name];
}).sort();

test('user/modder distributions are complete, separated, installable, and never overwrite ZIPs', () => {
  fs.mkdirSync(path.join(dir, 'test-output'), {recursive:true});
  const testRoot = fs.mkdtempSync(path.join(dir, 'test-output', 'package-'));
  const previous = fs.readdirSync(dir).filter(name => /^WML-Mod-Updater-.*\.zip$/.test(name)).map(name => [name, read(path.join(dir, name))]);
  execFileSync(process.execPath, ['package.mjs', testRoot], {cwd:dir, stdio:'pipe'});
  const userZip = path.join(testRoot, `Mod-Update-Helper-User-${version}.zip`);
  const modderZip = path.join(testRoot, `Mod-Update-Helper-Modder-${version}.zip`);
  const user = path.join(testRoot, 'user');
  const modder = path.join(testRoot, 'modder');
  powershell(['-Command', `Expand-Archive -LiteralPath ${quotePS(userZip)} -DestinationPath ${quotePS(user)}; Expand-Archive -LiteralPath ${quotePS(modderZip)} -DestinationPath ${quotePS(modder)}`]);
  const userFiles = filesIn(user);
  assert.deepEqual(userFiles, [
    'manifest.json','worker.mjs','core.mjs','game-compat.mjs','mod-names-ko.mjs','game-bridge.js','wml-reader.js','installer.mjs','folder-store.mjs','kio.js','kio-api.mjs',
    'update.html','update.css','update.mjs','vendor/cbor-x-1.6.4.mjs','vendor/cbor-x-LICENSE',
    'native-filesystem.mjs','native-host.ps1','native-host.cmd','native-install.ps1',
  'self-update.mjs','self-update-config.json','native-self-update.ps1','native-bootstrap.ps1','native-bootstrap.cmd',
  'game-release.mjs','game-installer.mjs','game-update-ui.mjs','native-game-update.ps1',
    'THIRD_PARTY_NOTICES.md','GUIDE.html','Install.cmd','install.ps1',
  ].sort());
  for (const name of userFiles) assert.deepEqual(read(path.join(user, name)), read(path.join(dir, name === 'GUIDE.html' ? 'USER_GUIDE.html' : name)), name);
  assert.deepEqual([...read(path.join(user, 'install.ps1')).subarray(0, 3)], [239, 187, 191], 'Windows PowerShell 5 Korean requires UTF-8 BOM');
  const manifest = JSON.parse(read(path.join(user, 'manifest.json')));
  assert.ok(manifest.permissions.includes('nativeMessaging'));
  assert.ok(manifest.key, 'native messaging requires a stable extension identity');
  for (const name of [manifest.background.service_worker, ...manifest.content_scripts.flatMap(script => script.js)]) assert.ok(userFiles.includes(name), name);
  for (const name of userFiles.filter(name => /\.(?:html|mjs|js|css)$/.test(name))) {
    const contents = read(path.join(user, name)).toString('utf8');
    const references = name.endsWith('.html')
      ? [...contents.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)].map(match => match[1])
      : [...contents.matchAll(/\bfrom\s*["'](\.[^"']+)["']/g)].map(match => match[1]);
    for (const reference of references.filter(reference => !/^(?:[a-z]+:|#)/i.test(reference))) {
      assert.ok(fs.existsSync(path.resolve(user, path.dirname(name), reference.split(/[?#]/)[0])), `${name}: missing ${reference}`);
    }
  }
  const modderFiles = filesIn(modder);
  assert.equal(modderFiles.length, 20);
  for (const name of ['README.md','AI_MOD_INTEGRATION.md','GUIDE.html','examples/bridge.js','examples/mod.js','examples/release-post.txt','examples/package-mod.py','skills/wml-updater-integration/SKILL.md']) assert.ok(modderFiles.includes(name), name);
  assert.ok(!modderFiles.some(name => /(?:^|\/)(?:manifest\.json|Install\.cmd|install\.ps1|worker\.mjs|update\.html|USER_GUIDE\.html)$/.test(name)));
  assert.ok(!modderFiles.some(name => /test|private|test-output/i.test(name)));
  assert.deepEqual(read(path.join(modder, 'GUIDE.html')), read(path.join(dir, 'GUIDE.html')));
  for (const name of ['core.mjs','game-compat.mjs','installer.mjs']) assert.deepEqual(read(path.join(modder, 'tools', name)), read(path.join(dir, name)));
  for (const name of ['SKILL.md','references/contract.md','assets/bridge.js','scripts/package-mod.py','agents/openai.yaml']) {
    const relative = 'skills/wml-updater-integration/' + name;
    assert.deepEqual(read(path.join(modder, relative)), read(path.join(dir, relative)), relative);
  }
  for (const name of ['AI_MOD_INTEGRATION.md','skills/wml-updater-integration/SKILL.md','skills/wml-updater-integration/references/contract.md']) {
    for (const [, reference] of read(path.join(modder, name)).toString('utf8').matchAll(/\]\(([^)]+)\)/g)) {
      if (!/^(?:[a-z]+:|#)/i.test(reference)) assert.ok(fs.existsSync(path.resolve(modder, path.dirname(name), reference.split('#')[0])), `${name}: missing ${reference}`);
    }
  }
  const script = path.join(user, 'install.ps1');
  assert.match(powershell(['-File', script, '-ValidateOnly']), /33/);
  const destination = path.join(testRoot, 'installed');
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(destination, 'existing.txt'), 'preserve');
  fs.writeFileSync(path.join(user, 'private.txt'), 'do not install');
  powershell(['-File',script,'-DestinationRoot',destination,'-NoLaunch']);
  assert.throws(()=>powershell(['-File',script,'-DestinationRoot',destination,'-NoLaunch']),'existing installation must be preserved');
  const installs = fs.readdirSync(destination, {withFileTypes:true}).filter(entry => entry.isDirectory());
  assert.equal(installs.length, 1);
  for (const install of installs) {
    const installed = path.join(destination, install.name);
    assert.deepEqual(filesIn(installed), userFiles.sort());
    for (const name of userFiles) assert.deepEqual(read(path.join(installed, name)), read(path.join(user, name)));
    const host = JSON.parse(read(path.join(destination, 'org.wml.mod_updater.json')));
    assert.equal(host.name, 'org.wml.mod_updater');
    assert.equal(host.path, path.join(destination, 'native-bootstrap.cmd'));
    assert.deepEqual(host.allowed_origins, ['chrome-extension://dlddgdefgecebmfhjinfamnffjkgohao/']);
  }
  assert.equal(fs.readFileSync(path.join(destination, 'existing.txt'), 'utf8'), 'preserve');
  const preservedUser = read(userZip), preservedModder = read(modderZip);
  let attempt = spawnSync(process.execPath, ['package.mjs', testRoot], {cwd:dir, encoding:'utf8'});
  assert.notEqual(attempt.status, 0);
  assert.match(attempt.stderr, /Existing ZIP is preserved/);
  assert.deepEqual(read(userZip), preservedUser);
  assert.deepEqual(read(modderZip), preservedModder);
  fs.renameSync(userZip, userZip + '.preserved');
  attempt = spawnSync(process.execPath, ['package.mjs', testRoot], {cwd:dir, encoding:'utf8'});
  assert.notEqual(attempt.status, 0);
  assert.match(attempt.stderr, /Existing ZIP is preserved/);
  assert.ok(!fs.existsSync(userZip), 'A conflicting second ZIP must prevent the first ZIP from being written');
  assert.deepEqual(read(modderZip), preservedModder);
  fs.renameSync(userZip + '.preserved', userZip);
  for (const [name, contents] of previous) assert.deepEqual(read(path.join(dir, name)), contents, `Preserve ${name}`);
  console.log(`Distribution smoke artifacts: ${testRoot}`);
});
