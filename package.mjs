import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {writeZip, checkZip, readZipNames} from './zip-tools.mjs';
const dir = path.dirname(fileURLToPath(import.meta.url));
const version = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version;
if(JSON.parse(fs.readFileSync(path.join(dir,'package.json'),'utf8')).version!==version) throw new Error('Package and manifest versions differ.');
for(const name of ['wml-reader.js','game-bridge.js']) if(!fs.readFileSync(path.join(dir,name),'utf8').includes(`version === '${version}'`)) throw new Error('Content script version must be updated: '+name);
if (process.argv.length > 3 || process.argv[2]?.toLowerCase().endsWith('.zip')) {
  throw new Error('Usage: node package.mjs [output-directory] (writes User and Modder ZIPs)');
}
const output = path.resolve(dir, process.argv[2] || '.');
const userFiles = [
  'manifest.json','worker.mjs','core.mjs','game-compat.mjs','mod-names-ko.mjs','game-bridge.js','wml-reader.js','installer.mjs','folder-store.mjs','kio.js','kio-api.mjs',
  'update.html','update.css','update.mjs','vendor/cbor-x-1.6.4.mjs','vendor/cbor-x-LICENSE',
  'native-filesystem.mjs','native-host.ps1','native-host.cmd','native-install.ps1','defender-scan.mjs','native-defender.ps1','wiki-client.mjs','wiki-ui.mjs','wiki-install.mjs','wiki-auto.mjs',
  'self-update.mjs','self-update-config.json','native-self-update.ps1','native-bootstrap.ps1','native-bootstrap.cmd',
  'game-release.mjs','game-installer.mjs','game-update-ui.mjs','native-game-update.ps1',
  'THIRD_PARTY_NOTICES.md','GUIDE.html','Install.cmd','install.ps1',
];
const modderFiles = [
  'README.md','GUIDE.html','AI_MOD_INTEGRATION.md','GAME_UPDATE.md','examples/game-update.js',
  'examples/bridge.js','examples/mod.js','examples/release-post.txt','examples/package-mod.py',
  'tools/core.mjs','tools/game-compat.mjs','tools/installer.mjs','tools/game-installer.mjs',
  'skills/wml-updater-integration/SKILL.md',
  'skills/wml-updater-integration/references/contract.md',
  'skills/wml-updater-integration/references/game-update.md','skills/wml-updater-integration/assets/game-update.js',
  'skills/wml-updater-integration/assets/bridge.js',
  'skills/wml-updater-integration/scripts/package-mod.py',
  'skills/wml-updater-integration/agents/openai.yaml',
];
const distributions = [
  {audience:'User', names:userFiles, sources:{'GUIDE.html':'USER_GUIDE.html'}},
  {audience:'Modder', names:modderFiles, sources:{'tools/core.mjs':'core.mjs','tools/game-compat.mjs':'game-compat.mjs','tools/installer.mjs':'installer.mjs','tools/game-installer.mjs':'game-installer.mjs'}},
].map(spec => ({...spec, zip:path.join(output, `Mod-Update-Helper-${spec.audience}-${version}.zip`)}));
for (const {zip} of distributions) {
  if (fs.existsSync(zip)) throw new Error('Existing ZIP is preserved: ' + zip);
}
for (const script of ['build-guide.mjs','build-user-guide.mjs']) execFileSync(process.execPath,[script],{cwd:dir,stdio:'inherit'});
// Read both allowlists before writing either archive, so missing source files cannot leave a partial release.
for (const distribution of distributions) {
  distribution.entries = distribution.names.map(name => {
    const source = path.join(dir, distribution.sources[name] || name);
    return {name, data:fs.readFileSync(source), mtime:fs.statSync(source).mtime};
  });
}
fs.mkdirSync(output, {recursive:true});
for (const {zip, names, entries} of distributions) {
  writeZip(zip, entries); checkZip(zip);
  const actual = readZipNames(zip).map(entry => entry.name);
  if (actual.length !== names.length || actual.some(name => !names.includes(name))) throw new Error('Distribution file list mismatch');
  console.log(`${zip} (${names.length} files)`);
}
