import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '../../test-output/wiki-pg/node_modules/@electric-sql/pglite/dist/index.js';
import {parseGameRequirement} from '../../game-compat.mjs';

const db = new PGlite();
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid
  $$;
  create function auth.role() returns text language sql stable as $$
    select nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role'
  $$;
`);
await db.exec(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));
for(const spec of ['*','faith','wayward','faith>=3.3.2','faith-3.3.2','>=faith-3.3.2',
  'faith>=1.0 faith<2.0','2026-11-01','>=2026-11-01-pre7','harbor>=1.2.3',
  'faith>=01.0','faith>=1.0 overtime>=1.0','2026-02-30','any','FAITH','wayward>=1.0']) {
  let valid=true;try {parseGameRequirement(spec);} catch {valid=false;}
  assert.equal((await db.query('select public.wiki_valid_game_spec($1) as value',[spec])).rows[0].value,valid,spec);
}
for(const [spec,valid,family] of [['faith-3.3.2 || faith-3.4.0',true,'faith'],
  ['2026-11-01 || 2026-11-04',true,'wayward'],['faith>=1.0 faith<2.0 || faith>=3.0 faith<4.0',true,'faith'],
  ['faith-3.3.2 || overtime-1.0.0',false],['faith-3.3.2 ||',false],['|| faith-3.3.2',false],
  ['faith-3.3.2 || || faith-3.4.0',false],['* || faith-3.4.0',false]]) {
  assert.equal((await db.query('select public.wiki_valid_game_spec($1) as value',[spec])).rows[0].value,valid,spec);
  if(valid) assert.equal((await db.query('select public.wiki_game_family($1) as value',[spec])).rows[0].value,family,spec);
}
const admin='00000000-0000-0000-0000-000000000001';
const stranger='00000000-0000-0000-0000-000000000002';
await db.query('insert into auth.users(id) values ($1),($2)',[admin,stranger]);
await db.query('insert into public.wiki_admins(user_id) values($1)',[admin]);
const role = async (name,id) => {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role:name,...(id?{sub:id}:{})})]);
  await db.exec(`set role ${name}`);
};
const call = async (name, args) => (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as value`,args)).rows[0].value;
const fails = async (fn,pattern) => { await assert.rejects(fn,pattern); };
const payload={mod_id:'example-mod',name:'Example',post_url:'https://kone.gg/s/space/abcdefghijklmnopqrstuv',wml_versions:['0.9.5'],game_spec:'faith>=3.3.2',description:'Example mod',category:'utility',version:'1.2.3',api_version:'2'};

await role('anon');
assert.deepEqual((await db.query('select * from public.wiki_mods')).rows,[]);
await fails(()=>db.query('select * from public.wiki_submissions'),/permission denied/i);
await fails(()=>call('wiki_is_admin',[]),/permission denied/i);
await fails(()=>call('wiki_create_submission',[payload,'create','detected','server_verified',true,'b'.repeat(64),'a'.repeat(64)]),/permission denied/i);
await role('authenticated',stranger);
assert.equal(await call('wiki_is_admin',[]),false);
assert.deepEqual((await db.query('select * from public.wiki_submissions')).rows,[]);
await fails(()=>call('wiki_review',['00000000-0000-0000-0000-000000000001',1,'approved',null]),/WIKI_ADMIN_REQUIRED/);
await fails(()=>call('wiki_mark_manual_review',['00000000-0000-0000-0000-000000000001',1,'proof']),/WIKI_ADMIN_REQUIRED/);
await fails(()=>call('wiki_set_trusted_source',[payload.mod_id,payload.post_url,payload.version,'b'.repeat(64),'proof']),/WIKI_ADMIN_REQUIRED/);
await fails(()=>call('wiki_set_verification',['00000000-0000-0000-0000-000000000001',1,'server_verified',true,'b'.repeat(64)]),/permission denied/i);

