import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url));
const args=process.argv.slice(2);
if(args.length && (args.length!==2 || args[0]!=='--output' || !args[1])) throw new Error('Usage: node export-source.mjs [--output project-relative-empty-directory]');
const targetName=args.length ? args[1] : 'release-source';
if(path.isAbsolute(targetName) || path.win32.isAbsolute(targetName) || path.posix.isAbsolute(targetName) || /[:\x00]/.test(targetName) || targetName.split(/[\\/]/).some(part=>!part || part==='.' || part==='..' || part.toLowerCase()==='.git')) throw new Error('Export target must be a project-relative directory.');
const output=path.resolve(dir,targetName),relativeOutput=path.relative(dir,output);
if(!relativeOutput || relativeOutput==='..' || relativeOutput.startsWith('..'+path.sep) || path.isAbsolute(relativeOutput)) throw new Error('Export target must stay inside the project.');
let current=dir;
for(const part of relativeOutput.split(path.sep)) {
  current=path.join(current,part);
  let info;try {info=fs.lstatSync(current);} catch(error) {if(error.code==='ENOENT') break;throw error;}
  if(info.isSymbolicLink() || !info.isDirectory()) throw new Error('Export target must use regular directories.');
}
if(args.length && fs.existsSync(output) && fs.readdirSync(output).length) throw new Error('Specified export target must be empty: '+targetName);
const install=fs.readFileSync(path.join(dir,'install.ps1'),'utf8').match(/\$files = @\(([\s\S]*?)\)/)?.[1];
if(!install) throw new Error('Installer allowlist is missing.');
const names=new Set([...install.matchAll(/'([^']+)'/g)].map(match=>match[1]));
for(const name of ['README.md','GAME_UPDATE.md','AI_MOD_INTEGRATION.md','RELEASING.md','USER_GUIDE.html','GUIDE.template.html','build-guide.mjs','build-user-guide.mjs','package.mjs','package.json','release.mjs','export-source.mjs','zip-tools.mjs','.gitignore','core.test.mjs','installer.test.mjs','zip-unicode.test.mjs','kio-api.test.mjs','game-compat.test.mjs','game-update.test.mjs','post-diagnostics.test.mjs','worker-notify.test.mjs','worker-self-update.test.mjs','self-update-worker.test.mjs','self-update-schedule.test.mjs','self-update-ui.test.mjs','defender-scan.test.mjs','wiki-client.test.mjs','wiki-auto.test.mjs','wiki-worker.test.mjs','wiki-install.test.mjs','wiki-browser-test.mjs','examples-test.mjs','native-host.test.mjs','native-defender.test.mjs','self-update.test.mjs','package.test.mjs','installer-tool-test.ps1']) names.add(name);
for(const name of [
  'export-source.test.mjs',
  'browser-test-deps.mjs','browser-test.mjs','bulk-browser-test.mjs','consent-browser-test.mjs','game-update-browser-test.mjs',
  'wiki/supabase/schema.sql','wiki/supabase/schema.test.mjs','wiki/supabase/game-family-migration.sql','wiki/supabase/schema-v1.fixture.sql','wiki/supabase/migration.test.mjs',
  'wiki-server/README.md','wiki-server/index.mjs','wiki-server/wiki-submit.mjs','wiki-server/wiki-submit.test.mjs',
  'wiki-server/verify.mjs','wiki-server/verify-when-approved.mjs','wiki-server/verify-when-approved.test.mjs',
  'wiki-admin/README.md','wiki-admin/admin.py','wiki-admin/client.py','wiki-admin/config.json',
  'wiki-admin/test_client.py','wiki-admin/WML-Wiki-Admin.spec',
]) names.add(name);
function include(relative) {
  for(const entry of fs.readdirSync(path.join(dir,relative),{withFileTypes:true})) {
    if(entry.name.startsWith('.') || entry.name==='__pycache__' || entry.isSymbolicLink()) continue;
    const name=relative+'/'+entry.name;
    if(entry.isDirectory()) include(name);
    else if(/\.(?:m?js|json|md|txt|py|yaml|png|jpg)$/.test(name)) names.add(name);
  }
}
for(const folder of ['examples','skills','docs/screenshots']) include(folder);
const entries=[...names].sort().map(name=>{
  const source=path.join(dir,name);
  const relative=path.relative(dir,source);
  if(relative==='..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative)) throw new Error('Source path is outside the project: '+name);
  for(let ancestor=source;ancestor!==dir;ancestor=path.dirname(ancestor)) {
    if(fs.lstatSync(ancestor).isSymbolicLink()) throw new Error('Linked source path is not allowed: '+name);
  }
  if(fs.lstatSync(source).isSymbolicLink() || !fs.statSync(source).isFile()) throw new Error('Export requires a regular file: '+name);
  return {name,bytes:fs.readFileSync(source)};
});
if(fs.existsSync(output)) {
  if(fs.lstatSync(output).isSymbolicLink() || !fs.statSync(output).isDirectory()) throw new Error('Export target must be a regular directory.');
  const allowed=new Set([...names,'source-export.json']);
  const check=relative=>{
    for(const entry of fs.readdirSync(path.join(output,relative),{withFileTypes:true})) {
      const name=relative ? `${relative}/${entry.name}` : entry.name;
      if(entry.isSymbolicLink()) throw new Error('Linked export path is not allowed: '+name);
      if(name==='.git' && (entry.isDirectory() || entry.isFile())) continue;
      if(entry.isDirectory()) check(name);
      else if(!entry.isFile() || !allowed.has(name)) throw new Error('Export target contains an unexpected file: '+name);
    }
  };
  check('');
}
fs.mkdirSync(output,{recursive:true});
for(const {name,bytes} of entries) {
  const target=path.join(output,name);
  let ancestor=target;
  while(ancestor.startsWith(output)) {
    if(fs.existsSync(ancestor) && fs.lstatSync(ancestor).isSymbolicLink()) throw new Error('Linked export path is not allowed.');
    const parent=path.dirname(ancestor);if(parent===ancestor) break;ancestor=parent;
  }
  fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);
}
fs.writeFileSync(path.join(output,'source-export.json'),JSON.stringify(entries.map(({name,bytes})=>({path:name,sha256:crypto.createHash('sha256').update(bytes).digest('hex')})),null,2)+'\n');
console.log(`Exported ${entries.length} reviewed source files to ${output}. Signing keys, game data, downloads and browser profiles are excluded.`);
