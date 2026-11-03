import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url)), output=path.join(dir,'release-source');
const install=fs.readFileSync(path.join(dir,'install.ps1'),'utf8').match(/\$files = @\(([\s\S]*?)\)/)?.[1];
if(!install) throw new Error('Installer allowlist is missing.');
const names=new Set([...install.matchAll(/'([^']+)'/g)].map(match=>match[1]));
for(const name of ['README.md','GAME_UPDATE.md','AI_MOD_INTEGRATION.md','RELEASING.md','USER_GUIDE.html','GUIDE.template.html','build-guide.mjs','build-user-guide.mjs','package.mjs','package.json','release.mjs','export-source.mjs','zip-tools.mjs','.gitignore','core.test.mjs','installer.test.mjs','zip-unicode.test.mjs','kio-api.test.mjs','game-compat.test.mjs','game-update.test.mjs','post-diagnostics.test.mjs','worker-notify.test.mjs','self-update-worker.test.mjs','examples-test.mjs','native-host.test.mjs','self-update.test.mjs','package.test.mjs','installer-tool-test.ps1']) names.add(name);
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
  if(fs.lstatSync(source).isSymbolicLink() || !fs.statSync(source).isFile()) throw new Error('Export requires a regular file: '+name);
  return {name,bytes:fs.readFileSync(source)};
});
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