await role('service_role');
const rate='a'.repeat(64);
for(let n=0;n<5;n++) assert.equal(await call('wiki_reserve_quota',[rate]),true);
await fails(()=>call('wiki_reserve_quota',[rate]),/WIKI_RATE_LIMIT/);
await fails(()=>call('wiki_create_submission',[{...payload,wml_versions:[],game_spec:''},'create','manual','manual_review',false,null,rate]),/WIKI_INVALID_FIELDS/);
await fails(()=>call('wiki_create_submission',[{...payload,version:'01.2.3'},'create','manual','manual_review',false,null,rate]),/WIKI_INVALID_FIELDS/);
await fails(()=>call('wiki_create_submission',[{...payload,wml_versions:['0.09.5']},'create','manual','manual_review',false,null,rate]),/WIKI_INVALID_WML/);
await fails(()=>call('wiki_create_submission',[{...payload,game_family:'wayward'},'create','manual','manual_review',false,null,rate]),/WIKI_GAME_FAMILY_CHANGED/);
for(const game_spec of ['faith>=01.0','faith>=1.0 overtime>=1.0','2026-02-30','any','FAITH'])
  await fails(()=>call('wiki_create_submission',[{...payload,game_spec},'create','manual','manual_review',false,null,rate]),/WIKI_INVALID_FIELDS/);
