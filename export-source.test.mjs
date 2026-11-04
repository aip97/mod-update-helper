import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const source=path.dirname(fileURLToPath(import.meta.url));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'wml-source-export-'));
const copy=name=>{
  const target=path.join(temp,name);
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.cpSync(path.join(source,name),target,{recursive:true});
};
const run=(...args)=>spawnSync(process.execPath,[path.join(temp,'export-source.mjs'),...args],{encoding:'utf8'});
try {
  for(const entry of fs.readdirSync(source,{withFileTypes:true})) {
    if(entry.isFile() && (entry.name==='.gitignore' || /\.(?:m?js|json|html|md|ps1|cmd|css)$/.test(entry.name))) copy(entry.name);
  }
  const allowlist=fs.readFileSync(path.join(source,'install.ps1'),'utf8').match(/\$files = @\(([\s\S]*?)\)/)?.[1];
  assert.ok(allowlist);
  for(const match of allowlist.matchAll(/'([^']+)'/g)) if(!fs.existsSync(path.join(temp,match[1]))) copy(match[1]);
  for(const name of ['examples','skills','docs/screenshots','wiki/supabase','wiki-server']) copy(name);
  for(const name of ['README.md','admin.py','client.py','config.json','test_client.py','WML-Wiki-Admin.spec']) copy(`wiki-admin/${name}`);
  for(const name of ['wiki-admin/.env','wiki-admin/dist/secret.exe','wiki-server/password.txt']) {
    const target=path.join(temp,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,'SECRET_FIXTURE');
  }
  let result=run();assert.equal(result.status,0,result.stderr);
  const output=path.join(temp,'release-source');
  const manifest=JSON.parse(fs.readFileSync(path.join(output,'source-export.json'),'utf8')).map(row=>row.path);
  for(const name of ['browser-test-deps.mjs','browser-test.mjs','bulk-browser-test.mjs','consent-browser-test.mjs','game-update-browser-test.mjs','wiki-browser-test.mjs','wiki/supabase/schema.sql','wiki/supabase/schema.test.mjs','wiki/supabase/game-family-migration.sql','wiki/supabase/schema-v1.fixture.sql','wiki/supabase/migration.test.mjs','wiki-server/index.mjs','wiki-server/verify.mjs','wiki-server/verify-when-approved.mjs','wiki-admin/admin.py','wiki-admin/client.py','wiki-admin/config.json','wiki-admin/WML-Wiki-Admin.spec']) assert.ok(manifest.includes(name),name);
  for(const name of ['wiki-admin/.env','wiki-admin/dist/secret.exe','wiki-server/password.txt','wiki-server/wiki-submit.bundle.js']) assert.ok(!fs.existsSync(path.join(output,name)),name);
  fs.mkdirSync(path.join(temp,'candidates','clean'),{recursive:true});
  result=run('--output','candidates/clean');assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temp,'candidates/clean/source-export.json'),'utf8')).map(row=>row.path),manifest);
  result=run('--output','candidates/clean');assert.notEqual(result.status,0);assert.match(result.stderr,/must be empty/);
  for(const target of ['../outside',path.resolve(temp,'outside'),'candidates/../outside','C:\\outside','/outside']) {
    result=run('--output',target);assert.notEqual(result.status,0);assert.match(result.stderr,/project-relative/);
  }
  fs.mkdirSync(path.join(output,'.git'));fs.writeFileSync(path.join(output,'.git','HEAD'),'fixture');
  result=run();assert.equal(result.status,0,result.stderr);
  const install=path.join(temp,'install.ps1'),installText=fs.readFileSync(install,'utf8');
  fs.writeFileSync(install,installText.replace('$files = @(',"$files = @('../outside',"));
  result=run();assert.notEqual(result.status,0);assert.match(result.stderr,/outside the project/);
  fs.writeFileSync(install,installText);
  const readme=path.join(output,'README.md'),before=fs.readFileSync(readme,'utf8');
  fs.writeFileSync(path.join(temp,'README.md'),'must not overwrite after stale-file detection');
  const unexpected=path.join(output,'wiki-admin','private.txt');fs.writeFileSync(unexpected,'preserve me');
  result=run();assert.notEqual(result.status,0);assert.match(result.stderr,/unexpected file: wiki-admin\/private\.txt/);
  assert.equal(fs.readFileSync(readme,'utf8'),before);assert.equal(fs.readFileSync(unexpected,'utf8'),'preserve me');
  console.log('Source export: wiki allowlist, generated and secret exclusions, and stale-file refusal passed.');
} finally {fs.rmSync(temp,{recursive:true,force:true});}