const wmlOnly=await call('wiki_create_submission',[{...payload,mod_id:'wml-only',game_spec:''},'create','manual','manual_review',false,null,rate]);
assert.equal(wmlOnly.status,'pending');
const gameOnly=await call('wiki_create_submission',[{...payload,mod_id:'game-only',wml_versions:[]},'create','manual','manual_review',false,null,rate]);
assert.equal(gameOnly.status,'pending');
await fails(()=>call('wiki_create_submission',[{...payload,post_url:'https://evil.example/x'},'create','detected','server_verified',true,'b'.repeat(64),rate]),/WIKI_INVALID_POST_URL/);
await fails(()=>call('wiki_create_submission',[payload,'create','detected','server_verified',true,null,rate]),/WIKI_INVALID_SUBMISSION/);
await fails(()=>call('wiki_create_submission',[payload,'create','detected','manual_review',false,null,rate]),/WIKI_INVALID_SUBMISSION/);
const first=await call('wiki_create_submission',[payload,'create','detected','server_verified',true,'b'.repeat(64),rate]);
assert.equal(first.status,'pending');
await fails(()=>call('wiki_publish_submission',[first.id,first.revision,null,null]),/permission denied/i);
await fails(()=>call('wiki_create_submission',[payload,'create','detected','server_verified',true,'b'.repeat(64),rate]),/unique/i);
await fails(()=>call('wiki_auto_publish',[first.id]),/WIKI_AUTO_APPROVAL_DENIED/);
await role('anon');
assert.deepEqual((await db.query('select * from public.wiki_mods')).rows,[]);
await role('authenticated',admin);
assert.equal(await call('wiki_is_admin',[]),true);
await fails(()=>call('wiki_review',[wmlOnly.id,wmlOnly.revision,'approved','   ']),/WIKI_REVIEW_NOTE_REQUIRED/);
await fails(()=>call('wiki_mark_manual_review',[wmlOnly.id,wmlOnly.revision,'']),/WIKI_REVIEW_NOTE_REQUIRED/);
const manuallyChecked=await call('wiki_mark_manual_review',[wmlOnly.id,wmlOnly.revision,'직접 ZIP과 게시글 확인']);
assert.equal(manuallyChecked.verification,'manual_review');
assert.equal(manuallyChecked.api_verified,false);
assert.equal((await call('wiki_review',[wmlOnly.id,manuallyChecked.revision,'approved','직접 확인 완료'])).status,'approved');
await call('wiki_set_trusted_source',[payload.mod_id,'https://kone.gg/s/space/zyxwvutsrqponmlkjihgfe',payload.version,'b'.repeat(64),'reviewed']);
await role('service_role');
await fails(()=>call('wiki_auto_publish',[first.id]),/WIKI_AUTO_APPROVAL_DENIED/);
await role('authenticated',admin);
await call('wiki_set_trusted_source',[payload.mod_id,payload.post_url,'1.2.2','b'.repeat(64),'reviewed different version']);
await role('service_role');
await fails(()=>call('wiki_auto_publish',[first.id]),/WIKI_AUTO_APPROVAL_DENIED/);
await role('authenticated',admin);
await call('wiki_set_trusted_source',[payload.mod_id,payload.post_url,payload.version,'c'.repeat(64),'different file hash']);
await role('service_role');
await fails(()=>call('wiki_auto_publish',[first.id]),/WIKI_AUTO_APPROVAL_DENIED/);
await role('authenticated',admin);
await call('wiki_set_trusted_source',[payload.mod_id,payload.post_url,payload.version,'b'.repeat(64),'verified ownership and updater API']);
assert.equal((await db.query('select status from public.wiki_submissions where id=$1',[first.id])).rows[0].status,'approved');
await role('service_role');
await fails(()=>call('wiki_auto_publish',[first.id]),/WIKI_SUBMISSION_CLOSED/);
await role('authenticated',admin);
await call('wiki_set_trusted_source',['manual-mod',payload.post_url,payload.version,'b'.repeat(64),'verified source','faith']);
await role('service_role');
const manual=await call('wiki_create_submission',[{...payload,mod_id:'manual-mod'},'create','manual','server_verified',true,'b'.repeat(64),rate]);
await fails(()=>call('wiki_auto_publish',[manual.id]),/WIKI_AUTO_APPROVAL_DENIED/);
await role('authenticated',admin);
await call('wiki_set_trusted_source',['manual-mod',payload.post_url,payload.version,'b'.repeat(64),'verified source again','faith']);
assert.equal((await db.query('select status from public.wiki_submissions where id=$1',[manual.id])).rows[0].status,'pending');
await role('service_role');
const editedCandidate=await call('wiki_create_submission',[{...payload,mod_id:'edit-candidate'},'create','detected','server_verified',true,'b'.repeat(64),rate]);
await role('authenticated',admin);
const changedCandidate=await call('wiki_edit_submission',[editedCandidate.id,editedCandidate.revision,{...payload,mod_id:'edit-candidate',description:'admin edited'}]);
assert.equal(changedCandidate.source,'manual');
await call('wiki_set_trusted_source',['edit-candidate',payload.post_url,payload.version,'b'.repeat(64),'verified exact package']);
assert.equal((await db.query('select status from public.wiki_submissions where id=$1',[editedCandidate.id])).rows[0].status,'pending');
await role('anon');
assert.ok((await db.query('select mod_id from public.wiki_mods')).rows.some(row=>row.mod_id===payload.mod_id));

await role('service_role');
const rev=await call('wiki_create_submission',[{...payload,description:'new description'},'revision','manual','server_verified',true,'b'.repeat(64),rate]);
await role('authenticated',admin);
const edited=await call('wiki_edit_mod',[payload.mod_id,1,{...payload,description:'admin update'}]);
assert.equal(edited.revision,2);
assert.equal(edited.package_sha256,'b'.repeat(64));
const editedCritical=await call('wiki_edit_mod',[payload.mod_id,2,{...payload,post_url:'https://kone.gg/s/space/zyxwvutsrqponmlkjihgfe'}]);
assert.equal(editedCritical.package_sha256,null);
await fails(()=>call('wiki_edit_mod',[payload.mod_id,1,payload]),/WIKI_REVISION_CONFLICT/);
await fails(()=>call('wiki_review',[rev.id,rev.revision,'approved',null]),/WIKI_REVISION_CONFLICT/);
const editedProposal=await call('wiki_edit_submission',[rev.id,rev.revision,{...payload,post_url:'https://kone.gg/s/space/zyxwvutsrqponmlkjihgfe'}]);
assert.equal(editedProposal.verification,'unverified');
assert.equal(editedProposal.api_verified,false);
await fails(()=>call('wiki_review',[rev.id,editedProposal.revision,'approved',null]),/WIKI_DIAGNOSTICS_REQUIRED/);
assert.equal((await call('wiki_review',[rev.id,editedProposal.revision,'rejected','review required'])).status,'rejected');
assert.ok((await db.query('select * from public.wiki_audit_log')).rows.length>=4);

await role('service_role');
const variants = [];
for (const game_spec of ['', 'overtime>=1.0', '*']) {
  const submission = await call('wiki_create_submission',[{...payload,game_spec},'create','manual','manual_review',false,null,rate]);
  variants.push({game_spec, ...submission});
}
await fails(()=>call('wiki_create_submission',[{...payload,game_spec:''},'create','manual','manual_review',false,null,rate]),/unique/i);
await role('authenticated',admin);
await fails(()=>call('wiki_edit_mod',[payload.mod_id,3,payload]),/WIKI_AMBIGUOUS_MOD/);
for (const item of variants) {
  await fails(()=>call('wiki_edit_submission',[item.id,item.revision,{...payload,game_spec:'faith>=3.3.2'}]),/WIKI_GAME_FAMILY_CHANGED/);
  await call('wiki_review',[item.id,item.revision,'approved','verified manually']);
}
const editedWayward=await call('wiki_edit_mod',[payload.mod_id,1,{...payload,game_spec:'',description:'Wayward only'},'wayward']);
assert.equal(editedWayward.game_family,'wayward');
assert.equal(editedWayward.description,'Wayward only');
await fails(()=>call('wiki_edit_mod',[payload.mod_id,2,{...payload,game_spec:'overtime>=1.0'},'wayward']),/WIKI_GAME_FAMILY_CHANGED/);
await call('wiki_set_trusted_source',[payload.mod_id,payload.post_url,payload.version,'d'.repeat(64),'overtime only','overtime']);
assert.equal((await db.query('select count(*)::int as n from public.wiki_trusted_sources where mod_id=$1',[payload.mod_id])).rows[0].n,2);
const auditFamilies=(await db.query('select distinct game_family from public.wiki_audit_log where mod_id=$1',[payload.mod_id])).rows.map(row=>row.game_family);
assert.ok(['faith','wayward','overtime','any'].every(value=>auditFamilies.includes(value)));
await role('anon');
const publishedVariants=(await db.query('select game_family,description from public.wiki_mods where mod_id=$1',[payload.mod_id])).rows;
assert.equal(publishedVariants.length,4);
assert.notEqual(publishedVariants.find(row=>row.game_family==='faith').description,'Wayward only');
await fails(()=>call('wiki_edit_mod',[payload.mod_id,2,payload,'wayward']),/permission denied/i);
await role('authenticated',stranger);
assert.deepEqual((await db.query('select * from public.wiki_audit_log')).rows,[]);
await db.exec('reset role');
await db.exec(`insert into public.wiki_submissions(mod_id,game_family,name,post_url,wml_versions,game_spec,description,category,version,kind,source,verification)
  select 'queue-'||n,'wayward','Queue','https://kone.gg/s/space/abcdefghijklmnopqrstuv',array['0.9.5'],'','Queue','utility','1.0.0','create','manual','manual_review'
  from generate_series(1,500) n`);
await role('service_role');
await fails(()=>call('wiki_create_submission',[{...payload,mod_id:'one-more'},'create','manual','manual_review',false,null,rate]),/WIKI_QUEUE_FULL/);
await db.close();
console.log('Wiki schema: RLS, server-only verification, quotas, exact trusted source, edits and revision conflicts passed.');
